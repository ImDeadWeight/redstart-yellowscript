// =============================================================================
// ws_read_file — read a workspace file, or a line range of one.
// =============================================================================

import * as fsp from 'node:fs/promises'

import {
  MAX_RESULT_CHARS,
  assertWorkspaceToolName,
  stringArg,
  intArg,
  toolError,
  toolOk,
  truncateForModel,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './types.ts'
import { PathScopeError, describeWorkspacePath, resolveWithinWorkspace } from './workspace-path.ts'

/** Lines returned when the model doesn't ask for a range. Large enough for
 *  almost any source file, small enough that a bundled asset can't eat the
 *  context window before the character budget catches it. */
export const DEFAULT_LINE_LIMIT = 2_000

/** Files above this are refused outright rather than read into memory. No
 *  source file approaches it; anything that does is a build artefact the model
 *  should not be reading. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024

/** How much of the head is examined for a NUL byte when sniffing for binary. */
const BINARY_SNIFF_BYTES = 8_000

export const readFileTool: Tool = {
  definition: {
    name: assertWorkspaceToolName('ws_read_file'),
    description:
      'Read a text file from the workspace. Returns the file with 1-based line numbers. ' +
      'Output is truncated if the file is large, so pass `offset` and `limit` to page through ' +
      'a big file rather than re-reading it whole. Paths are relative to the workspace folder. ' +
      'Refuses binary files and anything outside the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative path to the file, e.g. "src/index.ts".',
        },
        offset: {
          type: 'integer',
          description: 'First line to return, 1-based. Omit to start at the beginning.',
          minimum: 1,
        },
        limit: {
          type: 'integer',
          description: `Maximum number of lines to return. Defaults to ${DEFAULT_LINE_LIMIT}.`,
          minimum: 1,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const requested = stringArg(args, 'path')
    if (requested === null) {
      return toolError('ws_read_file requires a "path" string argument.')
    }

    let absolute: string
    try {
      absolute = resolveWithinWorkspace(context.workspaceRoots, requested)
    } catch (err) {
      return pathFailure(err, requested)
    }

    const label = describeWorkspacePath(context.workspaceRoots, absolute)

    let stat: Awaited<ReturnType<typeof fsp.stat>>
    try {
      stat = await fsp.stat(absolute)
    } catch (err) {
      return readFailure(err, label)
    }

    if (stat.isDirectory()) {
      return toolError(`${label} is a directory. Use ws_list_directory to see what is in it.`)
    }
    if (stat.size > MAX_FILE_BYTES) {
      const mb = (stat.size / 1024 / 1024).toFixed(1)
      return toolError(
        `${label} is ${mb} MB, which is too large to read (limit ${MAX_FILE_BYTES / 1024 / 1024} MB).`,
      )
    }

    let buffer: Buffer
    try {
      buffer = await fsp.readFile(absolute)
    } catch (err) {
      return readFailure(err, label)
    }
    if (context.signal?.aborted) {
      return toolError(`Reading ${label} was cancelled.`)
    }

    // A NUL byte in the head is the standard heuristic, and the same one git
    // uses. Dumping a binary into a 32k context is unrecoverable — it evicts
    // the conversation and tells the model nothing.
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return toolError(`${label} looks like a binary file, so it was not read.`)
    }

    if (stat.size === 0) {
      return toolOk(`${label} is empty (0 bytes).`, `Read ${label} — empty`)
    }

    const lines = buffer.toString('utf8').split('\n')
    // A trailing newline yields a final empty element that is not a real line.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()

    const offset = intArg(args, 'offset') ?? 1
    const limit = intArg(args, 'limit') ?? DEFAULT_LINE_LIMIT
    const start = Math.max(1, offset)

    if (start > lines.length) {
      return toolError(
        `${label} has only ${lines.length} lines, so offset ${start} is past the end.`,
      )
    }

    const slice = lines.slice(start - 1, start - 1 + Math.max(1, limit))
    // Right-align the gutter to the widest number that could appear, so the
    // file's own indentation still lines up for the model.
    const width = String(start + slice.length - 1).length

    // Spend the character budget line by line rather than truncating the joined
    // string afterwards. The reported range MUST be exactly what was returned:
    // if the header claims lines 1-2000 but the budget cut it off at 900, the
    // model computes its next offset as 2001 and silently skips 1100 lines it
    // never saw. That is the failure this tool exists to avoid.
    const rendered: string[] = []
    let used = 0
    for (const [i, line] of slice.entries()) {
      const numbered = `${String(start + i).padStart(width, ' ')}\t${line}`
      // Always emit at least one line, even an over-long one — returning an
      // empty body with a "truncated" note tells the model nothing.
      if (rendered.length > 0 && used + numbered.length + 1 > MAX_RESULT_CHARS) break
      rendered.push(numbered)
      used += numbered.length + 1
      if (used >= MAX_RESULT_CHARS) break
    }

    const lastLine = start + rendered.length - 1
    const withheld = lines.length - lastLine

    // Only reachable when a single line is itself longer than the whole budget.
    const { text } = truncateForModel(rendered.join('\n'), MAX_RESULT_CHARS)

    // Say what was withheld and how to ask for it. Without this the model
    // reasons about a fragment as though it were the whole file.
    const more =
      withheld > 0 ? `\n\n[${withheld} more lines. Read them with offset ${lastLine + 1}.]` : ''
    const header =
      rendered.length === lines.length
        ? `${label} (${lines.length} lines)`
        : `${label} (lines ${start}-${lastLine} of ${lines.length})`

    return toolOk(
      `${header}\n\n${text}${more}`,
      `Read ${label}${rendered.length === lines.length ? '' : ` (lines ${start}–${lastLine})`}`,
      withheld > 0,
    )
  },
}

/** Containment failures, phrased so the model can tell "try another path" from
 *  "there is nothing you can do here". */
function pathFailure(err: unknown, requested: string): ToolResult {
  if (err instanceof PathScopeError) {
    if (err.reason === 'no-workspace') {
      return toolError('No workspace folder is open, so there are no files to read.')
    }
    return toolError(
      `"${requested}" is outside the workspace. Only files inside the open folders can be read.`,
    )
  }
  throw err
}

function readFailure(err: unknown, label: string): ToolResult {
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') return toolError(`${label} does not exist.`)
  if (code === 'EACCES' || code === 'EPERM') return toolError(`${label} is not readable (permission denied).`)
  if (code === 'EISDIR') return toolError(`${label} is a directory. Use ws_list_directory instead.`)
  const reason = err instanceof Error ? err.message : String(err)
  return toolError(`Could not read ${label}: ${reason}`)
}
