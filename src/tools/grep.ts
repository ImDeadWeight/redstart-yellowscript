// =============================================================================
// ws_grep — search workspace file contents.
// =============================================================================
// Ripgrep-backed, and that is a safety property rather than a speed one: the
// pattern comes from the model, which can be influenced by file content it just
// read, and a catastrophically-backtracking JS RegExp would block the extension
// host's event loop synchronously with no way to abort it. See ripgrep.ts.
//
// When rg is missing the tool stays available but drops to LITERAL substring
// search, and says so in both its description and its output. Advertising a
// regex it cannot run would be worse than admitting the limitation.
// =============================================================================

import * as path from 'node:path'

import {
  assertWorkspaceToolName,
  boolArg,
  intArg,
  stringArg,
  toolError,
  toolOk,
  truncateForModel,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './types.ts'
import { PathScopeError, resolveWithinWorkspace } from './workspace-path.ts'
import { runRipgrep } from './ripgrep.ts'
import { globToRegExp, literalSearch, walkFiles } from './fallback-search.ts'

/** Total matches returned. Beyond this the answer is "narrow your search", not
 *  more output — the context window is the scarce resource. */
export const MAX_MATCHES = 100
/** Per-file cap, so one generated file cannot fill the whole budget. */
export const MAX_MATCHES_PER_FILE = 20
/** Long lines are previewed, not returned whole: a minified bundle line would
 *  otherwise consume the entire result on its own. */
const MAX_COLUMNS = 250

export function createGrepTool(ripgrepPath: string | null): Tool {
  const degraded = ripgrepPath === null

  return {
    definition: {
      name: assertWorkspaceToolName('ws_grep'),
      description: degraded
        ? 'Search the text of workspace files for a LITERAL substring. Regular expressions are ' +
          'not available in this workspace, so the pattern is matched exactly as written. ' +
          'Returns matching lines grouped by file. Note: .gitignore is not applied.'
        : 'Search the text of workspace files with a regular expression, and return matching ' +
          'lines grouped by file. Respects .gitignore. The syntax is Rust regex: character ' +
          'classes, groups, alternation and anchors all work, but lookaround and backreferences ' +
          'are not supported. Set "literal" to true to search for the pattern verbatim instead.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: degraded
              ? 'Literal text to find.'
              : 'Regular expression to search for (Rust regex syntax).',
          },
          path: {
            type: 'string',
            description: 'Optional workspace-relative directory to search under.',
          },
          glob: {
            type: 'string',
            description: 'Optional file filter, e.g. "*.ts" — only matching files are searched.',
          },
          caseSensitive: {
            type: 'boolean',
            description: 'Match case exactly. Defaults to false (case-insensitive).',
          },
          literal: {
            type: 'boolean',
            description: 'Treat the pattern as literal text rather than a regular expression.',
          },
          maxResults: {
            type: 'integer',
            description: `Cap on matches returned. Defaults to ${MAX_MATCHES}.`,
            minimum: 1,
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },

    async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
      const pattern = stringArg(args, 'pattern')
      if (pattern === null || pattern === '') {
        return toolError('ws_grep requires a non-empty "pattern" string argument.')
      }

      const scope = stringArg(args, 'path')
      let roots: string[]
      try {
        roots =
          scope === null
            ? [...context.workspaceRoots]
            : [resolveWithinWorkspace(context.workspaceRoots, scope)]
      } catch (err) {
        if (err instanceof PathScopeError) {
          return err.reason === 'no-workspace'
            ? toolError('No workspace folder is open, so there is nothing to search.')
            : toolError(`"${scope}" is outside the workspace.`)
        }
        throw err
      }
      if (roots.length === 0) {
        return toolError('No workspace folder is open, so there is nothing to search.')
      }

      const caseSensitive = boolArg(args, 'caseSensitive') ?? false
      const literal = boolArg(args, 'literal') ?? false
      const fileGlob = stringArg(args, 'glob')
      const limit = Math.min(intArg(args, 'maxResults') ?? MAX_MATCHES, MAX_MATCHES)

      const matches: Match[] = []
      let truncated = false

      for (const root of roots) {
        if (matches.length >= limit) {
          truncated = true
          break
        }
        const outcome = degraded
          ? await grepDegraded(root, pattern, fileGlob, caseSensitive, limit - matches.length, context.signal)
          : await grepWithRipgrep(
              ripgrepPath as string,
              root,
              { pattern, fileGlob, caseSensitive, literal, limit: limit - matches.length },
              context.signal,
            )

        if (outcome.error !== undefined) return toolError(outcome.error)
        truncated ||= outcome.truncated
        const prefix = roots.length > 1 ? `${path.basename(root)}/` : ''
        for (const match of outcome.matches) {
          matches.push({ ...match, file: `${prefix}${match.file}` })
        }
      }

      const banner = degraded ? '(ripgrep unavailable — literal search, .gitignore not applied)\n\n' : ''

      if (matches.length === 0) {
        const hint = degraded ? '' : ' Files excluded by .gitignore are not searched.'
        return toolOk(
          `${banner}No matches for "${pattern}".${hint}`,
          `ws_grep "${pattern}" — no matches`,
        )
      }

      // Grouped by file rather than one path per line: with 100 matches the
      // repeated paths would cost more tokens than the matched text.
      const grouped = new Map<string, Match[]>()
      for (const match of matches) {
        const list = grouped.get(match.file)
        if (list) list.push(match)
        else grouped.set(match.file, [match])
      }

      const blocks = [...grouped].map(([file, hits]) => {
        const lines = hits.map((hit) => `  ${hit.line}: ${hit.text.trim()}`).join('\n')
        return `${file}\n${lines}`
      })

      const note = truncated ? `\n\n[stopped at ${limit} matches — narrow the search]` : ''
      const header = `${matches.length} match${matches.length === 1 ? '' : 'es'} in ${grouped.size} file${grouped.size === 1 ? '' : 's'}:`
      const { text, truncated: cut } = truncateForModel(
        `${banner}${header}\n\n${blocks.join('\n\n')}${note}`,
      )

      return toolOk(text, `ws_grep "${pattern}" — ${matches.length} match(es)`, truncated || cut)
    },
  }
}

