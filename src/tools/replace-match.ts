// =============================================================================
// When ys_replace's old_string is not in the file as written.
// =============================================================================
// In the redstart-website chats (Qwen 3.6 35B-A3B, 2026-11-25) 44 of 173
// ys_replace calls failed, and nearly all for one reason: the indentation.
// The model read the file, then wrote the first line one or two tabs short
// ("\t{\n\t\t\t\tname:" for a block at three tabs), and the error said only
// "not found". So it sent the same call again: c4m7 and c4m19 three times each.
//
// Two answers, both pure:
//
//   looseReplace   old_string matches exactly one run of whole lines once
//                  each line's leading and trailing whitespace is set aside:
//                  the edit is made there, and new_string is re-indented the
//                  way old_string was off (its first line on its own, the
//                  rest by one consistent shift). When the shift is not
//                  consistent there is no safe guess, and it is not made.
//
//   closestText    otherwise, the window of the file most like old_string,
//                  where they first differ, and the file's own text there,
//                  so the next call can copy it without reading again.
//
// Every edit still goes through the diff review; this only finds the place.
// =============================================================================

/** A line's leading whitespace. */
function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)![0]
}

/** Lines of `text` without a final empty one; \r\n read as \n. */
function linesOf(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

const strip = (line: string) => line.replace(/\r$/, '').trim()

/** Start lines (0-based) where `wanted` matches whole file lines, whitespace aside. */
function looseStarts(fileLines: readonly string[], wanted: readonly string[]): number[] {
  const starts: number[] = []
  const target = wanted.map(strip)
  for (let s = 0; s + target.length <= fileLines.length; s++) {
    let ok = true
    for (let i = 0; i < target.length && ok; i++) ok = strip(fileLines[s + i]!) === target[i]
    if (ok) starts.push(s)
  }
  return starts
}

/** How old_string's indentation becomes the file's: add or take away one prefix. */
type Shift = { add: string } | { remove: string }

function shiftBetween(from: string, to: string): Shift | null {
  if (to.endsWith(from)) return { add: to.slice(0, to.length - from.length) }
  if (from.endsWith(to)) return { remove: from.slice(0, from.length - to.length) }
  return null
}

const sameShift = (a: Shift, b: Shift) =>
  'add' in a ? 'add' in b && a.add === b.add : 'remove' in b && a.remove === b.remove

function applyShift(line: string, shift: Shift): string {
  if (line.trim() === '') return line
  if ('add' in shift) return shift.add + line
  return line.startsWith(shift.remove) ? line.slice(shift.remove.length) : line
}

export interface LooseReplace {
  /** The whole file after the edit. */
  after: string
  /** 1-based first line of the replaced run. */
  line: number
}

/**
 * The edit, when old_string matches exactly one run of whole lines with its
 * indentation set aside and the indentation can be carried over to
 * new_string; otherwise null. Only called after the exact match failed.
 */
export function looseReplace(file: string, oldString: string, newString: string): LooseReplace | null {
  const wanted = linesOf(oldString)
  if (wanted.every((l) => l.trim() === '')) return null
  const fileLines = file.split('\n')
  const starts = looseStarts(fileLines, wanted)
  if (starts.length !== 1) return null
  const s = starts[0]!
  const region = fileLines.slice(s, s + wanted.length).map((l) => l.replace(/\r$/, ''))

  // The first line on its own: that is where the model is most often off.
  const first = { from: indentOf(wanted[0]!), to: indentOf(region[0]!) }
  // The rest by one shift, the same on every non-blank line.
  let shift: Shift | null = null
  for (let i = 1; i < wanted.length; i++) {
    if (wanted[i]!.trim() === '') continue
    const here = shiftBetween(indentOf(wanted[i]!), indentOf(region[i]!))
    if (!here || (shift && !sameShift(shift, here))) return null
    shift ??= here
  }
  // One line: its own shift is the shift.
  shift ??= shiftBetween(first.from, first.to)
  if (!shift) return null

  const replacement = linesOf(newString).map((line, i) =>
    i === 0 && indentOf(line) === first.from && line.trim() !== '' ? first.to + line.slice(first.from.length) : applyShift(line, shift!),
  )
  const crlf = file.includes('\r\n')
  const lastHadCr = fileLines[s + wanted.length - 1]!.endsWith('\r')
  const body =
    newString === ''
      ? []
      : [replacement.join(crlf ? '\r\n' : '\n') + (lastHadCr ? '\r' : '')]
  const after = [...fileLines.slice(0, s), ...body, ...fileLines.slice(s + wanted.length)].join('\n')
  return { after, line: s + 1 }
}

export interface ClosestText {
  /** 1-based, inclusive. */
  startLine: number
  endLine: number
  /** How many of old_string's lines are there, whitespace aside. */
  matched: number
  total: number
  /** The first line that differs, when one does. */
  firstDiff: { wantedLine: number; wanted: string; fileLine: number; actual: string } | null
  /** The file's text over those lines, as it is. */
  text: string
}

/** The most lines shown back, and the most characters. */
const SHOW_LINES = 40
const SHOW_CHARS = 2500
/** Past this many line comparisons the search is not worth it. */
const MAX_WORK = 2_000_000

/** The window most like old_string, or null when not one line of it is there. */
export function closestText(file: string, oldString: string): ClosestText | null {
  const wanted = linesOf(oldString)
  const fileLines = file.split('\n').map((l) => l.replace(/\r$/, ''))
  if (fileLines.length > 1 && fileLines.at(-1) === '') fileLines.pop()
  const n = wanted.length
  if (n === 0 || fileLines.length * n > MAX_WORK) return null
  const target = wanted.map(strip)
  const stripped = fileLines.map(strip)

  let best = { start: -1, score: 0 }
  for (let s = 0; s + n <= fileLines.length; s++) {
    let score = 0
    for (let i = 0; i < n; i++) if (target[i] !== '' && stripped[s + i] === target[i]) score++
    if (score > best.score) best = { start: s, score }
  }
  // A shorter file than old_string, or nothing in common.
  if (best.start === -1) return null

  const s = best.start
  let firstDiff: ClosestText['firstDiff'] = null
  for (let i = 0; i < n; i++) {
    if (fileLines[s + i] !== wanted[i]) {
      firstDiff = { wantedLine: i + 1, wanted: wanted[i]!, fileLine: s + i + 1, actual: fileLines[s + i]! }
      break
    }
  }
  const shown = fileLines.slice(s, s + Math.min(n, SHOW_LINES)).join('\n')
  return {
    startLine: s + 1,
    endLine: s + n,
    matched: best.score,
    total: target.filter((t) => t !== '').length,
    firstDiff,
    text: shown.length > SHOW_CHARS ? `${shown.slice(0, SHOW_CHARS)}\n…` : shown,
  }
}

/** A whitespace-visible copy of one line for the error: tabs as \t. */
export function showLine(line: string): string {
  const indent = indentOf(line)
  return JSON.stringify(indent + line.slice(indent.length).trimEnd()).slice(1, -1)
}
