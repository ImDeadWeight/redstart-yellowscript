// Session 1 must record the test command in .yellowscript/NOTES.md; session 2,
// a new conversation that sees only the workspace (notes included), must run
// it without looking the command up again.
import { exists, expect, pass, read, result } from '../_lib/check.mjs'

const notesFile = '.yellowscript/NOTES.md'
expect(exists(notesFile), 'no notes were kept (.yellowscript/NOTES.md does not exist)')
const notes = read(notesFile)
expect(/tools[\\/]check\.mjs/.test(notes) && /--suite\s+unit/.test(notes), `the notes do not record the command:\n${notes.slice(0, 400)}`)

const messages = result.messages ?? []
expect(messages.length === 2, `expected two sessions' runs, got ${messages.length}`)
const second = messages[1].calls
const ran = second.some((c) => c.name === 'ys_run_command' && /tools[\\/]check\.mjs/.test(c.args) && /--suite\s+unit/.test(c.args))
expect(ran, `session 2 did not run the unit suite: ${second.map((c) => c.name).join(', ') || 'no calls'}`)
const lookedUp = second.filter((c) =>
  ['ys_grep', 'ys_glob', 'ys_list_directory'].includes(c.name) ||
  (c.name === 'ys_read_file' && /CONTRIBUTING|README|check\.mjs|package\.json/i.test(c.args)) ||
  (c.name === 'ys_run_command' && /\b(type|cat|dir|ls|findstr|grep)\b/.test(c.args)))
expect(lookedUp.length === 0, `session 2 looked the command up again: ${lookedUp.map((c) => `${c.name} ${c.args}`).join('; ').slice(0, 300)}`)
expect(/\b4\b/.test(result.answer ?? ''), `the answer does not say 4 passed: ${(result.answer ?? '').slice(0, 200)}`)
pass('the command was in the notes, and session 2 ran it straight away')
