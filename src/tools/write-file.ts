// =============================================================================
// ws_write_file and ws_edit_file — the Phase 3 write tools.
// =============================================================================
// These compute a proposed change and RETURN it for approval; they never write
// to disk themselves. HANDOFF 3.1/3.2: "never applied directly — always
// through diff review." The host renders a native diff editor and the user's
// Apply click is the only thing that turns a PendingWrite into bytes.
//
// DIVISION OF LABOUR:
//
//   ws_write_file   — full new content for a file. Used for new files and for
//                     total rewrites. Token-heavy for a one-line fix, which is
//                     exactly why ws_edit_file exists for the common case.
//   ws_edit_file    — a unified diff (the git shape the model knows), applied
//                     against the current file. Chosen over search/replace blocks
//                     because the model already emits valid unified diffs and a
//                     diff reviews cleanly in VSCode's own diff editor.
//
// Both go through `planFileChanges` (the containment-checked diff applier), so
// "review before disk" costs nothing extra: the same engine that previews also
// defines what Apply will write. A diff whose context no longer matches the file
// is rejected as a result the model can read and correct — no partial write, no
// surprise bytes.
//
// No `vscode` import: they take filesystem access through an injected `WriteFs`
// (read-only) so the planning logic is testable with a string store. The actual
// write happens in the host's apply step (see the agent loop's approval gate),
// which is where `vscode` and the real fs live.
// =============================================================================

import * as fs from 'node:fs'

import {
  assertWorkspaceToolName,
  stringArg,
  toolError,
  toolOk,
  type FileChangePreview,
  type PendingWrite,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './types.ts'
import { describeWorkspacePath, resolveWithinWorkspace } from './workspace-path.ts'
import { planFileChanges, parseUnifiedDiff, type FileChange } from './diff-apply.ts'

/** Filesystem operations a write tool needs. Read-only: planning never writes.
 *  Injected so the planning logic is testable with a string store. */
export interface WriteFs {
  /** True when `absolutePath` currently holds a file. */
  exists(absolutePath: string): boolean
  /** Read the current content of an existing file. */
  read(absolutePath: string): string
}

/** The real filesystem, read-only. The write happens only in the host's apply
 *  step (after approval), never inside a tool. */
export const nodeWriteFs: WriteFs = {
  exists: (p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  },
  read: (p) => fs.readFileSync(p, 'utf8'),
}

/** Build a single-file preview (with a unified-diff string) from a FileChange. */
function previewOf(change: FileChange, roots: readonly string[]): FileChangePreview {
  const label = describeWorkspacePath(roots, change.absolutePath)
  return {
    path: label,
    absolutePath: change.absolutePath,
    isNew: change.isNew,
    isDeleted: change.isDeleted,
    before: change.before,
    after: change.after,
    diff: unifiedDiffFor(change, label),
  }
}

/** A compact unified diff of one change, for the review UI. */
function unifiedDiffFor(change: FileChange, label: string): string {
  const header = change.isNew
    ? `--- /dev/null\n+++ ${label}`
    : change.isDeleted
      ? `--- ${label}\n+++ /dev/null`
      : `--- ${label}\n+++ ${label}`
  // Line-by-line diff is intentionally simple: context-free add/remove of the
  // whole file. The native diff editor shows the real per-line difference; this
  // string is only the card's at-a-glance summary.
  const lines: string[] = [header]
  if (!change.isNew) for (const l of change.before.split('\n')) lines.push(`-${l}`)
  if (!change.isDeleted) for (const l of change.after.split('\n')) lines.push(`+${l}`)
  return lines.join('\n')
}

function summariseChanges(changes: readonly FileChangePreview[]): string {
  const created = changes.filter((c) => c.isNew).length
  const edited = changes.filter((c) => !c.isNew && !c.isDeleted).length
  const deleted = changes.filter((c) => c.isDeleted).length
  const parts: string[] = []
  if (created) parts.push(`${created} created`)
  if (edited) parts.push(`${edited} edited`)
  if (deleted) parts.push(`${deleted} deleted`)
  return parts.length ? parts.join(', ') : 'no changes'
}

// ---------------------------------------------------------------------------
// ws_edit_file — a unified diff against the current file.
// ---------------------------------------------------------------------------

export function createEditFileTool(fs: WriteFs): Tool {
  return {
    definition: {
      name: assertWorkspaceToolName('ws_edit_file'),
      description:
        'Propose an edit to a workspace file as a unified diff (the same format `git diff` produces: ' +
        'lines starting with " " for context, "-" for removed, "+" for added, with "@@ -a,b +c,d @@" ' +
        'hunk headers). The change is previewed for review and applied only after approval — it is NOT ' +
        'written immediately. The diff must match the file\'s CURRENT content; if the file changed since ' +
        'you read it, re-read it first. Provide a `diff` string with one or more files.',
      inputSchema: {
        type: 'object',
        properties: {
          diff: {
            type: 'string',
            description:
              'A unified diff. For multiple files, separate them with a `diff --git a/… b/…` line or ' +
              'repeat the `---`/`+++` headers. Paths are workspace-relative.',
          },
        },
        required: ['diff'],
        additionalProperties: false,
      },
    },

    async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
      if (context.workspaceRoots.length === 0) {
        return toolError('No workspace folder is open, so there is nothing to edit.')
      }
      const diffText = stringArg(args, 'diff')
      if (diffText === null || diffText.trim() === '') {
        return toolError('ws_edit_file requires a "diff" string argument (a unified diff).')
      }

      const parsed = parseUnifiedDiff(diffText)
      if (parsed.files.length === 0) {
        return toolError('The diff was empty or malformed — no file changes could be parsed.')
      }

      const result = planFileChanges(
        parsed,
        (rel) => resolveWithinWorkspace(context.workspaceRoots, rel),
        (abs) => fs.exists(abs),
        (abs) => fs.read(abs),
      )

      if (result.changes.length === 0) {
        const reasons = result.errors.map((e) => `  ${e.path}: ${e.reason}`).join('\n')
        return toolError(
          `None of the edits could be applied (the diff does not match the current files):\n${reasons}`,
        )
      }

      const previews = result.changes.map((c) => previewOf(c, context.workspaceRoots))
      // If some files failed but others are valid, we still surface the valid
      // ones for review; the model is told which were rejected so it can fix them.
      const failureNote =
        result.errors.length > 0
          ? `\n\nThese were rejected and NOT included:\n${result.errors
              .map((e) => `  ${e.path}: ${e.reason}`)
              .join('\n')}`
          : ''

      const pending: PendingWrite = {
        label: summariseChanges(previews),
        changes: previews,
      }

      const body =
        `Proposed edit (pending review): ${summariseChanges(previews)}.\n` +
        previews
          .map((p) => `${p.isNew ? 'CREATE' : p.isDeleted ? 'DELETE' : 'EDIT'} ${p.path}`)
          .join('\n') +
        failureNote +
        `\n\nThe changes are staged for your review. They will be written only after you approve the diff.`

      return toolOk(
        body,
        `ws_edit_file — ${summariseChanges(previews)} (pending approval)`,
        false,
        pending,
      )
    },
  }
}

