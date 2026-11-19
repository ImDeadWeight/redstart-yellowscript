// =============================================================================
// Host-side command approval for ys_run_command and ys_process_start.
// =============================================================================
// Implements the `CommandApprovalGate` port. The model only ever proposes a
// command; this is where it runs, and only after the person has seen it
// verbatim and said yes, or it matches a prefix they allowed for this
// workspace (`redstartYellowscript.allowedCommands`, see isCommandAllowed:
// a line that chains, pipes or redirects never matches).
//
// It runs through child_process (tools/process-runner.ts), with the user's
// shell and environment, so the model gets an exit code, both streams and a
// timeout. Output streams live into the "Yellowscript Commands" output
// channel, which is where the person watches it.
//
// A background command (ys_process_start) is started and left running; the
// model reads it with ys_process_output.
// =============================================================================

import * as vscode from 'vscode'

import { allowPrefixFor, isCommandAllowed } from '../tools/approval.ts'
import { formatCommandRun, runCommandLine, runFailed, type BackgroundProcesses } from '../tools/process-runner.ts'
import type { PendingCommand } from '../tools/types.ts'
import type { CommandOutcome } from '../agent/loop.ts'

const ALLOWED_KEY = 'allowedCommands'

/** The workspace's allowed command prefixes. */
function allowedCommands(): string[] {
  const value = vscode.workspace.getConfiguration('redstartYellowscript').get<string[]>(ALLOWED_KEY)
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []
}

async function allowCommand(prefix: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('redstartYellowscript')
  const next = [...new Set([...allowedCommands(), prefix])]
  await config.update(ALLOWED_KEY, next, vscode.ConfigurationTarget.Workspace)
}

export interface CommandGateDeps {
  /** Where command output is shown live. */
  channel: vscode.OutputChannel
  processes: BackgroundProcesses
}

/**
 * Build the command approval gate. Resolves to the outcome for the model, or
 * null when the person declined to run it.
 */
export function makeCommandGate(deps: CommandGateDeps): (pending: PendingCommand) => Promise<CommandOutcome | null> {
  return async (pending: PendingCommand): Promise<CommandOutcome | null> => {
    const allowedAlready = isCommandAllowed(pending.command, allowedCommands())
    if (!allowedAlready) {
      const prefix = allowPrefixFor(pending.command)
      const always = prefix ? `Always allow "${prefix}"` : undefined
      const what = pending.background ? 'start in the background' : 'run'
      const choice = await vscode.window.showInformationMessage(
        `Yellowscript wants to ${what}:\n\n  ${pending.command}\n\nin ${pending.label}. It will only run if you approve.`,
        { modal: true },
        'Run',
        ...(always ? [always] : []),
      )
      if (choice === undefined) return null
      if (always && choice === always && prefix) await allowCommand(prefix)
    }

    const channel = deps.channel
    channel.appendLine(`\n$ ${pending.command}    (${pending.label}${allowedAlready ? ', allowed' : ''})`)

    if (pending.background) {
      try {
        const started = deps.processes.start(pending.command, pending.cwd)
        // Give it a moment, so a command that fails at once says so now.
        const first = await deps.processes.output(started.id, { waitMs: 3_000 })
        const state = first?.process.running ? 'is running' : `exited at once with code ${first?.process.exitCode ?? 'none'}`
        const text = first?.text.trimEnd()
        return {
          text:
            `Started ${started.id}: ${pending.command} — it ${state}.\n` +
            (text ? `--- first output ---\n${text.slice(-4_000)}\n` : '(no output yet)\n') +
            `Read more with ys_process_output {"id":"${started.id}"}; end it with ys_process_stop.`,
          isError: first ? !first.process.running && first.process.exitCode !== 0 : false,
        }
      } catch (err) {
        return { text: `Could not start the command: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    }

    channel.show(true)
    const run = await runCommandLine({
      command: pending.command,
      cwd: pending.cwd,
      ...(pending.timeoutMs ? { timeoutMs: pending.timeoutMs } : {}),
      onOutput: (chunk) => channel.append(chunk),
    })
    const text = formatCommandRun(run)
    channel.appendLine(`[${text.split('\n')[0]}]`)
    return { text, isError: runFailed(run) }
  }
}
