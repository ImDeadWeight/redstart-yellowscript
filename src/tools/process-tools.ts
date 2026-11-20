// =============================================================================
// ys_process — long-running commands, one tool with three actions.
// =============================================================================
// A dev server or a watcher never exits, so ys_run_command (which waits) is
// the wrong tool for it. `action: "start"` PLANS a background command: it goes
// through the same command approval as ys_run_command, and only the host's
// gate starts it. "output" and "stop" need no approval: they touch only
// processes this window started.
//
// One tool rather than three because every tool is paid for in the tool list
// on every request (PLAN-long-tasks.md item 0). Calls to the old
// ys_process_start / _output / _stop, from transcripts or a model that
// remembers them, are routed here by `legacyProcessCall`.
//
// No `vscode` import.
// =============================================================================

import { assertWorkspaceToolName, stringArg, toolError, toolOk, type PendingCommand, type Tool, type ToolContext, type ToolResult } from './types.ts'
import { PathScopeError, describeWorkspacePath, resolveWithinWorkspace } from './workspace-path.ts'
import { capHeadTail, type BackgroundProcesses } from './process-runner.ts'

/** What an "output" read shows of new output at most. */
export const OUTPUT_CAP_CHARS = 12_000

export const PROCESS_TOOL = 'ys_process'

const ACTIONS = ['start', 'output', 'stop'] as const
type Action = (typeof ACTIONS)[number]

const LEGACY: Record<string, Action> = {
  ys_process_start: 'start',
  ys_process_output: 'output',
  ys_process_stop: 'stop',
}

/**
 * A call to one of the three tools ys_process replaced, as a ys_process call.
 * Null for any other name.
 */
export function legacyProcessCall(name: string, args: unknown): { name: string; args: unknown } | null {
  const action = LEGACY[name.replace(/^ws_/, 'ys_')]
  if (!action) return null
  const base = typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {}
  return { name: PROCESS_TOOL, args: { ...base, action } }
}

/** True when a ys_process call (by its raw arguments) is a start. */
export function isProcessStart(rawArguments: string): boolean {
  return /"action"\s*:\s*"start"/.test(rawArguments)
}

function resolveCwd(context: ToolContext, requested: string | null): { ok: true; cwd: string } | { ok: false; error: ToolResult } {
  if (requested === null) return { ok: true, cwd: context.workspaceRoots[0]! }
  try {
    return { ok: true, cwd: resolveWithinWorkspace(context.workspaceRoots, requested) }
  } catch (err) {
    if (err instanceof PathScopeError) return { ok: false, error: toolError(`"${requested}" is outside the workspace; the command cannot run there.`) }
    return { ok: false, error: toolError(`Could not resolve "${requested}": ${err instanceof Error ? err.message : String(err)}`) }
  }
}

function planStart(args: unknown, context: ToolContext): ToolResult {
  if (context.workspaceRoots.length === 0) return toolError('No workspace folder is open, so there is nowhere to run a command.')
  const command = stringArg(args, 'command')?.trim()
  if (!command) return toolError('ys_process start requires a "command" string, e.g. {"action": "start", "command": "npm run dev"}.')
  const where = resolveCwd(context, stringArg(args, 'cwd'))
  if (!where.ok) return where.error
  const label = describeWorkspacePath(context.workspaceRoots, where.cwd)
  const pending: PendingCommand = { command, cwd: where.cwd, label, background: true }
  return toolOk(
    `Proposed background command (awaits your approval):\n\n  ${command}\n\nin ${label}. It will NOT start until you approve it.`,
    `ys_process start — ${command.slice(0, 60)} (pending approval)`,
    false,
    undefined,
    pending,
  )
}

async function readOutput(processes: BackgroundProcesses, args: unknown): Promise<ToolResult> {
  const id = stringArg(args, 'id')
  if (!id) return toolError('ys_process output requires an "id", e.g. {"action": "output", "id": "p1"}.')
  const waitS = Number((args as { wait_s?: unknown })?.wait_s ?? 0)
  const all = (args as { all?: unknown })?.all === true
  const read = await processes.output(id, { waitMs: Number.isFinite(waitS) ? waitS * 1000 : 0, all })
  if (!read) {
    const known = processes.list().map((p) => p.id).join(', ')
    return toolError(`There is no background process "${id}".${known ? ` Known: ${known}.` : ' None has been started.'}`)
  }
  const state = read.process.running ? 'running' : `exited with code ${read.process.exitCode ?? 'none'}`
  const missed = read.missed > 0 ? `\n[${read.missed.toLocaleString('en-US')} older characters were no longer kept]` : ''
  const text = read.text.trimEnd()
  return toolOk(
    `${id} (${read.process.command}) is ${state}.${missed}\n${text ? `--- output ---\n${capHeadTail(text, OUTPUT_CAP_CHARS)}` : '(no new output)'}`,
    `ys_process output — ${id} ${state}`,
  )
}

function stop(processes: BackgroundProcesses, args: unknown): ToolResult {
  const id = stringArg(args, 'id')
  if (!id) return toolError('ys_process stop requires an "id", e.g. {"action": "stop", "id": "p1"}.')
  const stopped = processes.stop(id)
  if (!stopped) return toolError(`There is no background process "${id}".`)
  const result = toolOk(
    stopped.running ? `Stopping ${id} (${stopped.command}).` : `${id} had already exited (code ${stopped.exitCode ?? 'none'}).`,
    `ys_process stop — ${id}`,
  )
  result.effect = { kind: 'stop', processId: id }
  return result
}

export function createProcessTool(processes: BackgroundProcesses): Tool {
  return {
    definition: {
      name: assertWorkspaceToolName(PROCESS_TOOL),
      description:
        'Background commands, such as a dev server. "start" proposes a command (approved first) and returns ' +
        'an id like p1; "output" reads what it printed since the last read; "stop" ends it and its children.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...ACTIONS] },
          command: { type: 'string', description: 'start: e.g. "npm run dev".' },
          cwd: { type: 'string', description: 'start: optional workspace directory.' },
          id: { type: 'string', description: 'output, stop: e.g. "p1".' },
          wait_s: { type: 'number', description: 'output: seconds to wait for new output (max 30).' },
          all: { type: 'boolean', description: 'output: all kept output, not only new.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
      const action = stringArg(args, 'action')
      if (action === 'start') return planStart(args, context)
      if (action === 'output') return readOutput(processes, args)
      if (action === 'stop') return stop(processes, args)
      return toolError(`ys_process requires "action": one of ${ACTIONS.map((a) => `"${a}"`).join(', ')}.`)
    },
  }
}