// ---------------------------------------------------------------------------
// ws_write_file — full new content for a file.
// ---------------------------------------------------------------------------

export function createWriteFileTool(fs: WriteFs): Tool {
  return {
    definition: {
      name: assertWorkspaceToolName('ws_write_file'),
      description:
        'Propose writing a complete file. Provide the full new content — for changing part of an existing ' +
        'file, prefer ws_edit_file with a diff. The write is previewed and applied only after approval. ' +
        'New files are created; existing files are replaced entirely. Paths are workspace-relative.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path, e.g. "src/index.ts".' },
          content: { type: 'string', description: 'The complete new content of the file.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },

    async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
      if (context.workspaceRoots.length === 0) {
        return toolError('No workspace folder is open, so there is nothing to write.')
      }
      const requested = stringArg(args, 'path')
      if (requested === null) return toolError('ws_write_file requires a "path" argument.')
      const content = stringArg(args, 'content')
      if (content === null) return toolError('ws_write_file requires a "content" argument.')

      let absolute: string
      try {
        absolute = resolveWithinWorkspace(context.workspaceRoots, requested)
      } catch (err) {
        if (err instanceof Error && err.message.includes('outside')) {
          return toolError(`"${requested}" is outside the workspace.`)
        }
        return toolError(
          `Could not resolve "${requested}": ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      const isNew = !fs.exists(absolute)
      const before = isNew ? '' : fs.read(absolute)

      const change: FileChange = {
        relativePath: requested,
        absolutePath: absolute,
        isNew,
        isDeleted: false,
        before,
        after: content,
      }
      const previews = [previewOf(change, context.workspaceRoots)]
      const pending: PendingWrite = { label: summariseChanges(previews), changes: previews }

      const body =
        `Proposed write (pending review): ${isNew ? 'CREATE' : 'REPLACE'} ` +
        `${describeWorkspacePath(context.workspaceRoots, absolute)}.\n` +
        `The file is staged for your review and will be written only after you approve the diff.`

      return toolOk(
        body,
        `ws_write_file — ${isNew ? 'create' : 'replace'} (pending approval)`,
        false,
        pending,
      )
    },
  }
}
