// =============================================================================
// The coding benchmark's harness: run one task with the real agent loop.
// =============================================================================
// "More capable" is a claim this measures. Each task is a small workspace, a
// prompt, and a check script. The harness copies the workspace to a temp dir,
// runs Yellowscript's own agent loop against a real Nest with the real tools,
// then runs the check and records what happened.
//
// The agent is the product's own (agent/compose.ts composeSession, the same
// ChatSession, workspace message, run log and loop the editor runs). Only
// what composeSession leaves to its host is headless here:
//
//   gates          no person, so a fixed policy: writes are applied (still
//                  through the tools' containment), commands run (inside the
//                  temp workspace), reads outside it are refused
//   questions      ask_user gets the task's scripted answers; the turn limit
//                  is answered "stop" (the bench measures one allowance)
//   diagnostics    headless-diagnostics.ts: the TypeScript language service,
//                  or svelte-check in a Svelte project, as after each write in
//                  the editor
//   tools          the local ys_* tools, plus Nest's when the runner passes
//                  them, cut to the catalog under test (--catalog)
//
// This is a benchmark of the model and the agent, not of the approval UI.
//
// Commands the model proposes really run on this machine, in the temp copy.
// Run the bench where that is acceptable.
//
// No `vscode` import: this runs under plain Node (`npm run bench`).
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { STAGNATION_OFF, withHostTools, type AgentResult, type CompletionStreamer } from '../agent/loop.ts'
import { ContextTracker, estimateTokens, type ContextSource } from '../agent/context-budget.ts'
import type { AskAnswer } from '../agent/agent-core.ts'
import { composeSession, type AgentSetup } from '../agent/compose.ts'
import type { ChatSession } from '../chat/session.ts'
import type { AnswerView, HostMessage } from '../chat/protocol.ts'
import type { NestClient } from '../nest/client.ts'
import { createToolRegistry, mergeNestTools, type NestToolRef, type ToolRegistry } from '../tools/registry.ts'
import { BackgroundProcesses, startInBackground } from '../tools/background-processes.ts'
import { formatCommandRun, runCommandLine, runFailed } from '../tools/command-run.ts'
import { findBrowser } from '../browser/cdp.ts'
import type { PendingWrite } from '../tools/types.ts'
import { classifyCommand } from '../tools/safe-commands.ts'
import { nodeCommandContext } from '../tools/command-context.ts'
import { createTsSymbolProvider } from './ts-symbols.ts'
import { createHeadlessDiagnostics } from './headless-diagnostics.ts'

/**
 * The tool catalogs the bench can run (agent-runtime plan item 5): is the
 * whole Nest + Yellowscript catalog too much for a smaller model?
 *
 *   full        every local tool, and Nest's when the runner passes them
 *   core        read, write, edit, grep, run a command, diagnostics
 *   core+nest   the core set and Nest's tools
 *
 * ask_user and update_plan come with every catalog: the loop answers them.
 */
export type Catalog = 'full' | 'core' | 'core+nest'
export const CATALOGS: readonly Catalog[] = ['full', 'core', 'core+nest']
export const CORE_TOOLS: readonly string[] = ['ys_read_file', 'ys_write_file', 'ys_replace', 'ys_grep', 'ys_run_command', 'ys_diagnostics']

/** One task, as `bench/tasks/<id>/task.json` describes it. */
export interface BenchTask {
  id: string
  title: string
  prompt: string
  /** Round trips before the run is stopped (the bench never "continues"). */
  maxTurns?: number
  /** Wall-clock limit for the whole run. */
  timeoutS?: number
  /** Tools left out of this task's run (names), e.g. to measure what one saves. */
  withholdTools?: string[]
  /** Later messages, each sent after the previous run ends, with that run's
   *  log on its answer as the chat sends it (chat/run-log.ts). One marked
   *  newSession starts a fresh conversation in the same workspace: only what
   *  is on disk (the notes, the plan) carries over. */
  followUps?: Array<string | { prompt: string; newSession?: boolean }>
  /** Answers given to ask_user, in order; past the end, the question is dismissed. */
  answers?: AskAnswer[]
  /** A node_modules prepared once by `npm run bench:cache` (bench/.cache/<name>),
   *  copied into the run's workspace so it installs nothing from the network. */
  nodeModules?: string
  tags?: string[]
  /** Absolute path of the task's folder (set by loadTasks). */
  dir: string
}

