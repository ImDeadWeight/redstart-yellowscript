// =============================================================================
// ys_process_start, ys_process_output, ys_process_stop — long-running commands.
// =============================================================================
// A dev server or a watcher never exits, so ys_run_command (which waits) is
// the wrong tool for it. ys_process_start PLANS a background command: it goes
// through the same command approval as ys_run_command, and only the host's
// gate starts it. Reading its output and stopping it need no approval: they
// touch only processes this window started.
//
// No `vscode` import.
// =============================================================================

import { assertWorkspaceToolName, stringArg, toolError, toolOk, type PendingCommand, type Tool, type ToolContext, type ToolResult } from './types.ts'
import { PathScopeError, describeWorkspacePath, resolveWithinWorkspace } from './workspace-path.ts'
import { capHeadTail, type BackgroundProcesses } from './process-runner.ts'

/** What ys_process_output shows of new output at most. */
export const OUTPUT_CAP_CHARS = 12_000

function resolveCwd(context: ToolContext, requested: string | null): { ok: true; cwd: string } | { ok: false; error: ToolResult } {
  if (requested === null) return { ok: true, cwd: context.workspaceRoots[0]! }
  try {
    return { ok: true, cwd: resolveWithinWorkspace(context.workspaceRoots, requested) }
  } catch (err) {
    if (err instanceof PathScopeError) return { ok: false, error: toolError(`"${requested}" is outside the workspace; the command cannot run there.`) }
    return { ok: false, error: toolError(`Could not resolve "${requested}": ${err instanceof Error ? err.message : String(err)}`) }
  }
}

export const processStartTool: Tool = {
  definition: {
    name: assertWorkspaceToolName('ys_process_start'),
    description:
      'Propose starting a long-running command in the background, such as a dev server ("npm run dev") ' +
      'or a watcher. Shown to the user and started only after approval. Returns a process id; read its ' +
      'output with ys_process_output and end it with ys_process_stop. For a command that finishes, use ys_run_command.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The exact command line, e.g. "npm run dev".' },
        cwd: { type: 'string', description: 'Optional workspace-relative directory. Omit for the workspace root.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    if (context.workspaceRoots.length === 0) return toolError('No workspace folder is open, so there is nowhere to run a command.')
    const command = stringArg(args, 'command')?.trim()
    if (!command) return toolError('ys_process_start requires a "command" string argument.')
    const where = resolveCwd(context, stringArg(args, 'cwd'))
    if (!where.ok) return where.error
    const label = describeWorkspacePath(context.workspaceRoots, where.cwd)
    const pending: PendingCommand = { command, cwd: where.cwd, label, background: true }
    return toolOk(
      `Proposed background command (awaits your approval):\n\n  ${command}\n\nin ${label}. It will NOT start until you approve it.`,
      `ys_process_start — ${command.slice(0, 60)} (pending approval)`,
      false,
      undefined,
      pending,
    )
  },
}

export function createProcessOutputTool(processes: BackgroundProcesses): Tool {
  return {
    definition: {
      name: assertWorkspaceToolName('ys_process_output'),
      description:
        'Read what a background process (from ys_process_start) has printed since you last read it, and ' +
        'whether it is still running. wait_s waits up to that many seconds (max 30) for output, e.g. for a ' +
        'server to come up.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The process id, e.g. "p1".' },
          wait_s: { type: 'number', description: 'Seconds to wait for new output (0–30). Default 0.' },
          all: { type: 'boolean', description: 'Return the whole kept output instead of only what is new.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    async execute(args: unknown): Promise<ToolResult> {
      const id = stringArg(args, 'id')
      if (!id) return toolError('ys_process_output requires an "id" argument.')
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
        `ys_process_output — ${id} ${state}`,
      )
    },
  }
}

export function createProcessStopTool(processes: BackgroundProcesses): Tool {
  return {
    definition: {
      name: assertWorkspaceToolName('ys_process_stop'),
      description: 'Stop a background process started with ys_process_start, and everything it started.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The process id, e.g. "p1".' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    async execute(args: unknown): Promise<ToolResult> {
      const id = stringArg(args, 'id')
      if (!id) return toolError('ys_process_stop requires an "id" argument.')
      const stopped = processes.stop(id)
      if (!stopped) return toolError(`There is no background process "${id}".`)
      return toolOk(
        stopped.running ? `Stopping ${id} (${stopped.command}).` : `${id} had already exited (code ${stopped.exitCode ?? 'none'}).`,
        `ys_process_stop — ${id}`,
      )
    },
  }
}
