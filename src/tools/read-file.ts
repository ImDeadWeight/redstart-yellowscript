// =============================================================================
// ys_read_file — read a workspace file, or a line range of one.
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
import { PathScopeError, describeWorkspacePath } from './workspace-path.ts'
import { resolveReadPath } from './read-scope.ts'
import { noteSeen } from './read-ledger.ts'
import { secretReason } from './protected-paths.ts'
import { formatOutline, outlineOf, type SymbolProvider } from './symbols.ts'

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

/** A file longer than this, read with no offset, comes back as its outline
 *  and its head (PLAN-long-tasks.md item 5). */
export const OUTLINE_OVER_LINES = 400
/** Lines of the head sent with the outline. */
export const OUTLINE_HEAD_LINES = 80

export function createReadFileTool(symbols: SymbolProvider | null = null): Tool {
  return {
    definition: {
      name: assertWorkspaceToolName('ys_read_file'),
      description:
        'Read a workspace text file, with 1-based line numbers. A large file is truncated: page ' +
        'through it with offset and limit instead of re-reading it whole.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative, e.g. "src/index.ts".',
          },
          offset: {
            type: 'integer',
            description: 'First line, 1-based.',
            minimum: 1,
          },
          limit: {
            type: 'integer',
            description: `Lines to return (default ${DEFAULT_LINE_LIMIT}).`,
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
        return toolError('ys_read_file requires a "path" string argument.')
      }

      let absolute: string
      try {
        absolute = await resolveReadPath(context, requested)
      } catch (err) {
        return pathFailure(err, requested)
      }

      const label = describeWorkspacePath(context.workspaceRoots, absolute)

      // What a read returns goes into the prompt and the transcript, so a
      // secrets file waits for the person.
      const secret = secretReason(absolute)
      if (secret) {
        const allowed = context.askRead ? await context.askRead({ absolutePath: absolute, label, reason: secret }) : false
        if (!allowed) {
          return toolError(`Not read: ${secret}, and reading it needs the person's go-ahead, which was not given. Ask them for what you need from it instead.`)
        }
      }

      let stat: Awaited<ReturnType<typeof fsp.stat>>
      try {
        stat = await fsp.stat(absolute)
      } catch (err) {
        return readFailure(err, label)
      }

      if (stat.isDirectory()) {
        return toolError(`${label} is a directory. Use ys_list_directory to see what is in it.`)
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

      // What ys_replace checks old_string's source against (read-ledger.ts).
      noteSeen(context, absolute, buffer.toString('utf8'))

      if (stat.size === 0) {
        return toolOk(`${label} is empty (0 bytes).`, `Read ${label} — empty`)
      }

      const lines = buffer.toString('utf8').split('\n')
      // A trailing newline yields a final empty element that is not a real line.
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()

      // A big file asked for whole: its outline and head first, so the model
      // stops taking a truncated head for the whole file, and its next read
      // (lines 300-360) costs 60 lines, not 2,000.
      if (intArg(args, 'offset') === null && intArg(args, 'limit') === null && lines.length > OUTLINE_OVER_LINES) {
        const { symbols: found } = await outlineOf(symbols, absolute, lines.join('\n'))
        const { text: outline } = formatOutline(found, 150)
        const width = String(OUTLINE_HEAD_LINES).length
        const head = lines.slice(0, OUTLINE_HEAD_LINES).map((l, i) => `${String(i + 1).padStart(width, ' ')}\t${l}`).join('\n')
        const { text } = truncateForModel(
          `${label} (${lines.length} lines)\n\n--- outline ---\n${outline || '(no symbols found)'}\n\n--- lines 1-${OUTLINE_HEAD_LINES} ---\n${head}\n\n` +
            `[${lines.length} lines. This is its outline and first ${OUTLINE_HEAD_LINES} lines; read a range with offset and limit.]`,
        )
        return toolOk(text, `Read ${label} — outline (${lines.length} lines)`, true)
      }

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
}

/** Without a language server: the outline of a big file comes from its text. */
export const readFileTool: Tool = createReadFileTool()

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
  if (code === 'EISDIR') return toolError(`${label} is a directory. Use ys_list_directory instead.`)
  const reason = err instanceof Error ? err.message : String(err)
  return toolError(`Could not read ${label}: ${reason}`)
}