export interface RunRecord {
  task: string
  label: string
  model: string | null
  pass: boolean
  /** What the check printed (its reason). */
  check: string
  stopReason: AgentResult['stopReason'] | 'timeout' | 'error'
  iterations: number
  toolCalls: number
  toolErrors: number
  /** Calls whose arguments were not valid JSON and could not be repaired. */
  invalidArgs: number
  /** Calls whose malformed arguments the registry repaired and ran. */
  repairedArgs: number
  /** Calls recovered from the model's text, not tool_calls. */
  recovered: number
  /** Calls refused as identical repeats. */
  repeats: number
  /** Calls to a tool that does not exist (a name from another harness, a typo). */
  wrongTool?: number
  /** Stagnation recoveries (agent-core stagnation.mjs), by level: note, refusal, stop. */
  recoveries?: { notes: number; refusals: number; stops: number; detectors: string[] }
  /** The catalog the run had, and what its tool list costs on each request. */
  catalog?: Catalog
  tools?: number
  toolListTokens?: number
  /** Which checker gave the diagnostics, or 'off'. */
  diagnostics?: 'typescript' | 'svelte-check' | 'off'
  /** Commands that would have asked the person (tier C, safe-commands.ts):
   *  the bench approves everything, so this is how the friction shows. */
  commandPrompts: number
  /** Context trims during the run. */
  trims: number
  /** Prompt tokens the model read across every request (prompt_n + cache_n). */
  promptTokens?: number
  questions: number
  nCtx: number | null
  durationMs: number
  /** The final answer, cut to 2,000 characters. */
  answer: string
  error?: string
}

