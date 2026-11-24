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
// - Where each kind of thing it learns or plans is kept, and with which tool
//   (keepingGuide): one home per kind, said only for the tools it has, so it
//   neither duplicates a note into a memory nor hand-edits the plan file.
// - A two-level file tree, skipping what search skips (node_modules, dist…).
//
// Both are capped so a large repo costs a few hundred tokens, not thousands.
// No `vscode` import: filesystem access is injected.
// =============================================================================

import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'

import { SKIPPED_DIRECTORIES } from './fallback-search.ts'
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

/** The folder Yellowscript and the model keep their files in. */
export const KEEP_DIR = '.yellowscript'
/** Yellowscript's own files there: the model's guide leaves them out. */
const OWN_ENTRIES = new Set(['shadow', 'screenshots', 'NOTES.md', 'PLAN.md'])
const MAX_KEPT_FILES = 15

/** The markdown files the model keeps in .yellowscript/ (not Yellowscript's own). */
export function keptFiles(root: string, fs: ContextFs): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string, depth: number) => {
    for (const entry of (fs.readDir(dir) ?? []).sort(sortEntries)) {
      if (depth === 0 && OWN_ENTRIES.has(entry.name)) continue
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory) {
        if (depth < 2) walk(nodePath.join(dir, entry.name), path, depth + 1)
      } else if (/\.(md|txt)$/i.test(entry.name)) {
        out.push(`${KEEP_DIR}/${path}`)
      }
    }
  }
  walk(nodePath.join(root, KEEP_DIR), '', 0)
  return out
}

export interface KeepingOptions {
  /** The tools this run has. Unknown: the local ys_ tools only. */
  tools?: readonly string[]
  /** The Nest project this workspace is linked to, if any. */
  project?: string | null
  /** Markdown the model already keeps in .yellowscript/. */
  files?: readonly string[]
}

/**
 * Where each kind of thing the model learns or plans belongs, and the tool
 * that keeps it. One home each, so a fact is not written three times; a line
 * only for a tool this run has, so it is never told about one it cannot call.
 */
export function keepingGuide(options: KeepingOptions = {}): string | null {
  const has = (name: string) => (options.tools ? options.tools.includes(name) : name.startsWith('ys_'))
  const lines: string[] = []
  if (has('update_plan')) {
    lines.push(
      `- The plan for the task in hand: update_plan, for work of three or more steps; keep one step in progress. ` +
        `The person sees it as a checklist; it is saved to ${KEEP_DIR}/PLAN.md and carries into a new chat while ` +
        'steps are open. Do not edit PLAN.md yourself.',
    )
  }
  if (has('ask_user')) lines.push('- A decision only the person can make: ask_user, rather than guessing.')
  if (has('ys_note')) {
    lines.push(
      `- What you learn about this workspace (how to build and check it, where things live, decisions and why, ` +
        `known problems): ys_note. It keeps ${KEEP_DIR}/NOTES.md, which comes with every request; do not edit that file directly. ` +
        'Write one when you find it out, not at the end: a command that needed a flag or a cwd you did not expect, ' +
        'a tool or library that works differently from what you knew.' +
        (has('update_plan') ? ' Not the task itself; that is the plan.' : ''),
    )
  }
  if (has('ys_write_file')) {
    const files = options.files ?? []
    const shown = files.slice(0, MAX_KEPT_FILES).join(', ')
    const more = files.length > MAX_KEPT_FILES ? ` and ${files.length - MAX_KEPT_FILES} more` : ''
    lines.push(
      `- A longer document worth keeping (a design, research, a spec, a checklist for later): a markdown file ` +
        `of your own under ${KEEP_DIR}/, e.g. ${KEEP_DIR}/docs/auth-design.md, written with ys_write_file. ` +
        'These are not sent to you: read one when it matters, and name it in a note so a later chat finds it.' +
        (files.length ? ` Yours so far: ${shown}${more}.` : ''),
    )
  }
  if (has('memory_save')) {
    lines.push(
      options.project
        ? `- A durable fact the person's other Redstart apps should know too (the project "${options.project}"): ` +
            'memory_save with scope "project". Short facts only, not this task\'s details or what is already in a note.'
        : '- Project memory (memory_save with scope "project") needs this workspace linked to a Nest project, and ' +
            'it is not; keep project knowledge in a note instead. The person can link one with Yellowscript: Choose Project.',
    )
  }
  if (lines.length === 0) return null
  return [
    'Where to keep things. Each kind has one place; do not copy the same fact into several:',
    ...lines,
    `${KEEP_DIR}/shadow/ holds Yellowscript's checkpoints: never read or write it.`,
  ].join('\n')
}

/** The system message for a run in `root`, or null with nothing to say. */
export function buildWorkspaceContext(root: string, fs: ContextFs = nodeContextFs, keeping: Omit<KeepingOptions, 'files'> = {}): string | null {
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

  const guide = keepingGuide({ ...keeping, files: keptFiles(root, fs) })
  if (guide) parts.push(guide)

  const tree = workspaceTree(root, fs)
  if (tree.length > 0) parts.push(`Files (top two levels):\n${tree.join('\n')}`)
  return parts.join('\n\n')
}

/**
 * Which shell runs the approved lines, said the way a model needs it. Node's
 * `shell: true` is %ComSpec% (cmd.exe) on Windows and /bin/sh elsewhere, and
 * a model that assumes bash on Windows wastes turns on `ls`, `pwd`, `true`.
 */
export function shellNote(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') {
    const shell = (env.ComSpec ?? 'cmd.exe').split(/[\\/]/).pop() ?? 'cmd.exe'
    return (
      `Commands (ys_run_command, ys_process) run in Windows ${shell}, not bash: use dir, type, ` +
      'findstr, cd (no ls, cat, rm, pwd, grep, true), and backslashes in paths (cmd reads dir a/b as dir a /b). ' +
      'Node, npm and npx work as usual. ' +
      FILES_NOTE
    )
  }
  return `Commands (ys_run_command, ys_process) run in /bin/sh (POSIX shell). ${FILES_NOTE}`
}

/** Said with the shell: read-only and check commands run without asking;
 *  changing files belongs to the ys_ tools, which checkpoint; and where the
 *  processes it started are. */
const FILES_NOTE =
  'Read-only commands and the project\'s test, build and lint scripts run without asking, and so does a line ' +
  'chained with && when each part would; a piped or redirected line asks. To run in a subfolder, pass "cwd" ' +
  'instead of starting with cd. Change files with the ys_ tools (they keep a checkpoint), not with del, move, copy or mkdir. ' +
  'Commands cannot answer prompts: pass the non-interactive flag (--yes, -y, …); one that waits for input is stopped. ' +
  'Every process you start gets an id (c1 for a command, p1 for a background one) and its pid in the result, and ' +
  'ys_process {"action":"list"} shows them all; do not look for your processes with tasklist, Get-Process or ps, ' +
  'and never end a process that is not on that list.'