interface Match {
  file: string
  line: number
  text: string
}

interface GrepOutcome {
  matches: Match[]
  truncated: boolean
  error?: string
}

async function grepWithRipgrep(
  binary: string,
  root: string,
  query: { pattern: string; fileGlob: string | null; caseSensitive: boolean; literal: boolean; limit: number },
  signal: AbortSignal | undefined,
): Promise<GrepOutcome> {
  const args = [
    '--line-number',
    '--no-heading',
    '--color=never',
    `--max-columns=${MAX_COLUMNS}`,
    '--max-columns-preview',
    `--max-count=${MAX_MATCHES_PER_FILE}`,
    '--hidden',
    // See glob.ts: without this, .gitignore is only applied inside a git
    // repository, so a non-checkout workspace folder returns ignored files.
    '--no-require-git',
    '--glob',
    '!.git/',
  ]
  if (!query.caseSensitive) args.push('--ignore-case')
  if (query.literal) args.push('--fixed-strings')

  // The file filter goes in as a TYPE, not as --glob. A command line --glob
  // outranks .gitignore in ripgrep's precedence, so `-g '*.ts'` would re-admit
  // every ignored .ts file — every .d.ts in node_modules included. A type
  // filter scopes the search without touching the ignore rules; both were
  // measured against a non-git fixture before choosing.
  //
  // Types match on the file name, so a path-shaped glob ("src/**/*.ts") cannot
  // be expressed as one. Those are filtered from the results instead — see
  // pathFilter below. A colon would break --type-add's own name:glob syntax.
  const glob = query.fileGlob
  const pathShaped = glob !== null && glob !== '' && (glob.includes('/') || glob.includes(':'))
  if (glob !== null && glob !== '' && !pathShaped) {
    args.push('--type-add', `wsfilter:${glob}`, '--type', 'wsfilter')
  }
  const pathFilter = pathShaped ? globToRegExp(glob) : null
  // Everything after `--` is positional, so a pattern beginning with a dash is
  // read as a pattern rather than as a flag.
  args.push('--', query.pattern, '.')

  let run
  try {
    run = await runRipgrep(binary, args, { cwd: root, ...(signal ? { signal } : {}) })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { matches: [], truncated: false, error: `Could not run the search: ${reason}` }
  }

  if (run.outcome === 'error') {
    const detail = run.stderr.trim().split('\n')[0] ?? 'unknown error'
    // Almost always a malformed pattern, and the model can fix that if told.
    return { matches: [], truncated: false, error: `Search failed for "${query.pattern}": ${detail}` }
  }

  const matches: Match[] = []
  for (const line of run.stdout.split('\n')) {
    if (matches.length >= query.limit) return { matches, truncated: true }
    const parsed = parseRipgrepLine(line)
    if (!parsed) continue
    if (pathFilter && !pathFilter.test(parsed.file)) continue
    matches.push(parsed)
  }
  return { matches, truncated: run.truncated }
}

/**
 * Read one `path:line:text` record.
 *
 * The path is matched non-greedily so that a colon in the matched TEXT cannot
 * be mistaken for the delimiter — `a.ts:5:foo: bar` has to parse as line 5 of
 * a.ts, not as a file called `a.ts:5:foo`.
 */
export function parseRipgrepLine(line: string): Match | null {
  const match = /^(.+?):(\d+):([\s\S]*)$/.exec(line)
  if (!match) return null
  const [, file, lineNumber, text] = match
  if (file === undefined || lineNumber === undefined) return null
  // rg is given "." as its search path, so every result comes back prefixed
  // "./" (or ".\"). Strip it: the prefix is noise in the output, and it makes
  // an anchored path filter like "src/**/*.ts" fail to match.
  const normalized = file.split('\\').join('/').replace(/^\.\//, '')
  return { file: normalized, line: Number(lineNumber), text: text ?? '' }
}

async function grepDegraded(
  root: string,
  pattern: string,
  fileGlob: string | null,
  caseSensitive: boolean,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<GrepOutcome> {
  const walked = await walkFiles(root, { ...(signal ? { signal } : {}) })
  let files = walked.files
  if (fileGlob !== null && fileGlob !== '') {
    let matcher: RegExp
    try {
      matcher = globToRegExp(fileGlob)
    } catch {
      return { matches: [], truncated: false, error: `Invalid glob "${fileGlob}".` }
    }
    // A bare "*.ts" should still match nested files here, since the degraded
    // walk returns full relative paths.
    const basenameMatcher = globToRegExp(`**/${fileGlob}`)
    files = files.filter((file) => matcher.test(file) || basenameMatcher.test(file))
  }

  const found = await literalSearch(root, files, pattern, {
    caseSensitive,
    limit,
    ...(signal ? { signal } : {}),
  })
  return { matches: found.matches, truncated: found.truncated || walked.truncated }
}
