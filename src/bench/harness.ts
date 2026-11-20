// =============================================================================
// The coding benchmark's harness: run one task with the real agent loop.
// =============================================================================
// "More capable" is a claim this measures. Each task is a small workspace, a
// prompt, and a check script. The harness copies the workspace to a temp dir,
// runs Yellowscript's own agent loop against a real Nest with the real tools,
// then runs the check and records what happened.
//
// The host is headless: there is no person, so the approval gates follow a
// fixed policy instead of asking. Writes are applied (still through the
// tools' containment), commands run (inside the temp workspace), ask_user
// gets the task's scripted answers. This is a benchmark of the model and the
// loop, not of the approval UI.
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

import { runAgentLoop, type AgentResult, type CompletionStreamer } from '../agent/loop.ts'
import { ContextTracker, type ContextSource, type FitReport } from '../agent/context-budget.ts'
import type { AskAnswer, AskRequest, PlanStep } from '../agent/agent-core.ts'
import type { ChatCompletionRequest } from '../nest/client.ts'
import { createToolRegistry } from '../tools/registry.ts'
import { BackgroundProcesses, formatCommandRun, runCommandLine, runFailed, startInBackground } from '../tools/process-runner.ts'
import { findBrowser } from '../tools/browser-check.ts'
import { buildWorkspaceContext } from '../tools/workspace-context.ts'
import type { PendingWrite, ToolEffect } from '../tools/types.ts'
import { formatRunLog } from '../chat/run-log.ts'

/** One task, as `bench/tasks/<id>/task.json` describes it. */
export interface BenchTask {
  id: string
  title: string
  prompt: string
  /** Round trips before the run is stopped (the bench never "continues"). */
  maxTurns?: number
  /** Wall-clock limit for the whole run. */
  timeoutS?: number
  /** Later messages, each sent after the previous run ends, with that run's
   *  log on its answer as the chat sends it (chat/run-log.ts). */
  followUps?: string[]
  /** Answers given to ask_user, in order; past the end, the question is dismissed. */
  answers?: AskAnswer[]
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
  /** Context trims during the run. */
  trims: number
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
    timeout: 120_000,
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
}

/** Run one task end to end and score it. Never throws: a failure is a record. */
export async function runTask(task: BenchTask, options: RunTaskOptions): Promise<RunRecord & { workspace: string }> {
  const log = options.log ?? (() => {})
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `ys-bench-${task.id}-`)))
  const source = path.join(task.dir, 'workspace')
  if (fs.existsSync(source)) fs.cpSync(source, workspace, { recursive: true })

  const processes = new BackgroundProcesses()
  const tracker = options.contextSource ? new ContextTracker(options.contextSource) : undefined
  const tools = createToolRegistry({
    ripgrepPath: null,
    diagnostics: () => [],
    editorState: () => ({ activeFile: null, languageId: null, isDirty: false, cursor: null, selection: null, openFiles: [] }),
    processes,
    browser: { browser: () => findBrowser(), screenshotDir: () => path.join(workspace, '.yellowscript', 'screenshots') },
  })

  const context = buildWorkspaceContext(workspace)
  const messages: ChatCompletionRequest['messages'] = context ? [{ role: 'system', content: context }] : []
  const prompts = [task.prompt, ...(task.followUps ?? [])]
  const answers = [...(task.answers ?? [])]
  let plan: PlanStep[] | null = null
  let trims = 0
  let questions = 0
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), (task.timeoutS ?? 900) * 1000)

  const record: RunRecord = {
    task: task.id, label: options.label, model: null, pass: false, check: '', stopReason: 'error',
    iterations: 0, toolCalls: 0, toolErrors: 0, invalidArgs: 0, repairedArgs: 0, recovered: 0, repeats: 0, trims: 0,
    questions: 0, nCtx: null, durationMs: 0, answer: '',
  }

  let result: AgentResult | undefined
  /** Every message's run, in order: the check can look at one message's calls. */
  const runs: AgentResult[] = []
  try {
    for (const [index, prompt] of prompts.entries()) {
      if (index > 0) log(`  message ${index + 1}: ${prompt.slice(0, 80)}`)
      messages.push({ role: 'user', content: prompt })
      result = await runAgentLoop({
        client: options.client,
        request: { messages: [...messages] },
        tools,
        toolContext: { workspaceRoots: [workspace] },
        signal: controller.signal,
        maxIterations: task.maxTurns ?? 40,
        context: tracker,
        approveChange: async (pending) => {
          applyPendingWrite(pending)
          return true
        },
        approveCommand: async (pending) => {
          if (pending.background) return startInBackground(processes, pending.command, pending.cwd)
          const run = await runCommandLine({ command: pending.command, cwd: pending.cwd, ...(pending.timeoutMs ? { timeoutMs: pending.timeoutMs } : {}), signal: controller.signal })
          return { text: formatCommandRun(run), isError: runFailed(run), exitCode: run.exitCode }
        },
        ask: {
          user: async (_request: AskRequest) => {
            questions++
            return answers.shift() ?? null
          },
        },
        plan: { get: () => plan, save: (steps) => void (plan = steps.map((s) => ({ ...s }))) },
        // The bench measures one allowance of turns; it never says "keep going".
        askContinue: async () => false,
        handlers: {
          onToolCall: (call, recovered) => log(`  call ${call.function.name}${recovered ? ' [recovered]' : ''} ${call.function.arguments.slice(0, 120)}`),
          onContextTrimmed: (report: FitReport) => {
            trims++
            log(`  context trimmed ~${report.before} → ~${report.after} of ${report.usable}`)
          },
        },
      })
      runs.push(result)
      record.stopReason = controller.signal.aborted ? 'timeout' : result.stopReason
      if (record.stopReason !== 'complete') break
      // The answer, then what the run did: what the chat sends on the next message.
      const effects = result.toolRuns.map((r) => r.result.effect).filter((e): e is ToolEffect => e !== undefined)
      const runLog = formatRunLog(effects)
      messages.push({ role: 'assistant', content: [result.content, runLog].filter(Boolean).join('\n\n') })
    }
  } catch (err) {
    record.stopReason = controller.signal.aborted ? 'timeout' : 'error'
    record.error = err instanceof Error ? err.message : String(err)
  } finally {
    clearTimeout(timer)
    processes.stopAll()
  }

  const allRuns = runs.flatMap((r) => r.toolRuns)
  if (result) {
    record.model = result.model ?? null
    record.iterations = runs.reduce((n, r) => n + r.iterations, 0) || result.iterations
    record.answer = result.content.slice(0, 2_000)
    for (const run of allRuns) {
      record.toolCalls++
      if (run.result.isError) record.toolErrors++
      if (run.recovered) record.recovered++
      if (/were not valid JSON/.test(run.result.content)) record.invalidArgs++
      if (run.result.argumentsRepaired?.length) record.repairedArgs++
      if (run.result.summary === 'Not run: repeated call') record.repeats++
    }
  }
  record.trims = trims
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

