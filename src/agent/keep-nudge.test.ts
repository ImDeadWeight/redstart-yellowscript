// The keep-it reminder (keep-nudge.ts) against the steered Crestline run.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { MAX_NUDGES, createKeepNudge } from './keep-nudge.ts'
import { callInfo } from './loop.ts'

const cmd = (command: string) => callInfo('ys_run_command', JSON.stringify({ command, cwd: 'Crestline' }))
const fail = (text: string) => ({ ok: false, text })
const ok = { ok: true, text: 'Exit code 0' }

describe('keep-nudge', () => {
  test('a command that works after failing asks for a note, once', () => {
    const keep = createKeepNudge()
    keep.observe(cmd('npx sv add vitest --no-install'), fail('It ended on a prompt nobody could answer ("Verifications failed. Do you wish to continue?")'))
    keep.observe(cmd('npx sv add vitest --no-install --no-git-check'), fail('It ended on a prompt nobody could answer ("What do you want to use vitest for?")'))
    assert.equal(keep.take(), null, 'nothing before it works')
    keep.observe(cmd('npx sv add vitest="usages:unit" --no-install --no-git-check'), ok)
    const note = keep.take()
    assert.ok(note)
    assert.match(note, /npx sv add/)
    assert.match(note, /2 failed tries/)
    assert.match(note, /usages:unit/)
    assert.match(note, /ys_note/)
    assert.equal(keep.take(), null, 'taken once')
  })

  test('a command that worked first time asks nothing', () => {
    const keep = createKeepNudge()
    keep.observe(cmd('npm install'), ok)
    assert.equal(keep.take(), null)
  })

  test('a note written stops the reminders', () => {
    const keep = createKeepNudge()
    keep.observe(cmd('npx sv create . --yes'), fail('error: unknown option --yes'))
    keep.observe(cmd('npx sv create .'), ok)
    keep.observe(callInfo('ys_note', JSON.stringify({ section: 'How to run', text: 'sv create has no --yes' })), ok)
    assert.equal(keep.take(), null)
    assert.equal(keep.take([{ status: 'done' }]), null)
  })

  test('a closed plan after a recovery asks once, if the recovery note was not already used up', () => {
    const keep = createKeepNudge()
    keep.observe(cmd('npm run check'), fail('Error: Unexpected token'))
    keep.observe(cmd('npm run check'), ok)
    assert.ok(keep.take([{ status: 'in_progress' }]))
    assert.match(keep.take([{ status: 'done' }, { status: 'skipped' }]) ?? '', /Every step of the plan is closed/)
    assert.equal(keep.take([{ status: 'done' }]), null)
  })

  test(`no more than ${MAX_NUDGES} a run`, () => {
    const keep = createKeepNudge()
    let taken = 0
    for (const tool of ['a', 'b', 'c', 'd']) {
      keep.observe(cmd(`npx ${tool} run`), fail('Error: no'))
      keep.observe(cmd(`npx ${tool} run --fixed`), ok)
      if (keep.take()) taken++
    }
    if (keep.take([{ status: 'done' }])) taken++
    assert.equal(taken, MAX_NUDGES)
  })

  test('off: silent', () => {
    const keep = createKeepNudge(false)
    keep.observe(cmd('npx sv create . --yes'), fail('error: unknown option --yes'))
    keep.observe(cmd('npx sv create .'), ok)
    assert.equal(keep.take([{ status: 'done' }]), null)
  })

  test('a refused or declined command is not a failure', () => {
    const keep = createKeepNudge()
    keep.observe(cmd('npm run check'), { ok: false, refused: 'repeated' })
    keep.observe(cmd('npm run check'), { ok: false, rejected: true })
    keep.observe(cmd('npm run check'), ok)
    assert.equal(keep.take(), null)
  })
})
