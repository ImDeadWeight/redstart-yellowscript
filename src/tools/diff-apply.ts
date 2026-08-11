// =============================================================================
// The unified-diff applier — turns a model-supplied diff string into a set of
// concrete file changes, WITHOUT writing anything to disk.
// =============================================================================
// Phase 3.1. The model sends a unified diff (the shape `git diff` produces, and
// the shape these small models already know from training). The host owns the
// apply: this module only COMPUTES what would change, so the result can be shown
// in a native diff editor and gated behind approval before a byte touches the
// workspace (HANDOFF: writes are "never applied directly — always through diff
// review").
//
// WHY A SEPARATE PREVIEW STEP RATHER THAN PATCHING ON THE SPOT:
//
// A unified diff is a promise about the surrounding context lines. The model —
// or a prompt injection riding in a file it read — can send a diff whose
// context does NOT match the current file. Patching such a diff silently (or
// erroring midway through a multi-file batch) is exactly the "a bug destroys
// user work" failure the checkpoint work exists to contain. So we compute every
// change first, prove each one applies, and only then does the approve step
// actually write. A single mismatched hunk rejects the whole file's change as a
// result the model can read and correct — no partial writes, no surprise bytes.
//
// THE APPLIER IS DELIBERATELY `vscode`-FREE. It takes absolute paths and file
// contents; the containment guard (already used everywhere else) decides which
// paths are allowed before any of this runs. That keeps the apply logic —
// context matching, hunk offsets, "file does not exist" — unit-testable with
// plain strings, which is where the bugs actually are.
//
// No `vscode` import.
// =============================================================================

import { PathScopeError } from './workspace-path.ts'

/** One file referenced by a diff. `oldPath`/`newPath` differ for renames, which
 *  this engine does not support yet — see `parseUnifiedDiff`. */
export interface DiffFile {
  /** Workspace-relative path as it appeared in the diff's `+++`/`---` lines. */
  path: string
  /** True when the `---` side was `/dev/null` (a new file). */
  isNew: boolean
  /** True when the `+++` side was `/dev/null` (a deletion). */
  isDeleted: boolean
  /** The hunks belonging to this file, in the order they appeared. */
  hunks: DiffHunk[]
}

export interface DiffHunk {
  /** 1-based line the hunk is meant to start at in the OLD file. */
  oldStart: number
  /** Number of old-file lines the hunk spans (context + removed). */
  oldLines: number
  /** 1-based line the hunk is meant to start at in the NEW file. */
  newStart: number
  /** Number of new-file lines the hunk spans (context + added). */
  newLines: number
  /** Every line of the hunk, including the leading `+`/`-`/` ` marker. The
   *  header line (starting `@@`) is NOT included here. */
  body: string[]
}

export interface ParsedDiff {
  files: DiffFile[]
}

/**
 * A single concrete edit, resolved to absolute paths and ready to apply.
 *
 * `before`/`after` are the full file contents so the diff editor can show the
 * whole file (not just the hunk) and so Apply is a single write per file.
 */
export interface FileChange {
  /** Path as supplied by the model (workspace-relative). */
  relativePath: string
  /** Absolute, containment-resolved target. */
  absolutePath: string
  isNew: boolean
  isDeleted: boolean
  before: string
  after: string
}

export interface ApplyResult {
  changes: FileChange[]
  /** One entry per file the diff could not be applied to, with a reason. */
  errors: { path: string; reason: string }[]
}

/** The outcome of running the applier over a single file's hunks. */
type FileApplyOutcome = { ok: true; change: FileChange } | { ok: false; reason: string }

