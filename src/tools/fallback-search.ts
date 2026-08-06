// =============================================================================
// Degraded search, for when the bundled ripgrep cannot be found.
// =============================================================================
// This path is expected to be rare — rg ships with VSCode — but it must exist,
// because a tool that fails on every call is worse than one that says it is
// working with less.
//
// TWO DELIBERATE LIMITATIONS, both stated in the tool output when this is
// active rather than hidden:
//
// 1. NO REGEX. Text search here is literal substring only. ws_grep's pattern
//    comes from the model, which can be influenced by content it just read, and
//    JS RegExp backtracking is synchronous, unabortable, and would freeze the
//    extension host. A regex fallback would reintroduce exactly the hazard that
//    made ripgrep the primary engine. `indexOf` is linear and safe.
//
// 2. NO .gitignore. Parsing gitignore semantics properly (negation,
//    directory-only patterns, nested files, precedence) is a real
//    implementation, and getting it subtly wrong is worse than not having it.
//    A fixed list of heavy directories is skipped instead — honest about what
//    it is, and enough to stop node_modules from swamping the context window.
// =============================================================================

import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

/**
 * Directories never walked in degraded mode. Not a substitute for .gitignore —
 * a fixed list that covers the cases that would otherwise dominate any result.
 */
export const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.gradle',
  '.idea',
  '.cache',
])

/** Ceiling on files visited in one walk, so a pathological tree cannot hang a
 *  turn even though each individual step is cheap. */
export const MAX_FILES_WALKED = 20_000

function escapeRegexChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
}

/**
 * Compile a glob to an anchored RegExp, matched against a POSIX-separated
 * workspace-relative path.
 *
 * Supports the subset that actually gets used: `**` across separators, `*` and
 * `?` within one segment. Deliberately not a full glob implementation — brace
 * expansion and extglob would be more surface than the degraded path deserves,
 * and ripgrep handles them properly on the primary path.
 */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++
        // `**/` should also match zero directories, so that `**/*.ts` finds a
        // file at the root as well as a nested one.
        if (glob[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if (ch !== undefined) {
      out += escapeRegexChar(ch)
    }
  }
  return new RegExp(`^${out}$`)
}

export interface WalkResult {
  /** Workspace-relative, POSIX-separated. */
  files: string[]
  /** True when the walk stopped at MAX_FILES_WALKED. */
  truncated: boolean
}

/**
 * Every file under `root`, skipping the fixed directory list.
 *
 * Paths come back POSIX-separated so glob matching and display are consistent
 * with the ripgrep path on every platform.
 */
export async function walkFiles(
  root: string,
  options: { signal?: AbortSignal; limit?: number } = {},
): Promise<WalkResult> {
  const limit = options.limit ?? MAX_FILES_WALKED
  const files: string[] = []
  const queue: string[] = ['']
  let truncated = false

  while (queue.length > 0) {
    const relativeDir = queue.shift() as string
    if (options.signal?.aborted) break

    let entries
    try {
      entries = await fsp.readdir(path.join(root, relativeDir), { withFileTypes: true })
    } catch {
      continue // unreadable directory — skip rather than abort the whole walk
    }

    for (const entry of entries) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue
        queue.push(relative)
      } else if (entry.isFile()) {
        if (files.length >= limit) {
          truncated = true
          return { files, truncated }
        }
        files.push(relative)
      }
      // Symlinks are not followed: the containment guard would refuse anything
      // they lead outside the workspace, and following them risks a cycle.
    }
  }

  return { files, truncated }
}

export interface LiteralMatch {
  file: string
  line: number
  text: string
}

/**
 * Literal, case-optional substring search over the given files.
 *
 * `indexOf` rather than a regex, on purpose — see limitation 1 above. Files are
 * read one at a time and skipped when they look binary or are too large, so a
 * repository with a checked-in archive cannot stall the search.
 */
export async function literalSearch(
  root: string,
  files: readonly string[],
  needle: string,
  options: { caseSensitive?: boolean; limit?: number; maxFileBytes?: number; signal?: AbortSignal } = {},
): Promise<{ matches: LiteralMatch[]; truncated: boolean }> {
  const limit = options.limit ?? 100
  const maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024
  const target = options.caseSensitive === true ? needle : needle.toLowerCase()
  const matches: LiteralMatch[] = []

  for (const file of files) {
    if (options.signal?.aborted) return { matches, truncated: true }
    if (matches.length >= limit) return { matches, truncated: true }

    let buffer: Buffer
    try {
      const stat = await fsp.stat(path.join(root, file))
      if (!stat.isFile() || stat.size > maxFileBytes) continue
      buffer = await fsp.readFile(path.join(root, file))
    } catch {
      continue
    }
    if (buffer.subarray(0, 8_000).includes(0)) continue // binary

    const lines = buffer.toString('utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      const haystack = options.caseSensitive === true ? line : line.toLowerCase()
      if (!haystack.includes(target)) continue
      if (matches.length >= limit) return { matches, truncated: true }
      matches.push({ file, line: i + 1, text: line.replace(/\r$/, '') })
    }
  }

  return { matches, truncated: false }
}
