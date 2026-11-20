// =============================================================================
// ys_note — the model's working knowledge of this project, kept on disk.
// =============================================================================
// `.yellowscript/NOTES.md`, plain markdown with `## section` headings, sent
// with the workspace message on every request (after AGENTS.md). The model
// keeps it with one tool that replaces one named section, so the file stays
// short and current instead of growing into a log:
//
//   belongs   how to run, build and check this project; where things live;
//             decisions and why; known problems
//   does not  anything about the person (Nest's memory), the plan
//             (update_plan), what one run did (the run log)
//
// The write goes through the same review as any other write; "Apply all in
// this task" covers it. Whether .yellowscript/ is committed is the person's
// call in .gitignore.
//
// No `vscode` import.
// =============================================================================

import * as path from 'node:path'

import { assertWorkspaceToolName, stringArg, toolError, toolOk, type PendingWrite, type Tool, type ToolContext, type ToolResult } from './types.ts'
import { previewOf, type WriteFs } from './write-file.ts'

export const NOTES_FILE = path.join('.yellowscript', 'NOTES.md')
/** What the workspace message carries of the notes at most. */
export const MAX_NOTES_CHARS = 1_500
const NOTES_TITLE = '# Notes on this project\n\nKept by Yellowscript with ys_note; edit freely.\n'

interface Section {
  title: string
  body: string
}

/** The file's preamble and its `## ` sections, in order. */
export function parseNotes(text: string): { preamble: string; sections: Section[] } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const sections: Section[] = []
  const preamble: string[] = []
  let current: { title: string; lines: string[] } | null = null
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      if (current) sections.push({ title: current.title, body: current.lines.join('\n').trim() })
      current = { title: heading[1]!, lines: [] }
    } else if (current) {
      current.lines.push(line)
    } else {
      preamble.push(line)
    }
  }
  if (current) sections.push({ title: current.title, body: current.lines.join('\n').trim() })
  return { preamble: preamble.join('\n').trim(), sections }
}

function render(preamble: string, sections: readonly Section[]): string {
  const parts = [preamble || NOTES_TITLE.trim(), ...sections.map((s) => `## ${s.title}\n\n${s.body}`)]
  return `${parts.join('\n\n')}\n`
}

/** The notes with `section` replaced by `body` (added at the end if new);
 *  an empty body removes it. Section names match case-insensitively. */
export function replaceSection(text: string, section: string, body: string): string {
  const { preamble, sections } = parseNotes(text)
  const key = section.trim().toLowerCase()
  const at = sections.findIndex((s) => s.title.toLowerCase() === key)
  const cleaned = body.trim()
  if (cleaned === '') {
    if (at >= 0) sections.splice(at, 1)
  } else if (at >= 0) {
    sections[at] = { title: sections[at]!.title, body: cleaned }
  } else {
    sections.push({ title: section.trim(), body: cleaned })
  }
  return render(preamble, sections)
}

/**
 * The notes as the workspace message carries them: whole sections, in order,
 * up to `cap`; the ones left out are named so the model can read the file.
 * Null when there are none.
 */
export function notesForContext(text: string | null, cap = MAX_NOTES_CHARS): string | null {
  if (!text) return null
  const { sections } = parseNotes(text)
  if (sections.length === 0) return null
  const kept: string[] = []
  const left: string[] = []
  let used = 0
  for (const s of sections) {
    const block = `## ${s.title}\n${s.body}`
    if (used + block.length > cap && kept.length > 0) {
      left.push(s.title)
      continue
    }
    kept.push(block.length > cap ? `${block.slice(0, cap)}…` : block)
    used += block.length
  }
  const more = left.length ? `\n\n[Not shown: ${left.map((t) => `"${t}"`).join(', ')}. Read ${NOTES_FILE.replace(/\\/g, '/')} with ys_read_file.]` : ''
  return `Your notes on this project (${NOTES_FILE.replace(/\\/g, '/')}; keep them current with ys_note):\n\n${kept.join('\n\n')}${more}`
}

export function createNoteTool(fs: WriteFs): Tool {
  return {
    definition: {
      name: assertWorkspaceToolName('ys_note'),
      description:
        "Keep a section of this project's notes, sent with every request: how to run and check it, where things live, " +
        'decisions and why, known problems. Not the plan, not what one run did. text "" removes the section.',
      inputSchema: {
        type: 'object',
        properties: {
          section: { type: 'string', description: 'e.g. "How to run".' },
          text: { type: 'string', description: 'The whole section, replacing what it said.' },
        },
        required: ['section', 'text'],
        additionalProperties: false,
      },
    },
    async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
      const root = context.workspaceRoots[0]
      if (!root) return toolError('No workspace folder is open, so there is nowhere to keep notes.')
      const section = stringArg(args, 'section')?.trim()
      const text = stringArg(args, 'text')
      if (!section) return toolError('ys_note requires a "section" name.')
      if (text === null) return toolError('ys_note requires "text" (use "" to remove the section).')
      if (/[\r\n]/.test(section) || section.startsWith('#')) return toolError('The section name is one line, without "#".')

      const absolutePath = path.join(root, NOTES_FILE)
      const exists = fs.exists(absolutePath)
      const before = exists ? fs.read(absolutePath) : ''
      if (!exists && text.trim() === '') return toolOk(`There is no "${section}" section to remove.`, `ys_note — ${section}: nothing to remove`)
      const after = replaceSection(before, section, text)
      if (after === before) return toolOk(`The "${section}" section already says that.`, `ys_note — ${section}: unchanged`)

      const preview = previewOf({ relativePath: NOTES_FILE, absolutePath, isNew: !exists, isDeleted: false, before, after }, context.workspaceRoots)
      const pending: PendingWrite = { label: `notes: ${section}`, changes: [preview] }
      const verb = text.trim() === '' ? 'remove' : 'update'
      return toolOk(
        `Proposed: ${verb} the "${section}" section of ${preview.path} (pending review).`,
        `ys_note — ${verb} "${section}" (pending approval)`,
        false,
        pending,
      )
    },
  }
}