/** Every task under `root` (folders holding a task.json), sorted by id. */
export function loadTasks(root: string): BenchTask[] {
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'task.json')))
    .map((d) => {
      const dir = path.join(root, d.name)
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8')) as Omit<BenchTask, 'dir' | 'id'> & { id?: string }
      if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) throw new Error(`${d.name}/task.json has no prompt`)
      if (!fs.existsSync(path.join(dir, 'check.mjs'))) throw new Error(`${d.name} has no check.mjs`)
      return { ...raw, id: raw.id ?? d.name, title: raw.title ?? d.name, dir }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** Apply an approved change to disk: the headless stand-in for the diff review. */
export function applyPendingWrite(pending: PendingWrite): void {
  for (const change of pending.changes) {
    if (change.isDeleted) {
      fs.rmSync(change.absolutePath, { force: true })
    } else {
      fs.mkdirSync(path.dirname(change.absolutePath), { recursive: true })
      fs.writeFileSync(change.absolutePath, change.after, 'utf8')
    }
  }
}

/** Run the task's check.mjs: exit 0 passes; its output is the reason. */
export function runCheck(task: BenchTask, workspace: string, resultFile: string): { pass: boolean; output: string } {
  // Not inherited: under a test runner it makes a child `node --test` pass.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const run = spawnSync(process.execPath, [path.join(task.dir, 'check.mjs'), workspace, resultFile], {
    encoding: 'utf8',
    // Crestline's check runs svelte-check, vitest and a build.
    timeout: 600_000,
    windowsHide: true,
    env,
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().slice(0, 2_000)
  return { pass: run.status === 0, output: output || (run.status === 0 ? 'passed' : `check exited ${run.status ?? run.signal}`) }
}

export interface RunTaskOptions {
  client: CompletionStreamer
  /** What the context tracker reads n_ctx from; absent: no trimming. */
  contextSource?: ContextSource
  label: string
  /** Keep the temp workspace for inspection. */
  keep?: boolean
  /** One line per event, for the console. */
  log?: (line: string) => void
  /** Tools to leave out, on top of the task's own withholdTools. */
  withhold?: string[]
  /** The tool catalog under test (default full). */
  catalog?: Catalog
  /** Nest's tools, for the full and core+nest catalogs (the runner lists them). */
  nestTools?: readonly NestToolRef[]
  /** Diagnostics after each write and for ys_diagnostics (default on). */
  diagnostics?: boolean
  /** The stagnation checks (default on); off keeps only the exact-repeat guard. */
  stagnation?: boolean
}

/** The tools a run gets: the catalog's, less what the task and the runner withhold. */
export function benchTools(
  base: Omit<Parameters<typeof createToolRegistry>[0], 'withhold'>,
  options: { catalog?: Catalog; withhold?: readonly string[]; nestTools?: readonly NestToolRef[] },
): ToolRegistry {
  const catalog = options.catalog ?? 'full'
  const all = createToolRegistry(base).names
  const outsideCore = catalog === 'core' || catalog === 'core+nest' ? all.filter((n) => !CORE_TOOLS.includes(n)) : []
  const local = createToolRegistry({ ...base, withhold: [...outsideCore, ...(options.withhold ?? [])] })
  const nest = catalog === 'core' ? [] : (options.nestTools ?? []).filter((t) => !options.withhold?.includes(t.name))
  return nest.length ? mergeNestTools(local, nest) : local
}

/** The tool list as the model receives it, in tokens (the chars/3 estimate). */
export function toolListTokens(tools: ToolRegistry): number {
  const payload = withHostTools(tools.payload(), { ask: { user: async () => null }, plan: { get: () => null, save: () => {} } })
  return estimateTokens(JSON.stringify(payload))
}

/** Run one task end to end and score it. Never throws: a failure is a record. */
export async function runTask(task: BenchTask, options: RunTaskOptions): Promise<RunRecord & { workspace: string }> {
  const log = options.log ?? (() => {})
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `ys-bench-${task.id}-`)))
  const source = path.join(task.dir, 'workspace')
  if (fs.existsSync(source)) fs.cpSync(source, workspace, { recursive: true })
  const modules = task.nodeModules ? copyNodeModules(task.nodeModules, workspace) : null
  if (modules) log(`  node_modules: ${modules}`)

  const processes = new BackgroundProcesses()
  const tracker = options.contextSource ? new ContextTracker(options.contextSource) : undefined
  const diagnostics = options.diagnostics === false ? null : createHeadlessDiagnostics(workspace)
  const tools = benchTools(
    {
      ripgrepPath: null,
      diagnostics: () => diagnostics?.records() ?? [],
      editorState: () => ({ activeFile: null, languageId: null, isDirty: false, cursor: null, selection: null, openFiles: [] }),
      processes,
      browser: { browser: () => findBrowser(), screenshotDir: () => path.join(workspace, '.yellowscript', 'screenshots') },
      symbols: createTsSymbolProvider(workspace),
    },
    { catalog: options.catalog ?? 'full', withhold: [...(task.withholdTools ?? []), ...(options.withhold ?? [])], ...(options.nestTools ? { nestTools: options.nestTools } : {}) },
  )

  const prompts = [{ prompt: task.prompt, newSession: true }, ...(task.followUps ?? []).map((f) => (typeof f === 'string' ? { prompt: f, newSession: false } : { newSession: false, ...f }))]
  const answers = [...(task.answers ?? [])]
  let trims = 0
  let questions = 0
  const started = Date.now()
  const controller = new AbortController()

  const record: RunRecord = {
    task: task.id, label: options.label, model: null, pass: false, check: '', stopReason: 'error',
    iterations: 0, toolCalls: 0, toolErrors: 0, invalidArgs: 0, repairedArgs: 0, recovered: 0, repeats: 0, commandPrompts: 0, trims: 0,
    questions: 0, nCtx: null, durationMs: 0, answer: '',
    catalog: options.catalog ?? 'full', tools: tools.names.length, toolListTokens: toolListTokens(tools),
    diagnostics: diagnostics ? diagnostics.checker : 'off',
  }

  // Every request's prompt size, summed: what a tool saves in reading.
  let promptTokens = 0
  const counting: CompletionStreamer = {
    async streamChatCompletion(request, handlers, signal) {
      const result = await options.client.streamChatCompletion(request, handlers, signal)
      promptTokens += (result.timings?.prompt_n ?? 0) + (result.timings?.cache_n ?? 0)
      return result
    },
  }
  /** Each file's content before the task first wrote it, for "this run changed the scripts". */
  const before = new Map<string, string>()

  // The product's agent, with a headless host.
  const setup: AgentSetup = {
    // The session only streams completions; the bench's client is that much of a NestClient.
    client: () => counting as unknown as NestClient,
    onUnauthorized: () => {},
    workspace: { roots: () => [workspace], readRoots: () => [], allowReadRoot: async () => {} },
    tools: () => tools,
    project: () => null,
    processes,
    gates: {
      change: () => async (pending) => {
        for (const c of pending.changes) if (!before.has(c.absolutePath.toLowerCase())) before.set(c.absolutePath.toLowerCase(), c.before)
        applyPendingWrite(pending)
        return true
      },
      command: () => async (pending) => {
        const tier = classifyCommand(pending.command, nodeCommandContext({
          cwd: pending.cwd,
          roots: [workspace],
          builtInSafe: true,
          projectChecks: true,
          background: pending.background === true,
          packageJsonBeforeRun: (file) => before.get(file.toLowerCase()) ?? null,
        }))
        if (tier.tier === 'C') {
          record.commandPrompts++
          log(`  would ask: ${pending.command} (${tier.reason})`)
        }
        if (pending.background) return startInBackground(processes, pending.command, pending.cwd)
        const run = await runCommandLine({ command: pending.command, cwd: pending.cwd, ...(pending.timeoutMs ? { timeoutMs: pending.timeoutMs } : {}), signal: controller.signal })
        return { text: formatCommandRun(run), isError: runFailed(run), exitCode: run.exitCode }
      },
    },
    ...(diagnostics ? { diagnosticsAfterWrite: (files: string[]) => diagnostics.afterWrite(files) } : {}),
    maxTurns: () => task.maxTurns ?? 40,
    ...(options.stagnation === false ? { stagnation: () => STAGNATION_OFF } : {}),
    log: { info: (line) => log(`  ${line}`), warn: (line) => log(`  ${line}`) },
  }

  /** Every message's run, in order: the check can look at one message's calls. */
  const runs: AgentResult[] = []
  let failure: string | null = null
  let session: ChatSession | null = null
  let conversation = 0
  /** Answer what the session waits on, as the person would: the bench's policy. */
  const onEmit = (message: HostMessage) => {
    if (message.type === 'tool/call') log(`  call ${message.name}${message.recovered ? ' [recovered]' : ''} ${message.arguments.slice(0, 120)}`)
    else if (message.type === 'turn/notice') log(`  ${message.text}`)
    else if (message.type === 'turn/failed') failure = message.message
    else if (message.type === 'conversationState') {
      const state = message.state
      const current = session
      if (!current) return
      // Deferred: the session is still inside the call that emitted this.
      if (state.question) {
        const id = state.question.id
        questions++
        const answer = (answers.shift() ?? null) as AnswerView | null
        queueMicrotask(() => current.answer(id, answer))
      } else if (state.approval) {
        // Only a read outside the workspace or of a secrets file asks here: refused.
        const { id, options: choices } = state.approval
        const deny = choices.find((o) => o.kind === 'deny')?.id ?? 'deny'
        log(`  refused: ${state.approval.title} ${state.approval.subject}`)
        queueMicrotask(() => current.approve(id, deny))
      } else if (state.atTurnLimit) {
        queueMicrotask(() => current.continueAtLimit(false))
      }
    }
  }
  const newSession = () => {
    session = composeSession(setup, `bench-${task.id}-${++conversation}`, {
      emit: onEmit,
      onPersist: () => {},
      context: () => tracker ?? null,
      onAgentResult: (result) => runs.push(result),
      onContextTrimmed: (report) => {
        trims++
        log(`  context trimmed ~${report.before} → ~${report.after} of ${report.usable}`)
      },
    })
    return session
  }
  const timer = setTimeout(() => {
    controller.abort()
    session?.abort()
  }, (task.timeoutS ?? 900) * 1000)

  let current: ChatSession = newSession()
  try {
    for (const [index, { prompt, newSession: fresh }] of prompts.entries()) {
      if (index > 0) {
        log(`  message ${index + 1}${fresh ? ' (new session)' : ''}: ${prompt.slice(0, 80)}`)
        if (fresh) current = newSession()
      }
      const ran = runs.length
      failure = null
      await current.send(prompt)
      const result = runs[ran]
      if (controller.signal.aborted) {
        record.stopReason = 'timeout'
        break
      }
      if (!result || failure) {
        record.stopReason = 'error'
        record.error = failure ?? 'the run produced no result'
        break
      }
      record.stopReason = result.stopReason
      if (record.stopReason !== 'complete') break
    }
  } catch (err) {
    record.stopReason = controller.signal.aborted ? 'timeout' : 'error'
    record.error = err instanceof Error ? err.message : String(err)
  } finally {
    clearTimeout(timer)
    processes.stopAll()
  }

  const result = runs.at(-1)
  const allRuns = runs.flatMap((r) => r.toolRuns)
  const plan = current.planSnapshot()
  if (result) {
    record.model = result.model ?? null
    record.iterations = runs.reduce((n, r) => n + r.iterations, 0)
    record.answer = result.content.slice(0, 2_000)
    for (const run of allRuns) {
      record.toolCalls++
      if (run.result.isError) record.toolErrors++
      if (run.recovered) record.recovered++
      if (/were not valid JSON/.test(run.result.content)) record.invalidArgs++
      if (run.result.argumentsRepaired?.length) record.repairedArgs++
      if (run.result.summary === 'Not run: repeated call') record.repeats++
    }
    record.wrongTool = allRuns.filter((r) => /no tool named "/.test(r.result.content)).length
    const recoveries = runs.flatMap((r) => r.recoveries)
    record.recoveries = {
      notes: recoveries.filter((r) => r.level === 1).length,
      refusals: recoveries.filter((r) => r.level === 2).length,
      stops: recoveries.filter((r) => r.level === 3).length,
      detectors: recoveries.map((r) => r.detector),
    }
  }
  record.trims = trims
  record.promptTokens = promptTokens
  record.questions = questions
  record.nCtx = tracker?.contextSize ?? null

  const resultFile = path.join(workspace, '.yellowscript', 'bench-result.json')
  fs.mkdirSync(path.dirname(resultFile), { recursive: true })
  // What the check can see besides the workspace: the answer, the plan, how the
  // run ended, how often it asked, and every call it made (name + arguments).
  fs.writeFileSync(
    resultFile,
    JSON.stringify(
      {
        answer: result?.content ?? '',
        plan,
        stopReason: record.stopReason,
        questions,
        calls: allRuns.map(callRecord),
        // One entry per message (the prompt and any follow-ups), with its own calls.
        messages: runs.map((r) => ({ calls: r.toolRuns.map(callRecord) })),
        recoveries: runs.flatMap((r) => r.recoveries.map((x) => ({ detector: x.detector, level: x.level, evidence: x.evidence }))),
      },
      null,
      2,
    ),
  )
  const check = runCheck(task, workspace, resultFile)
  record.pass = check.pass && record.stopReason !== 'error'
  record.check = check.output
  record.durationMs = Date.now() - started

  if (!options.keep) {
    // Give exited processes a moment to release their files.
    setTimeout(() => fs.rm(workspace, { recursive: true, force: true }, () => {}), 1_000).unref()
  }
  return { ...record, workspace }
}

