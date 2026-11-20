import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { NOTES_FILE, createNoteTool, notesForContext, parseNotes, replaceSection } from './notes.ts'
import { nodeWriteFs } from './write-file.ts'
import { buildWorkspaceContext } from './workspace-context.ts'

describe('replaceSection', () => {
  test('adds a section to an empty file, under a title', () => {
    const text = replaceSection('', 'How to run', 'npm run dev, then open http://localhost:5173')
    assert.match(text, /^# Notes on this project/)
    assert.match(text, /## How to run\n\nnpm run dev, then open http:\/\/localhost:5173\n$/)
  })

  test('replaces one section and leaves the others, in order', () => {
    let text = replaceSection('', 'How to run', 'npm run dev')
    text = replaceSection(text, 'Layout', 'src/game.js holds the loop')
    text = replaceSection(text, 'how to RUN', 'npm start')
    assert.deepEqual(parseNotes(text).sections, [
      { title: 'How to run', body: 'npm start' },
      { title: 'Layout', body: 'src/game.js holds the loop' },
    ])
  })

  test('an empty text removes the section', () => {
    const text = replaceSection(replaceSection('', 'A', 'a'), 'B', 'b')
    assert.deepEqual(parseNotes(replaceSection(text, 'A', '  ')).sections.map((s) => s.title), ['B'])
  })

  test("keeps the person's own preamble", () => {
    const text = replaceSection('# My notes\n\nWritten by me.\n\n## Old\n\nx\n', 'New', 'y')
    assert.match(text, /^# My notes\n\nWritten by me\.\n\n## Old\n\nx\n\n## New\n\ny\n$/)
  })
})

describe('notesForContext', () => {
  test('whole sections up to the cap; the rest are named', () => {
    let text = ''
    for (const [title, size] of [['Run', 100], ['Layout', 900], ['Decisions', 900]] as const) text = replaceSection(text, title, 'x'.repeat(size))
    const note = notesForContext(text, 1_500)!
    assert.match(note, /## Run\n/)
    assert.match(note, /## Layout\n/)
    assert.doesNotMatch(note, /## Decisions/)
    assert.match(note, /\[Not shown: "Decisions"\. Read \.yellowscript\/NOTES\.md with ys_read_file\.\]/)
  })

  test('nothing to say without sections', () => {
    assert.equal(notesForContext(null), null)
    assert.equal(notesForContext('# Notes\n\nnothing yet\n'), null)
  })
})

describe('ys_note and the workspace message', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-notes-')))
  after(() => fs.rmSync(root, { recursive: true, force: true }))
  const ctx = { workspaceRoots: [root] }
  const tool = createNoteTool(nodeWriteFs)

  test('plans a reviewed write of .yellowscript/NOTES.md', async () => {
    const result = await tool.execute({ section: 'How to test', text: 'node tools/check.mjs --unit' }, ctx)
    assert.equal(result.isError, false, result.content)
    const change = result.pendingWrite!.changes[0]!
    assert.equal(change.path, '.yellowscript/NOTES.md')
    assert.equal(change.isNew, true)
    assert.match(change.after, /## How to test\n\nnode tools\/check\.mjs --unit/)
  })

  test('refuses a bad section name, and an empty removal of nothing', async () => {
    assert.equal((await tool.execute({ section: '## x', text: 'y' }, ctx)).isError, true)
    assert.equal((await tool.execute({ section: 'Missing', text: '' }, ctx)).pendingWrite, undefined)
  })

  test('the message order: instructions, notes, files', () => {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Use tabs.\n')
    fs.mkdirSync(path.join(root, '.yellowscript'), { recursive: true })
    fs.writeFileSync(path.join(root, NOTES_FILE), replaceSection('', 'How to test', 'node tools/check.mjs --unit'))
    fs.writeFileSync(path.join(root, 'game.js'), '')
    const message = buildWorkspaceContext(root)!
    const order = ['Use tabs.', '## How to test', 'Files (top two levels)'].map((s) => message.indexOf(s))
    assert.ok(order.every((i) => i > 0), message)
    assert.deepEqual([...order].sort((a, b) => a - b), order)
  })
})
