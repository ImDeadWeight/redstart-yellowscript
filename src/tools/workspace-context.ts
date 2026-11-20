// =============================================================================
// What the model knows about the workspace before its first call.
// =============================================================================
// Each run started blind: the model spent its first turns listing folders,
// and never saw the project's own instructions unless it happened to read
// them. This builds a short system message instead:
//
// - The project's instructions: AGENTS.md (the cross-agent convention Nest's
//   projects also import and export), or CLAUDE.md when there is no AGENTS.md.
// - The model's own notes on the project, .yellowscript/NOTES.md (ys_note).
// - A two-level file tree, skipping what search skips (node_modules, dist…).
//
// Both are capped so a large repo costs a few hundred tokens, not thousands.
// No `vscode` import: filesystem access is injected.
// =============================================================================

import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'

import { SKIPPED_DIRECTORIES } from './fallback-search.ts'
import { shellNote } from './process-runner.ts'
import { NOTES_FILE, notesForContext } from './notes.ts'

/** Instruction files, first found wins. */
export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const
export const MAX_INSTRUCTION_CHARS = 6_000
export const MAX_TREE_ENTRIES = 120

export interface ContextFs {
  readFile(path: string): string | null
  /** Entries of a directory, or null when it cannot be read. */
  readDir(path: string): Array<{ name: string; isDirectory: boolean }> | null
}

export const nodeContextFs: ContextFs = {
  readFile(p) {
    try {
      return nodeFs.readFileSync(p, 'utf8')
    } catch {
      return null
    }
  },
  readDir(p) {
    try {
      return nodeFs.readdirSync(p, { withFileTypes: true }).map((d) => ({ name: d.name, isDirectory: d.isDirectory() }))
    } catch {
      return null
    }
  },
}

const sortEntries = (a: { name: string; isDirectory: boolean }, b: { name: string; isDirectory: boolean }) =>
  a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1

/** The top two levels of the tree, as indented lines, capped. */
export function workspaceTree(root: string, fs: ContextFs, maxEntries = MAX_TREE_ENTRIES): string[] {
  const lines: string[] = []
  let omitted = 0
  const visible = (name: string) => !SKIPPED_DIRECTORIES.has(name) && name !== '.yellowscript' && name !== '.DS_Store'
  for (const entry of (fs.readDir(root) ?? []).filter((e) => visible(e.name)).sort(sortEntries)) {
    if (lines.length >= maxEntries) {
      omitted++
      continue
    }
    lines.push(entry.isDirectory ? `${entry.name}/` : entry.name)
    if (!entry.isDirectory) continue
    const children = (fs.readDir(nodePath.join(root, entry.name)) ?? []).filter((e) => visible(e.name)).sort(sortEntries)
    for (const child of children) {
      if (lines.length >= maxEntries) {
        omitted++
        continue
      }
      lines.push(`  ${child.name}${child.isDirectory ? '/' : ''}`)
    }
  }
  if (omitted > 0) lines.push(`…and ${omitted} more (use ys_list_directory or ys_glob)`)
  return lines
}

/** The system message for a run in `root`, or null with nothing to say. */
export function buildWorkspaceContext(root: string, fs: ContextFs = nodeContextFs): string | null {
  const parts: string[] = [
    `The workspace is ${nodePath.basename(root)} (${root}). Paths you pass to the ys_ tools are relative to it. ${shellNote()}`,
  ]

  for (const name of INSTRUCTION_FILES) {
    const text = fs.readFile(nodePath.join(root, name))
    if (text === null || text.trim() === '') continue
    const body = text.length > MAX_INSTRUCTION_CHARS
      ? `${text.slice(0, MAX_INSTRUCTION_CHARS)}\n…[the rest of ${name} is not shown; read it with ys_read_file]`
      : text.trimEnd()
    parts.push(`The project's instructions, from ${name}. Follow them:\n\n${body}`)
    break
  }

  const notes = notesForContext(fs.readFile(nodePath.join(root, NOTES_FILE)))
  if (notes) parts.push(notes)

  const tree = workspaceTree(root, fs)
  if (tree.length > 0) parts.push(`Files (top two levels):\n${tree.join('\n')}`)
  return parts.join('\n\n')
}
