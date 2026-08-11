// =============================================================================
// Host-side command approval for ws_run_command (Phase 4.1).
// =============================================================================
// Implements the `CommandApprovalGate` port. The model only ever proposes a
// command; this is where it actually runs — and only after the user has seen it
// verbatim and said yes. Terminal is the one always-ask tool (no "always allow"),
// because a model that can run arbitrary shell is a model that can `rm -rf`.
//
// CAPTURING OUTPUT. VSCode's shell integration lets us run a command in the
// integrated terminal and read back its output deterministically:
// `terminal.shellIntegration.executeCommand(line)` returns a `ShellExecutionTask`
// whose `.read()` resolves to the captured stdout/stderr once the command exits.
// We cap the captured text to the model's character budget (a `npm test` can
// emit hundreds of KB) so a noisy command can't evict the conversation.
//
// WHY THE INTEGRATED TERMINAL AND NOT child_process. The plan (HANDOFF 4.1) asks
// for "shell-integration output capture" specifically: the user sees the command
// run in a real terminal they recognise, can interrupt it, and gets the same
// environment (shell rc files, PATH, cwd) the rest of their workflow uses.
// Running via child_process would be invisible and environment-detached.
//
// No domain logic here that isn't already tested elsewhere; the gate is the
// VSCode surface, which is what makes it `vscode`-bound by necessity.
// =============================================================================

import * as vscode from 'vscode'

import { truncateForModel, type PendingCommand } from '../tools/types.ts'
import { MAX_RESULT_CHARS } from '../tools/types.ts'

export interface CommandGateResult {
  /** Captured output to return to the model, or null if the user rejected. */
  output: string | null
}

/**
 * Build the command approval gate. Returns the captured output (budgeted), or
 * null when the user declined to run it.
 */
export function makeCommandGate(): (pending: PendingCommand) => Promise<string | null> {
  return async (pending: PendingCommand): Promise<string | null> => {
    const choice = await vscode.window.showInformationMessage(
      `Yellowscript wants to run:\n\n  ${pending.command}\n\nin ${pending.label}. It will only run if you approve.`,
      { modal: true },
      'Run',
      'Cancel',
    )
    if (choice !== 'Run') return null

    let terminal: vscode.Terminal
    try {
      terminal = vscode.window.createTerminal({
        name: 'Yellowscript',
        cwd: vscode.Uri.file(pending.cwd),
        isTransient: true,
      })
      terminal.show(true)

      const shell = terminal.shellIntegration
      if (!shell) {
        // Shell integration unavailable (rare, old shell). Fall back to a plain
        // send — we can't reliably capture output this way, so we tell the model
        // we ran it but couldn't read the result.
        terminal.sendText(pending.command, true)
        void vscode.window.showWarningMessage(
          'Shell integration is off, so Yellowscript could not capture the command output.',
        )
        return '[Command sent to the terminal, but output could not be captured (shell integration disabled).]'
      }

      const task = shell.executeCommand(pending.command)
      const stream = await task.read()
      let captured = ''
      for await (const chunk of stream) {
        captured += chunk
      }
      const { text, truncated } = truncateForModel(captured, MAX_RESULT_CHARS)
      return truncated
        ? `${text}\n\n[output truncated — ${captured.length - text.length} more characters omitted]`
        : text
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      void vscode.window.showErrorMessage(`Command failed: ${reason}`)
      return `[Command failed: ${reason}]`
    } finally {
      // A transient terminal is disposed automatically when its shell exits; this
      // is a belt-and-braces cleanup in case it didn't.
      setTimeout(() => {
        try {
          terminal.dispose()
        } catch {
          // already gone
        }
      }, 5000)
    }
  }
}