/** Where `npm run bench:cache` keeps the prepared node_modules. */
export const BENCH_CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bench', '.cache')

/**
 * Copy a prepared node_modules into the workspace: the same packages every
 * run, and nothing from the network. A copy, not a link, so an install the
 * model runs changes only its own run. Null when the cache has not been
 * built: the run goes on, and an install inside it needs the network.
 */
export function copyNodeModules(name: string, workspace: string, cache = BENCH_CACHE): string | null {
  const prepared = path.join(cache, name, 'node_modules')
  if (!fs.existsSync(prepared)) return null
  fs.cpSync(prepared, path.join(workspace, 'node_modules'), { recursive: true, verbatimSymlinks: true })
  return prepared
}

/** A call as the check sees it. */
function callRecord(run: AgentResult['toolRuns'][number]): { name: string; args: string; isError: boolean } {
  return { name: run.call.function.name, args: run.call.function.arguments.slice(0, 500), isError: run.result.isError }
}

// ---------------------------------------------------------------------------
// The summary.
// ---------------------------------------------------------------------------

const pct = (n: number, d: number) => (d === 0 ? '–' : `${Math.round((n / d) * 100)}%`)

/** "2: same-failure, no-progress" — or "0". */
function recoveryCell(r: RunRecord): string {
  const n = r.recoveries ? r.recoveries.notes + r.recoveries.refusals + r.recoveries.stops : 0
  return n ? `${n}: ${r.recoveries!.detectors.join(', ')}` : '0'
}

