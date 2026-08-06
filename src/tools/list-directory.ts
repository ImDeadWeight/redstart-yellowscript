// =============================================================================
// ws_list_directory — what is in a workspace folder.
// =============================================================================

import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { Dirent } from 'node:fs'

import {
  MAX_RESULT_CHARS,
  assertWorkspaceToolName,
  stringArg,
  toolError,
  toolOk,
  truncateForModel,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './types.ts'
import { PathScopeError, describeWorkspacePath, resolveWithinWorkspace } from './workspace-path.ts'

/** Entries listed before the rest are dropped. A directory with more than this
 *  is a build output or a dependency tree, and the model needs to know it is
 *  big far more than it needs the remaining names. */
export const MAX_ENTRIES = 300

export const listDirectoryTool: Tool = {
  definition: {
    name: assertWorkspaceToolName('ws_list_directory'),
    description:
      'List the contents of a workspace directory, one entry per line, directories first. ' +
      'Directories are shown with a trailing slash and files with their size. ' +
      'Does not recurse — use ws_glob to match files across a tree. ' +
      'Nothing outside the workspace can be listed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Workspace-relative directory, e.g. "src". Omit or pass "." for the workspace root.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    // Absent is legitimate here (list the root); a non-string that isn't absent
    // still falls through to ".", which is the friendlier reading of a model
    // that sent `{"path": null}`.
    const requested = stringArg(args, 'path') ?? '.'

    let absolute: string
    try {
      absolute = resolveWithinWorkspace(context.workspaceRoots, requested)
    } catch (err) {
      if (err instanceof PathScopeError) {
        if (err.reason === 'no-workspace') {
          return toolError('No workspace folder is open, so there is nothing to list.')
        }
        return toolError(
          `"${requested}" is outside the workspace. Only the open folders can be listed.`,
        )
      }
      throw err
    }

    const label = describeWorkspacePath(context.workspaceRoots, absolute)

    let entries: Dirent[]
    try {
      entries = await fsp.readdir(absolute, { withFileTypes: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') return toolError(`${label} does not exist.`)
      if (code === 'ENOTDIR') return toolError(`${label} is a file, not a directory. Use ws_read_file.`)
      if (code === 'EACCES' || code === 'EPERM') {
        return toolError(`${label} is not readable (permission denied).`)
      }
      const reason = err instanceof Error ? err.message : String(err)
      return toolError(`Could not list ${label}: ${reason}`)
    }

    if (context.signal?.aborted) return toolError(`Listing ${label} was cancelled.`)

    if (entries.length === 0) {
      return toolOk(`${label} is empty.`, `Listed ${label} — empty`)
    }

    // Directories first, then files, each alphabetical. A stable order matters
    // more than it looks: it keeps a repeated call byte-identical, which is
    // what lets prompt caching hold across turns.
    const sorted = [...entries].sort((a, b) => {
      const aDir = a.isDirectory()
      const bDir = b.isDirectory()
      if (aDir !== bDir) return aDir ? -1 : 1
      return a.name.localeCompare(b.name, 'en')
    })

    const shown = sorted.slice(0, MAX_ENTRIES)
    const lines = await Promise.all(
      shown.map(async (entry) => {
        // A symlink is flagged rather than followed. The model may well try to
        // read through it next, and the containment guard will refuse if it
        // leaves the workspace — saying so here makes that refusal legible
        // instead of surprising.
        if (entry.isSymbolicLink()) return `  ${entry.name} -> (symlink)`
        if (entry.isDirectory()) return `  ${entry.name}/`
        if (!entry.isFile()) return `  ${entry.name} (special)`
        try {
          const stat = await fsp.stat(path.join(absolute, entry.name))
          return `  ${entry.name}  ${formatSize(stat.size)}`
        } catch {
          // Vanished between readdir and stat, or unreadable. The name is still
          // worth reporting.
          return `  ${entry.name}`
        }
      }),
    )

    const omitted = sorted.length - shown.length
    const note = omitted > 0 ? `\n\n[${omitted} more entries not shown]` : ''
    const body = `${label} (${sorted.length} entries)\n\n${lines.join('\n')}${note}`
    const { text, truncated } = truncateForModel(body, MAX_RESULT_CHARS)

    return toolOk(text, `Listed ${label} — ${sorted.length} entries`, truncated || omitted > 0)
  },
}

/** Compact, aligned-enough sizes. Precision past a decimal place is noise the
 *  model pays tokens for. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
