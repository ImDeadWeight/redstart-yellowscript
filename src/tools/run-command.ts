// =============================================================================
// ys_run_command — run a shell command, always-ask.
// =============================================================================
// Phase 4.1. The model proposes a command; the host shows it VERBATIM and runs
// it only on the user's go-ahead. Terminal is the one tool that is never
// auto-approved — a model that can run arbitrary shell is a model that can
// `rm -rf`, so the default is "ask every time", and there is no "always allow"
// for it (intentionally; see HANDOFF 4.1 and the safety model in section E).
//
// THE TOOL ONLY PLANS. Like the write tools, it returns a `PendingCommand` and
// never spawns a process itself. The agent loop routes that through the host's
// `approveCommand` gate, which shows the command, waits for confirmation, runs
// it in the integrated terminal with shell integration, and feeds the captured
// output back to the model. A rejected command returns "not run" — the model is
// never told it executed something it didn't.
//
// CWD CONTAINMENT. A command's working directory is resolved against the
// workspace and proven to stay inside it; an absolute path outside every
// folder is refused. This is softer than file-path containment (shell commands
// legitimately read anywhere via absolute paths they type), but we will not LET
// the model SILENTLY pivot the working directory out of the workspace — if it
// wants to run somewhere else it has to say so and be told no.
//
// No `vscode` import: it takes the cwd resolution through the same
// `resolveWithinWorkspace` guard everything else uses, so the planning is
// testable with a string store.
// =============================================================================

import {
  assertWorkspaceToolName,
  stringArg,
  toolError,
  toolOk,
  type PendingCommand,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './types.ts'
import { PathScopeError, resolveWithinWorkspace, describeWorkspacePath } from './workspace-path.ts'

export const runCommandTool: Tool = {
  definition: {
    name: assertWorkspaceToolName('ys_run_command'),
    description:
      'Propose a shell command for a build, test, lint or git. The user sees it verbatim and approves ' +
      'it first. It waits for the command to finish; the result starts with the exit code. For a server ' +
      'or watcher that never exits, use ys_process.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'e.g. "npm test".',
        },
        cwd: {
          type: 'string',
          description: 'Optional workspace directory; default the root.',
        },
        timeout_s: {
          type: 'number',
          description: 'Default 120, max 900.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    if (context.workspaceRoots.length === 0) {
      return toolError('No workspace folder is open, so there is nowhere to run a command.')
    }

    const command = stringArg(args, 'command')
    if (command === null || command.trim() === '') {
      return toolError('ys_run_command requires a "command" string argument.')
    }

    // Resolve and contain the working directory. Absent → first workspace root.
    let cwd: string
    const requestedCwd = stringArg(args, 'cwd')
    if (requestedCwd === null) {
      cwd = context.workspaceRoots[0]!
    } else {
      try {
        cwd = resolveWithinWorkspace(context.workspaceRoots, requestedCwd)
      } catch (err) {
        if (err instanceof PathScopeError) {
          return toolError(`"${requestedCwd}" is outside the workspace; the command cannot run there.`)
        }
        return toolError(
          `Could not resolve working directory "${requestedCwd}": ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    const label = describeWorkspacePath(context.workspaceRoots, cwd)
    const trimmed = command.trim()

    // A command that only says something back is not work. A model with no way
    // to end its turn (or to ask) has been seen spinning through dozens of
    // them; refusing with what to do instead breaks that, and saves a prompt.
    if (isNoOpCommand(trimmed)) {
      return toolError(
        `Not run: \`${trimmed}\` does nothing but print text you wrote, so it cannot tell you anything. ` +
          'If you are finished, reply to the user without calling a tool. To ask the user something, call ask_user. ' +
          'To inspect the environment, run a command that reads it.',
        'ys_run_command — refused: does nothing',
      )
    }
    const pending: PendingCommand = { command: trimmed, cwd, label }
    const timeoutS = Number((args as { timeout_s?: unknown })?.timeout_s)
    if (Number.isFinite(timeoutS) && timeoutS > 0) pending.timeoutMs = Math.round(timeoutS * 1000)

    return toolOk(
      `Proposed command (awaits your approval):\n\n  ${trimmed}\n\n` +
        `in ${label}. It will NOT run until you approve it.`,
      `ys_run_command — ${trimmed.split('\n')[0]?.slice(0, 60) ?? trimmed} (pending approval)`,
      false,
      undefined,
      pending,
    )
  },
}

/**
 * A line that does nothing a model could learn from: `echo` of literal text
 * (no variable to expand, no redirect or pipe), `exit`, `true`/`false`, `:`,
 * `rem`, `cls`/`clear`. `echo $PATH` and `echo hi > file` are real work.
 */
export function isNoOpCommand(command: string): boolean {
  const line = command.trim()
  if (/^(exit|true|false|:|rem|cls|clear|pause)(\s+\S*)?$/i.test(line)) return true
  const echo = /^(echo|printf|write-host|write-output)(\s|$)(.*)$/i.exec(line)
  if (!echo) return false
  const rest = echo[3] ?? ''
  // Expands something, or sends the text somewhere: not a no-op.
  return !/[$%`|<>&;]|\$\(/.test(rest)
}