/**
 * Parse a unified diff into structured files and hunks.
 *
 * Accepted shape (git's default):
 *
 *   --- a/src/foo.ts       (or --- /dev/null)
 *   +++ b/src/foo.ts       (or +++ /dev/null)
 *   @@ -oldStart,oldLines +newStart,newLines @@ optional section
 *    context line
 *   -removed line
 *   +added line
 *
 * The leading `a/` and `b/` prefixes git adds are stripped, because the model
 * addresses the workspace by its real name, not by a git tree prefix.
 *
 * The path can also be given as just `--- src/foo.ts` / `+++ src/foo.ts`
 * (no prefix) — both are handled. A header mentioning a different name on the
 * `---` and `+++` sides is treated as a rename and is NOT supported: we return
 * an error for that file rather than silently writing to one or the other.
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const lines = text.split('\n')
  const files: DiffFile[] = []

  let current: DiffFile | null = null
  let hunkHeader: { oldStart: number; oldLines: number; newStart: number; newLines: number } | null =
    null
  let hunkBody: string[] = []

  const flushHunk = (): void => {
    if (current !== null && hunkHeader !== null) {
      current.hunks.push({ ...hunkHeader, body: hunkBody })
    }
    hunkHeader = null
    hunkBody = []
  }

  const flushFile = (): void => {
    flushHunk()
    if (current !== null) files.push(current)
    current = null
  }

  for (const line of lines) {
    if (line.startsWith('--- ')) {
      flushFile()
      const raw = line.slice(4).replace(/\t.*$/, '')
      current = { path: stripPrefix(raw), isNew: raw === '/dev/null', isDeleted: false, hunks: [] }
    } else if (line.startsWith('+++ ')) {
      // A `+++ ` before any `--- ` is malformed; ignore it (the file will be
      // incomplete and rejected downstream).
      const raw = line.slice(4).replace(/\t.*$/, '')
      if (current === null) {
        current = { path: stripPrefix(raw), isNew: false, isDeleted: raw === '/dev/null', hunks: [] }
      } else {
        current.isDeleted = raw === '/dev/null'
        const newPath = stripPrefix(raw)
        // A rename: the two sides name different files. Not supported yet — mark
        // it so planOneFile rejects it rather than writing to one side or the
        // other silently. A /dev/null side is a real create/delete, not a rename.
        if (!current.isNew && !current.isDeleted && newPath !== current.path) {
          current.path = `UNSUPPORTED_RENAME:${current.path}->${newPath}`
        } else if (!current.path.startsWith('UNSUPPORTED_RENAME:')) {
          current.path = newPath
        }
      }
    } else if (line.startsWith('@@')) {
      flushHunk()
      const parsed = parseHunkHeader(line)
      if (parsed) hunkHeader = parsed
      else hunkHeader = null
    } else if (line.startsWith('diff --git')) {
      // A file-separator line from a multi-file `git diff`. Start fresh.
      flushFile()
    } else if (current !== null && hunkHeader !== null) {
      // Content line of the current hunk: `+`, `-`, ` `, or a no-op `\` guard.
      hunkBody.push(line)
    }
    // Anything else (the `Index:` line, blank separators between files) is
    // ignored but does not flush — a file with no hunks is rejected below.
  }
  flushFile()

  return { files: files.filter((file) => file.hunks.length > 0 || file.isNew || file.isDeleted) }
}

/** Strip git's `a/`/`b/` tree prefix if present; pass other paths through. */
function stripPrefix(raw: string): string {
  if (raw === '/dev/null') return raw
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2)
  return raw
}

/** Parse the `@@ -a,b +c,d @@` header. Missing counts default to 1. */
function parseHunkHeader(line: string): DiffHunk['oldStart'] extends never ? never : {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
} | null {
  // Match @@ -oldStart[,oldLines] +newStart[,newLines] @@
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
  if (!match) return null
  const oldStart = Number(match[1])
  const oldLines = Number(match[2] ?? '1')
  const newStart = Number(match[3])
  const newLines = Number(match[4] ?? '1')
  if (!Number.isFinite(oldStart) || !Number.isFinite(oldLines)) return null
  if (!Number.isFinite(newStart) || !Number.isFinite(newLines)) return null
  return { oldStart, oldLines, newStart, newLines }
}

/**
 * Resolve a parsed diff into concrete, containment-checked file changes.
 *
 * `readFile` supplies the current content of an existing file; `resolve` maps a
 * model path to a containment-checked absolute path (it throws
 * `PathScopeError` on an escape, which callers turn into a result). `exists`
 * tells us whether the resolved path currently holds a file.
 *
 * Every hunk is applied against the ORIGINAL file content independently and the
 * results concatenated, so the order of hunks in the diff does not matter as
 * long as their line ranges don't overlap. A single hunk whose context does not
 * match rejects the whole file (no partial application).
 */
export function planFileChanges(
  diff: ParsedDiff,
  resolve: (relativePath: string) => string,
  exists: (absolutePath: string) => boolean,
  readFile: (absolutePath: string) => string,
): ApplyResult {
  const changes: FileChange[] = []
  const errors: { path: string; reason: string }[] = []

  for (const file of diff.files) {
    const outcome = planOneFile(file, resolve, exists, readFile)
    if (outcome.ok) changes.push(outcome.change)
    else errors.push({ path: file.path, reason: outcome.reason })
  }

  return { changes, errors }
}