/** The run's markdown summary, ending with the one row for the results log. */
export function summarize(records: readonly RunRecord[], label: string, date = new Date()): string {
  const passed = records.filter((r) => r.pass).length
  const calls = records.reduce((a, r) => a + r.toolCalls, 0)
  const errors = records.reduce((a, r) => a + r.toolErrors, 0)
  const invalid = records.reduce((a, r) => a + r.invalidArgs, 0)
  const repaired = records.reduce((a, r) => a + (r.repairedArgs ?? 0), 0)
  const prompts = records.reduce((a, r) => a + (r.commandPrompts ?? 0), 0)
  const recoveredCalls = records.reduce((a, r) => a + r.recovered, 0)
  const turns = records.reduce((a, r) => a + r.iterations, 0)
  const limits = records.filter((r) => r.stopReason === 'turn-cap' || r.stopReason === 'timeout').length
  const trimmed = records.filter((r) => r.trims > 0).length
  const models = [...new Set(records.map((r) => r.model).filter(Boolean))].join(', ') || 'unknown'
  const wrong = records.reduce((a, r) => a + (r.wrongTool ?? 0), 0)
  const stuck = records.filter((r) => r.stopReason === 'stuck').length
  const recovered = records.reduce((a, r) => a + (r.recoveries ? r.recoveries.notes + r.recoveries.refusals + r.recoveries.stops : 0), 0)
  const catalogs = [...new Set(records.map((r) => r.catalog).filter(Boolean))].join(', ') || 'full'
  const listTokens = [...new Set(records.map((r) => r.toolListTokens).filter((n) => n !== undefined))].join(', ') || '–'
  const nCtx = [...new Set(records.map((r) => r.nCtx).filter(Boolean))].join(', ') || 'unknown'

  const lines = [
    `# Yellowscript bench — ${label}`,
    '',
    `${date.toISOString().slice(0, 16).replace('T', ' ')} · model ${models} · n_ctx ${nCtx} · catalog ${catalogs} (tool list ~${listTokens} tokens per request)`,
    '',
    `**${passed}/${records.length} passed.**`,
    '',
    '| Task | Result | Stop | Turns | Calls | Errors | Wrong tool | Recoveries | Prompts | Trims | Prompt tokens | Time | Check |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...records.map((r) =>
      `| ${r.task} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.stopReason} | ${r.iterations} | ${r.toolCalls} | ${r.toolErrors} | ${r.wrongTool ?? 0} | ${recoveryCell(r)} | ${r.commandPrompts ?? 0} | ${r.trims} | ${r.promptTokens?.toLocaleString('en-US') ?? '–'} | ${(r.durationMs / 1000).toFixed(0)}s | ${r.check.split('\n')[0]!.replace(/\|/g, '\\|').slice(0, 80)} |`,
    ),
    '',
    'Row for docs/bench-results.md:',
    '',
    '| Date | Label | Model | Pass | Tool success | Invalid args | Repaired args | Recovered | Turns/task | Command prompts | Hit a limit | Trimmed | Wrong tool | Recoveries (stuck) | Catalog |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    `| ${date.toISOString().slice(0, 10)} | ${label} | ${models} | ${passed}/${records.length} (${pct(passed, records.length)}) | ${pct(calls - errors, calls)} | ${pct(invalid, calls)} | ${pct(repaired, calls)} | ${pct(recoveredCalls, calls)} | ${records.length ? (turns / records.length).toFixed(1) : '–'} | ${prompts} | ${limits} | ${trimmed} | ${pct(wrong, calls)} | ${recovered} (${stuck}) | ${catalogs} |`,
    '',
  ]
  return lines.join('\n')
}
