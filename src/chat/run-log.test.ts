import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { RUN_LOG_CAP, RUN_LOG_HEADER, collapsedRunLog, formatRunLog, runLogLines } from './run-log.ts'
import type { ToolEffect } from '../tools/types.ts'

const write = (files: [string, 'new' | 'changed' | 'deleted'][], applied = true): ToolEffect => ({
  kind: 'write',
  applied,
  files: files.map(([path, state]) => ({ path, isNew: state === 'new', isDeleted: state === 'deleted' })),
})
const ran = (command: string, exitCode: number | null, extra: Partial<Extract<ToolEffect, { kind: 'command' }>> = {}): ToolEffect => ({
  kind: 'command', command, ran: true, exitCode, ...extra,
})

describe('runLogLines', () => {
  test('one line per kind of action, in a fixed order', () => {
    const lines = runLogLines([
      write([['src/game.js', 'new'], ['src/art.js', 'new']]),
      write([['index.html', 'changed']]),
      write([['assets/logo.png', 'new'], ['img/logo.png', 'deleted']]),
      ran('npm test', 1, { failed: true, lastLine: '2 failing' }),
      ran('npm run dev', null, { processId: 'p1', url: 'http://localhost:5173' }),
      { kind: 'check', target: 'http://localhost:5173', problems: 1, first: 'player is undefined' },
    ])
    assert.deepEqual(lines, [
      'created src/game.js, src/art.js; changed index.html',
      'moved img/logo.png → assets/logo.png',
      'ran `npm test` → exit 1 (2 failing)',
      'started p1 `npm run dev` → http://localhost:5173',
      'checked http://localhost:5173 → 1 problem: player is undefined',
    ])
  })

  test('paths are listed once: a created file edited later is still "created"', () => {
    const lines = runLogLines([write([['a.js', 'new']]), write([['a.js', 'changed']]), write([['b.js', 'changed']]), write([['b.js', 'changed']])])
    assert.deepEqual(lines, ['created a.js; changed b.js'])
  })

  test('a file created and deleted in one run is not mentioned', () => {
    assert.deepEqual(runLogLines([write([['tmp.js', 'new']]), write([['tmp.js', 'deleted']])]), [])
  })

  test('rejected writes and commands say they did NOT happen', () => {
    const lines = runLogLines([
      write([['a.js', 'changed']], false),
      { kind: 'command', command: 'rm -rf dist', ran: false, exitCode: null },
    ])
    assert.deepEqual(lines, ['rejected, NOT written: a.js', 'rejected, NOT run: `rm -rf dist`'])
  })

  test('only the last page check is kept', () => {
    const lines = runLogLines([
      { kind: 'check', target: 'index.html', problems: 2, first: 'x is not defined' },
      { kind: 'check', target: 'index.html', problems: 0, first: null },
    ])
    assert.deepEqual(lines, ['checked index.html → no problems'])
  })

  test('a start that exited, and a stop', () => {
    const lines = runLogLines([ran('npm run dev', 1, { processId: 'p1', failed: true }), { kind: 'stop', processId: 'p2' }])
    assert.deepEqual(lines, ['started p1 `npm run dev` → exited 1', 'stopped p2'])
  })

  test('long lists are cut with a count', () => {
    const many = Array.from({ length: 12 }, (_, i) => [`f${i}.js`, 'new'] as [string, 'new'])
    assert.match(runLogLines([write(many)])[0]!, /f7\.js and 4 more$/)
    const commands = Array.from({ length: 6 }, (_, i) => ran(`step ${i}`, 0))
    assert.equal(runLogLines(commands)[0], 'ran `step 2` → exit 0; `step 3` → exit 0; `step 4` → exit 0; `step 5` → exit 0 (and 2 earlier)')
  })
})

describe('formatRunLog', () => {
  test('null when the run changed nothing', () => {
    assert.equal(formatRunLog([]), null)
  })

  test('starts with the header', () => {
    assert.equal(formatRunLog([write([['a.js', 'new']])]), `${RUN_LOG_HEADER}\ncreated a.js`)
  })

  test('stays under the cap, dropping the earliest lines with a count', () => {
    const long = 'x'.repeat(150)
    const effects: ToolEffect[] = [
      write([[`${long}1.js`, 'new']]),
      write([[`${long}2.js`, 'new'], [`${long}3.js`, 'deleted']]),
      write([[`${long}4.js`, 'changed']], false),
      ran(`${long} test`, 0),
      { kind: 'check', target: `${long}.html`, problems: 0, first: null },
    ]
    const log = formatRunLog(effects)!
    assert.ok(log.length <= RUN_LOG_CAP + 40, `${log.length}`)
    assert.match(log, /earlier lines? not shown/)
    assert.match(log, /checked .* → no problems$/, 'the newest lines are kept')
  })
})

describe('collapsedRunLog', () => {
  test('counts what happened, in one line', () => {
    assert.equal(
      collapsedRunLog([write([['a.js', 'new'], ['b.js', 'changed']]), write([['a.js', 'changed']]), ran('npm test', 0), ran('npm test', 1), write([['c.js', 'new']], false)]),
      '[Earlier run: wrote 2 files, ran 2 commands, 1 rejected]',
    )
  })

  test('null when nothing changed', () => {
    assert.equal(collapsedRunLog([{ kind: 'check', target: 'a.html', problems: 0, first: null }]), null)
  })
})
