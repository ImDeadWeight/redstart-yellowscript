// =============================================================================
// Applying an approved PendingWrite to disk — the ONLY place bytes move.
// =============================================================================
// Phase 3. The write tools only PLAN; this module is where an approved change
// becomes real. It is deliberately tiny and `vscode`-free: it takes a
// `WriteBackend` (the real fs, injected by the host) and the already-validated
// `FileChangePreview[]` from a tool result, and writes/deletes each file. The
// checkpoint the user can revert to was taken by the host BEFORE calling this.
//
// The content written here is exactly `FileChangePreview.after` — the same
// string the diff engine produced from the model's diff. There is no second
// interpretation: what was reviewed is what is written. That identity is what
// makes "review before disk" trustworthy.
//
// No `vscode` import.
// =============================================================================

import type { PendingWrite } from './types.ts'

/** The filesystem operations needed to materialise a change. Injected so this
 *  module is testable against an in-memory backend. */
export interface WriteBackend {
  /** Create parent directories as needed (inside the workspace). */
  mkdirp(absolutePath: string): Promise<void>
  /** Write `content` to `absolutePath`, creating or replacing the file. */
  write(absolutePath: string, content: string): Promise<void>
  /** Delete the file at `absolutePath`. */
  remove(absolutePath: string): Promise<void>
}

export interface ApplyOutcome {
  written: number
  deleted: number
  /** Absolute paths that could not be written, with the reason. */
  failures: { path: string; reason: string }[]
}

/** Apply every change in `pending`. Stops at nothing on a single failure — it
 *  reports each and continues, so a permissions error on one file does not leave
 *  the rest of an approved batch unwritten. */
export async function applyPendingWrite(
  pending: PendingWrite,
  backend: WriteBackend,
): Promise<ApplyOutcome> {
  const outcome: ApplyOutcome = { written: 0, deleted: 0, failures: [] }

  for (const change of pending.changes) {
    try {
      if (change.isDeleted) {
        await backend.remove(change.absolutePath)
        outcome.deleted++
      } else {
        await backend.mkdirp(change.absolutePath)
        await backend.write(change.absolutePath, change.after)
        outcome.written++
      }
    } catch (err) {
      outcome.failures.push({
        path: change.path,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return outcome
}