/** A call as the check sees it. */
function callRecord(run: AgentResult['toolRuns'][number]): { name: string; args: string; isError: boolean } {
  return { name: run.call.function.name, args: run.call.function.arguments.slice(0, 500), isError: run.result.isError }
}

// ---------------------------------------------------------------------------
// The summary.
// ---------------------------------------------------------------------------

const pct = (n: number, d: number) => (d === 0 ? '–' : `${Math.round((n / d) * 100)}%`)

/** The run's markdown summary, ending with the one row for the results log. */
export function summarize(records: readonly RunRecord[], label: string, date = new Date()): string {
  const passed = records.filter((r) => r.pass).length
  const calls = records.reduce((a, r) => a + r.toolCalls, 0)
  const errors = records.reduce((a, r) => a + r.toolErrors, 0)
  const invalid = records.reduce((a, r) => a + r.invalidArgs, 0)
  const repaired = records.reduce((a, r) => a + (r.repairedArgs ?? 0), 0)
  const recovered = records.reduce((a, r) => a + r.recovered, 0)
  const turns = records.reduce((a, r) => a + r.iterations, 0)
  const limits = records.filter((r) => r.stopReason === 'turn-cap' || r.stopReason === 'timeout').length
  const trimmed = records.filter((r) => r.trims > 0).length
  const models = [...new Set(records.map((r) => r.model).filter(Boolean))].join(', ') || 'unknown'
  const nCtx = [...new Set(records.map((r) => r.nCtx).filter(Boolean))].join(', ') || 'unknown'

  const lines = [
    `# Yellowscript bench — ${label}`,
    '',
    `${date.toISOString().slice(0, 16).replace('T', ' ')} · model ${models} · n_ctx ${nCtx}`,
    '',
    `**${passed}/${records.length} passed.**`,
    '',
    '| Task | Result | Stop | Turns | Calls | Errors | Trims | Time | Check |',
    '|---|---|---|---|---|---|---|---|---|',
    ...records.map((r) =>
      `| ${r.task} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.stopReason} | ${r.iterations} | ${r.toolCalls} | ${r.toolErrors} | ${r.trims} | ${(r.durationMs / 1000).toFixed(0)}s | ${r.check.split('\n')[0]!.replace(/\|/g, '\\|').slice(0, 80)} |`,
    ),
    '',
    'Row for docs/bench-results.md:',
    '',
    '| Date | Label | Model | Pass | Tool success | Invalid args | Repaired args | Recovered | Turns/task | Hit a limit | Trimmed |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    `| ${date.toISOString().slice(0, 10)} | ${label} | ${models} | ${passed}/${records.length} (${pct(passed, records.length)}) | ${pct(calls - errors, calls)} | ${pct(invalid, calls)} | ${pct(repaired, calls)} | ${pct(recovered, calls)} | ${records.length ? (turns / records.length).toFixed(1) : '–'} | ${limits} | ${trimmed} |`,
    '',
  ]
  return lines.join('\n')
}
