// =============================================================================
// ws_glob — find workspace files by name pattern.
// =============================================================================
// Backed by ripgrep's --files so it agrees with ws_grep about what is in the
// workspace, and so .gitignore is honoured. `workspace.findFiles` was the
// obvious alternative and is the wrong one: its own docs apply `files.exclude`
// "but not search.exclude" and say nothing about ignore files, so it returns
// node_modules. Measured on this repo that is 42 files versus thousands.
// =============================================================================

import * as path from 'node:path'

import {
  assertWorkspaceToolName,
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
import { globToRegExp, walkFiles } from './fallback-search.ts'

export const MAX_GLOB_RESULTS = 200

/**
 * @param ripgrepPath resolved once at activation; null puts the tool in
 *        degraded mode, which is stated in both the description the model sees
 *        and the output it gets back.
 */
export function createGlobTool(ripgrepPath: string | null): Tool {
  const degraded = ripgrepPath === null

  return {
    definition: {
      name: assertWorkspaceToolName('ws_glob'),
      description:
        'Find files in the workspace by glob pattern, e.g. "**/*.ts" or "src/**/test-*.js". ' +
        'Returns workspace-relative paths, not file contents. ' +
        (degraded
          ? 'Note: .gitignore is not being applied (a fixed list of heavy directories is skipped instead).'
          : 'Respects .gitignore, so generated and vendored files are not returned.') +
        ` At most ${MAX_GLOB_RESULTS} paths are returned; narrow the pattern if you hit that.`,
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern, e.g. "**/*.ts". Use ** to cross directory boundaries.',
          },
          path: {
            type: 'string',
            description:
              'Optional workspace-relative directory to search under. Omit to search the whole workspace.',
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },

    async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
      const pattern = stringArg(args, 'pattern')
      if (pattern === null || pattern.trim() === '') {
        return toolError('ws_glob requires a "pattern" string argument, e.g. "**/*.ts".')
      }
      // A leading "!" is ripgrep's negation. Passing it through would silently
      // return everything EXCEPT what the model asked for.
      if (pattern.startsWith('!')) {
        return toolError('ws_glob patterns cannot start with "!" (negation is not supported).')
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

      const found: string[] = []
      let truncated = false

      for (const root of roots) {
        if (found.length >= MAX_GLOB_RESULTS) {
          truncated = true
          break
        }
        const remaining = MAX_GLOB_RESULTS - found.length
        const result = degraded
          ? await globDegraded(root, pattern, remaining, context.signal)
          : await globWithRipgrep(ripgrepPath as string, root, pattern, remaining, context.signal)

        if (result.error !== undefined) return toolError(result.error)
        truncated ||= result.truncated
        // Label per root so a multi-root workspace is unambiguous.
        const prefix = roots.length > 1 ? `${path.basename(root)}/` : ''
        for (const file of result.files) found.push(`${prefix}${file}`)
      }

      if (found.length === 0) {
        // Say why a match might be missing: a model that does not know ignored
        // files are excluded will keep re-running the same search.
        const why = degraded ? '' : ' Files excluded by .gitignore are not searched.'
        return toolOk(`No files match "${pattern}".${why}`, `ws_glob "${pattern}" — no matches`)
      }

      const note = truncated ? `\n\n[stopped at ${MAX_GLOB_RESULTS} results — narrow the pattern]` : ''
      const banner = degraded ? '(ripgrep unavailable — .gitignore not applied)\n\n' : ''
      const body = `${banner}${found.length} file${found.length === 1 ? '' : 's'} matching "${pattern}":\n\n${found.join('\n')}${note}`
      const { text } = truncateForModel(body)

      return toolOk(text, `ws_glob "${pattern}" — ${found.length} file(s)`, truncated)
    },
  }
}

interface GlobOutcome {
  files: string[]
  truncated: boolean
  error?: string
}

async function globWithRipgrep(
  binary: string,
  root: string,
  pattern: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<GlobOutcome> {
  // THE PATTERN IS NOT PASSED TO RIPGREP, and that is deliberate. A command
  // line --glob sits ABOVE .gitignore in ripgrep's precedence order, so an
  // inclusive `-g '**/*.ts'` re-admits every ignored .ts file — including all
  // of node_modules. Measured, not assumed: with the glob passed through, a
  // gitignored fixture file came back in the results. Listing the ignored-file
  // set and matching client-side keeps .gitignore authoritative, and has the
  // side benefit that glob semantics are then identical in both modes.
  //
  // --no-require-git is likewise not optional: by default ripgrep applies
  // .gitignore only inside a git repository, so a workspace folder that is not
  // a checkout would silently return everything.
  const args = ['--files', '--hidden', '--no-require-git', '--glob', '!.git/']

  let matcher: RegExp
  try {
    matcher = globToRegExp(pattern)
  } catch {
    return { files: [], truncated: false, error: `Invalid glob pattern "${pattern}".` }
  }

  let run
  try {
    // A larger byte budget than a search needs: this lists every tracked file,
    // and filtering happens here rather than in rg.
    run = await runRipgrep(binary, args, {
      cwd: root,
      maxBytes: 4 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { files: [], truncated: false, error: `Could not run the file search: ${reason}` }
  }

  if (run.outcome === 'error') {
    const detail = run.stderr.trim().split('\n')[0] ?? 'unknown error'
    return { files: [], truncated: false, error: `Could not list workspace files: ${detail}` }
  }

  const files = run.stdout
    .split('\n')
    .map((line) => line.trim().split('\\').join('/'))
    .filter((line) => line.length > 0 && matcher.test(line))

  return { files: files.slice(0, limit), truncated: run.truncated || files.length > limit }
}

async function globDegraded(
  root: string,
  pattern: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<GlobOutcome> {
  let matcher: RegExp
  try {
    matcher = globToRegExp(pattern)
  } catch {
    return { files: [], truncated: false, error: `Invalid glob pattern "${pattern}".` }
  }

  const walked = await walkFiles(root, { ...(signal ? { signal } : {}) })
  const files = walked.files.filter((file) => matcher.test(file))
  return { files: files.slice(0, limit), truncated: walked.truncated || files.length > limit }
}