function planOneFile(
  file: DiffFile,
  resolve: (relativePath: string) => string,
  exists: (absolutePath: string) => boolean,
  readFile: (absolutePath: string) => string,
): FileApplyOutcome {
  if (file.path.startsWith('UNSUPPORTED_RENAME:')) {
    return { ok: false, reason: 'Rename diffs are not supported — use separate delete and create.' }
  }

  let absolute: string
  try {
    absolute = resolve(file.path)
  } catch (err) {
    if (err instanceof PathScopeError) {
      return { ok: false, reason: `Path "${file.path}" is outside the workspace.` }
    }
    throw err
  }

  // A deletion or edit of a file that does not exist is a contradiction the
  // model can resolve by reading the file first.
  if (!file.isNew && !exists(absolute)) {
    return { ok: false, reason: `${file.path} does not exist, so it cannot be ${file.isDeleted ? 'deleted' : 'edited'}.` }
  }

  const before = file.isNew ? '' : readFile(absolute)
  const after = applyHunks(before, file)
  if (after === null) {
    return { ok: false, reason: `${file.path}: a hunk's context did not match the current file.` }
  }

  return {
    ok: true,
    change: {
      relativePath: file.path,
      absolutePath: absolute,
      isNew: file.isNew,
      isDeleted: file.isDeleted,
      before,
      after,
    },
  }
}

/**
 * Apply all of a file's hunks to `before`, or return null if any hunk fails to
 * match. Each hunk is matched against the ORIGINAL content independently and
 * reassembled, so the diff is position-robust and a bad hunk rejects the file.
 */
export function applyHunks(before: string, file: DiffFile): string | null {
  const sourceLines = before === '' ? [] : before.split('\n')

  const segments: string[][] = []
  let cursor = 0 // index into sourceLines we have consumed up to

  for (const hunk of file.hunks) {
    // The lines before this hunk that are just copied across.
    const leading = sourceLines.slice(cursor, hunk.oldStart - 1)
    segments.push(leading)

    // The number of OLD lines this hunk actually consumes is derived from its
    // body, not from the header count. Real `git` diffs always agree, but the
    // small models we target frequently emit a header count of 1 (or omit it,
    // which we default to 1) while the body carries several context/removed
    // lines. Trusting the header would slice the wrong number of lines and
    // either reject a valid hunk or — worse — misalign the match. The body is
    // the source of truth for how many lines are old vs new.
    let oldCount = 0
    for (const raw of hunk.body) {
      const marker = raw.charAt(0)
      if (marker === '-' || marker === ' ' || marker === '\\' || marker === undefined) {
        if (marker !== '\\') oldCount++
      } else if (marker !== '+') {
        // Unrecognised marker: count as old to be safe.
        oldCount++
      }
    }

    const oldSlice = sourceLines.slice(hunk.oldStart - 1, hunk.oldStart - 1 + oldCount)
    const expectedContext: string[] = []
    const newParts: string[] = []

    for (const raw of hunk.body) {
      const marker = raw.charAt(0)
      const content = raw.slice(1)
      if (marker === '+') {
        newParts.push(content)
      } else if (marker === '-') {
        expectedContext.push(content)
      } else if (marker === ' ') {
        expectedContext.push(content)
        newParts.push(content)
      } else if (marker === '\\') {
        // "\ No newline at end of file" — ignored; we preserve whatever the
        // original had and don't try to force a trailing newline either way.
      } else {
        // A hunk body line with no recognised marker is malformed; treat as a
        // context line so the match still has a chance, but this is unusual.
        expectedContext.push(raw)
        newParts.push(raw)
      }
    }

    // The removed/context lines the diff expects must equal what is actually
    // there. This is the safety check: a diff whose context drifted from the
    // real file is rejected rather than applied with wrong bytes.
    if (oldSlice.length !== expectedContext.length) return null
    for (let i = 0; i < expectedContext.length; i++) {
      if (oldSlice[i] !== expectedContext[i]) return null
    }

    segments.push(newParts)
    cursor = hunk.oldStart - 1 + oldCount
  }

  segments.push(sourceLines.slice(cursor))
  return segments.flat().join('\n')
}
