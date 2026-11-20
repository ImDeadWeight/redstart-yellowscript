// =============================================================================
// Host-side command approval for ys_run_command and ys_process start.
// =============================================================================
// Implements the `CommandApprovalGate` port. The model only ever proposes a
// command; this is where it runs, and only after the person has seen it
// verbatim on the chat's approval card and said yes, or it matches a prefix they allowed for this
// workspace (`redstartYellowscript.allowedCommands`, see isCommandAllowed:
// a line that chains, pipes or redirects never matches).
//
// It runs through child_process (tools/process-runner.ts), with the user's
// shell and environment, so the model gets an exit code, both streams and a
// timeout. Output streams live into the "Yellowscript Commands" output
// channel, which is where the person watches it.
//
// A background command (ys_process start) is started and left running; the
// model reads it with ys_process output.
// =============================================================================

import * as vscode from 'vscode'

import { allowPrefixFor, isCommandAllowed } from '../tools/approval.ts'
import { formatCommandRun, runCommandLine, runFailed, startInBackground, type BackgroundProcesses } from '../tools/process-runner.ts'
import type { PendingCommand } from '../tools/types.ts'
import type { CommandOutcome } from '../agent/loop.ts'
import type { AskApproval } from '../chat/approvals.ts'
import type { CommandTier } from '../tools/safe-commands.ts'

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
  /** Ask on the conversation's approval card. */
  ask: AskApproval
  /** Which tier the line is in (safe-commands.ts); absent: everything asks. */
  classify?: (pending: PendingCommand) => CommandTier
}

/**
 * Build the command approval gate. Resolves to the outcome for the model, or
 * null when the person declined to run it.
 */
export function makeCommandGate(deps: CommandGateDeps): (pending: PendingCommand) => Promise<CommandOutcome | null> {
  return async (pending: PendingCommand): Promise<CommandOutcome | null> => {
    const tier = deps.classify?.(pending) ?? null
    // Tier A and B run without asking; the person's own prefixes come after,
    // except for a line that discards work, which asks every time.
    const safe = tier && tier.tier !== 'C' ? tier : null
    const neverAlways = tier?.tier === 'C' ? tier.neverAlways : undefined
    const allowedAlready = !safe && !neverAlways && isCommandAllowed(pending.command, allowedCommands())
    if (!safe && !allowedAlready) {
      const prefix = neverAlways ? null : allowPrefixFor(pending.command)
      const choice = await deps.ask({
        kind: 'command',
        title: pending.background ? 'Start a command in the background' : 'Run a command',
        subject: pending.command,
        detail: neverAlways ? `in ${pending.label}. Asked every time: ${neverAlways}.` : `in ${pending.label}`,
        options: [
          { id: 'run', label: pending.background ? 'Start' : 'Run', kind: 'allow' },
          ...(prefix ? [{ id: 'always', label: `Always allow "${prefix}"`, kind: 'always' as const }] : []),
          { id: 'deny', label: 'Deny', kind: 'deny' },
        ],
      })
      if (choice === 'deny') return null
      if (choice === 'always' && prefix) await allowCommand(prefix)
    }

    const channel = deps.channel
    const how = safe ? `, safe: ${safe.rule}` : allowedAlready ? ', allowed' : ''
    channel.appendLine(`\n$ ${pending.command}    (${pending.label}${how})`)
    const auto = safe ? { autoRule: safe.rule } : {}

    if (pending.background) {
      try {
        // Waits for its address or its exit, so the model is told which.
        return { ...(await startInBackground(deps.processes, pending.command, pending.cwd)), ...auto }
      } catch (err) {
        return { text: `Could not start the command: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    }

    channel.show(true)
    const run = await runCommandLine({
      // A hardened git line runs with Yellowscript's own settings added.
      command: safe?.run ?? pending.command,
      cwd: pending.cwd,
      ...(safe?.env ? { env: safe.env } : {}),
      ...(pending.timeoutMs ? { timeoutMs: pending.timeoutMs } : {}),
      onOutput: (chunk) => channel.append(chunk),
    })
    const text = formatCommandRun(run)
    channel.appendLine(`[${text.split('\n')[0]}]`)
    return { text, isError: runFailed(run), exitCode: run.exitCode, ...auto }
  }
}
