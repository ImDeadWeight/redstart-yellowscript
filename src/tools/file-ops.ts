// =============================================================================
// ys_replace, ys_delete_file, ys_move_file — edits a quantized model can make.
// =============================================================================
// ys_edit_file takes a unified diff whose context must match the file exactly.
// Local models get the line counts and context wrong often enough that a
// multi-file build stalls on it. ys_replace asks for something they get right:
// the exact text to find (once) and the text to put there.
//
// Delete and move exist so a model can reorganise a project without writing a
// file's content back out through ys_write_file.
//
// Like the other write tools these only PLAN: each returns a PendingWrite that
// goes through the same diff review and shadow checkpoint before any byte
// moves. A delete is never auto-approved (see write-approval.ts).
//
// No `vscode` import: filesystem reads go through the injected WriteFs.
// =============================================================================

import {
  assertWorkspaceToolName,
  stringArg,
  toolError,
  toolOk,
  type PendingWrite,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './types.ts'
import { PathScopeError, describeWorkspacePath, resolveWithinWorkspace } from './workspace-path.ts'
import { previewOf, summariseChanges, type WriteFs } from './write-file.ts'
import type { FileChange } from './diff-apply.ts'
import { noteSeen, seenState } from './read-ledger.ts'
import { closestText, looseReplace, showLine } from './replace-match.ts'

/** Resolve a workspace path for a write tool, or a model-readable error. */
function resolveTarget(
  context: ToolContext,
  requested: string,
): { ok: true; absolute: string } | { ok: false; error: ToolResult } {
  try {
    return { ok: true, absolute: resolveWithinWorkspace(context.workspaceRoots, requested) }
  } catch (err) {
    if (err instanceof PathScopeError && err.reason === 'escapes-workspace') {
      return { ok: false, error: toolError(`"${requested}" is outside the workspace.`) }
    }
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, error: toolError(`Could not resolve "${requested}": ${reason}`) }
  }
}

/** Every start index of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = []
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) found.push(i)
  return found
}

/** The 1-based line a character offset falls on. */
function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/**
 * The text as the file has it, when `wanted` differs only in line endings.
 * Models write \n; a Windows checkout often holds \r\n.
 */
function matchLineEndings(file: string, wanted: string): string {
  if (!file.includes('\r\n') || wanted.includes('\r\n')) return wanted
  return wanted.replace(/\n/g, '\r\n')
}

export function createReplaceTool(fs: WriteFs): Tool {
  return {
    definition: {
      name: assertWorkspaceToolName('ys_replace'),
      description:
        'Propose replacing exact text in a file. old_string must match exactly, indentation included, ' +
        'and only once unless replace_all; add surrounding lines to make it unique. Read the file first. ' +
        'Applied after review.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path.' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
        },
        required: ['path', 'old_string', 'new_string'],
        additionalProperties: false,
      },
    },

    async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
      if (context.workspaceRoots.length === 0) return toolError('No workspace folder is open, so there is nothing to edit.')
      const requested = stringArg(args, 'path')
      const oldRaw = stringArg(args, 'old_string')
      const newRaw = stringArg(args, 'new_string')
      if (requested === null) return toolError('ys_replace requires a "path" argument.')
      if (oldRaw === null || oldRaw === '') return toolError('ys_replace requires a non-empty "old_string".')
      if (newRaw === null) return toolError('ys_replace requires a "new_string" argument (it may be empty).')
      const replaceAll = (args as { replace_all?: unknown })?.replace_all === true

      const target = resolveTarget(context, requested)
      if (!target.ok) return target.error
      if (!fs.exists(target.absolute)) {
        return toolError(`"${requested}" does not exist. Use ys_write_file to create a new file.`)
      }

      const before = fs.read(target.absolute)
      const oldString = matchLineEndings(before, oldRaw)
      const newString = matchLineEndings(before, newRaw)
      if (oldString === newString) return toolError('old_string and new_string are the same; there is nothing to change.')

      const found = occurrences(before, oldString)
      if (found.length === 0) {
        // Off only in indentation, and in one place: made there (replace-match.ts).
        const loose = replaceAll ? null : looseReplace(before, oldRaw, newRaw)
        if (loose) {
          noteSeen(context, target.absolute, loose.after)
          return proposed(requested, target.absolute, before, loose.after, context, `line ${loose.line}`,
            "old_string matched once with its indentation set aside, so the file's indentation was kept and new_string was indented to fit. Copy indentation exactly next time.")
        }
        return toolError(notFound(requested, before, oldRaw, seenState(context, target.absolute, before)))
      }
      if (found.length > 1 && !replaceAll) {
        const lines = found.slice(0, 5).map((i) => lineOf(before, i)).join(', ')
        return toolError(
          `old_string appears ${found.length} times in ${requested} (lines ${lines}${found.length > 5 ? ', …' : ''}). ` +
            'Include more surrounding text so it matches once, or set replace_all to true.',
        )
      }

      const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, () => newString)
      // Once approved this is the file, and the model wrote it (read-ledger.ts).
      noteSeen(context, target.absolute, after)
      const count = replaceAll ? `${found.length} occurrence${found.length === 1 ? '' : 's'}` : `line ${lineOf(before, found[0]!)}`
      return proposed(requested, target.absolute, before, after, context, count)
    },
  }
}

