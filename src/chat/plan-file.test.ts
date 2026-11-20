// =============================================================================
// Tests for the plan's file format (.yellowscript/PLAN.md).
// =============================================================================

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { formatPlanFile, hasOpenSteps, parsePlanFile } from './plan-file.ts'
import type { PlanStep } from '../agent/agent-core.ts'

const steps: PlanStep[] = [
  { text: 'Scaffold the canvas', status: 'done' },
  { text: 'Player movement', status: 'in_progress', note: 'left/right done,\njump next' },
  { text: 'Rolling hazards', status: 'pending' },
  { text: 'Sound', status: 'skipped' },
]

describe('plan file', () => {
  test('round-trips every status and the notes', () => {
    const text = formatPlanFile(steps)
    assert.match(text, /^# Yellowscript plan/)
    assert.match(text, /- \[x\] Scaffold the canvas\n- \[~\] Player movement\n  > left\/right done, jump next\n- \[ \] Rolling hazards\n- \[-\] Sound\n/)
    assert.deepEqual(parsePlanFile(text), [
      steps[0],
      { ...steps[1]!, note: 'left/right done, jump next' },
      steps[2],
      steps[3],
    ])
  })

  test('reads a hand-edited file: other bullets, capital X, CRLF, stray lines', () => {
    const text = '# My plan\r\n\r\nSome prose.\r\n* [X] Done by hand\r\n- [ ] Still to do\r\n  > why it matters\r\n- not a task\r\n'
    assert.deepEqual(parsePlanFile(text), [
      { text: 'Done by hand', status: 'done' },
      { text: 'Still to do', status: 'pending', note: 'why it matters' },
    ])
  })

  test('a file with no tasks is no plan', () => {
    assert.equal(parsePlanFile('# Nothing here\n'), null)
  })

  test('only open steps carry a plan into a new conversation', () => {
    assert.equal(hasOpenSteps(steps), true)
    assert.equal(hasOpenSteps([{ text: 'a', status: 'done' }, { text: 'b', status: 'skipped' }]), false)
    assert.equal(hasOpenSteps(null), false)
  })
})