/** The planned edit, as ys_replace returns it. */
function proposed(
  requested: string,
  absolute: string,
  before: string,
  after: string,
  context: ToolContext,
  at: string,
  note?: string,
): ToolResult {
  const change: FileChange = { relativePath: requested, absolutePath: absolute, isNew: false, isDeleted: false, before, after }
  const previews = [previewOf(change, context.workspaceRoots)]
  const pending: PendingWrite = { label: summariseChanges(previews), changes: previews }
  const where = describeWorkspacePath(context.workspaceRoots, absolute)
  return toolOk(
    `Proposed edit (pending review): replace in ${where} at ${at}.\n` +
      (note ? `${note}\n` : '') +
      'The change is staged for your review and will be written only after you approve it.',
    `ys_replace — ${where} (pending approval)`,
    false,
    pending,
  )
}

/**
 * Why old_string is not there, and the file's own text where it comes
 * closest, so the next call can copy from it without another read.
 */
function notFound(requested: string, file: string, oldString: string, seen: 'unread' | 'current' | 'changed'): string {
  const lines = [`old_string was not found in ${requested}. It must match the file exactly, including indentation and blank lines.`]
  if (seen === 'changed') lines.push('The file has changed since you last read it (your own earlier edits are in it), so text from that read may be out of date.')
  else if (seen === 'unread') lines.push('You have not read this file in this run; old_string must be copied from the file, not recalled.')
  const near = closestText(file, oldString)
  if (!near || near.matched === 0) {
    lines.push('None of its lines are in the file. Read the file again and copy the text from it.')
    return lines.join('\n')
  }
  const range = near.startLine === near.endLine ? `line ${near.startLine}` : `lines ${near.startLine}-${near.endLine}`
  lines.push(`Closest: ${range}, where ${near.matched} of its ${near.total} lines match with whitespace aside.`)
  if (near.firstDiff) {
    lines.push(
      `First difference: your line ${near.firstDiff.wantedLine} is "${showLine(near.firstDiff.wanted)}"; ` +
        `the file's line ${near.firstDiff.fileLine} is "${showLine(near.firstDiff.actual)}" (\\t is a tab).`,
    )
  }
  lines.push(`The file's ${range}, exactly as it has them:`, '---', near.text, '---')
  return lines.join('\n')
}

export function createDeleteFileTool(fs: WriteFs): Tool {
  return {
    definition: {
      name: assertWorkspaceToolName('ys_delete_file'),
      description:
        'Propose deleting a file. Always reviewed; undone with Revert Last Write.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative path.' } },
        required: ['path'],
        additionalProperties: false,
      },
    },

    async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
      if (context.workspaceRoots.length === 0) return toolError('No workspace folder is open.')
      const requested = stringArg(args, 'path')
      if (requested === null) return toolError('ys_delete_file requires a "path" argument.')
      const target = resolveTarget(context, requested)
      if (!target.ok) return target.error
      if (!fs.exists(target.absolute)) return toolError(`"${requested}" does not exist (or is a directory).`)

      const change: FileChange = {
        relativePath: requested,
        absolutePath: target.absolute,
        isNew: false,
        isDeleted: true,
        before: fs.read(target.absolute),
        after: '',
      }
      const previews = [previewOf(change, context.workspaceRoots)]
      const where = describeWorkspacePath(context.workspaceRoots, target.absolute)
      return toolOk(
        `Proposed deletion (pending review): ${where}. It will be deleted only after you approve it.`,
        `ys_delete_file — ${where} (pending approval)`,
        false,
        { label: summariseChanges(previews), changes: previews },
      )
    },
  }
}

export function createMoveFileTool(fs: WriteFs): Tool {
  return {
    definition: {
      name: assertWorkspaceToolName('ys_move_file'),
      description:
        'Propose moving or renaming a file; folders are created, the destination must not exist. ' +
        'Applied after review. Fix imports with ys_replace.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Workspace-relative path.' },
          to: { type: 'string', description: 'Workspace-relative path.' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
    },

    async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
      if (context.workspaceRoots.length === 0) return toolError('No workspace folder is open.')
      const from = stringArg(args, 'from')
      const to = stringArg(args, 'to')
      if (from === null || to === null) return toolError('ys_move_file requires "from" and "to" arguments.')
      const source = resolveTarget(context, from)
      if (!source.ok) return source.error
      const dest = resolveTarget(context, to)
      if (!dest.ok) return dest.error
      if (!fs.exists(source.absolute)) return toolError(`"${from}" does not exist (or is a directory).`)
      if (source.absolute === dest.absolute) return toolError('"from" and "to" are the same file.')
      if (fs.exists(dest.absolute)) return toolError(`"${to}" already exists. Delete it first, or pick another name.`)

      const content = fs.read(source.absolute)
      const changes: FileChange[] = [
        { relativePath: to, absolutePath: dest.absolute, isNew: true, isDeleted: false, before: '', after: content },
        { relativePath: from, absolutePath: source.absolute, isNew: false, isDeleted: true, before: content, after: '' },
      ]
      const previews = changes.map((c) => previewOf(c, context.workspaceRoots))
      const label = `${describeWorkspacePath(context.workspaceRoots, source.absolute)} → ${describeWorkspacePath(context.workspaceRoots, dest.absolute)}`
      return toolOk(
        `Proposed move (pending review): ${label}. It happens only after you approve it.`,
        `ys_move_file — ${label} (pending approval)`,
        false,
        { label: `move ${label}`, changes: previews },
      )
    },
  }
}
