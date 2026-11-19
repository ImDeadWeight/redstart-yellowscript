// =============================================================================
// Tests for answers crossing the webview boundary (parseWebviewMessage).
// =============================================================================
// The webview is treated as untrusted input: an answer must be one of the
// shapes the session accepts, and anything else is dropped.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { parseWebviewMessage } from './protocol.ts'

const answer = (value: unknown) => parseWebviewMessage({ type: 'answer', id: 'q1', answer: value })

describe('answer messages', () => {
  test('a one-question reply: picks and/or text, trimmed', () => {
    assert.deepEqual(answer({ chosen: ['A'], text: '  why  ' }), { type: 'answer', id: 'q1', answer: { chosen: ['A'], text: 'why' } })
    assert.deepEqual(answer(null), { type: 'answer', id: 'q1', answer: null })
    assert.equal(answer({ chosen: [], text: ' ' }), null)
  })

  test('a several-question reply: one per question, null where not answered', () => {
    assert.deepEqual(answer({ answers: [{ chosen: ['Canvas'] }, null, { text: 'Bolt' }] }), {
      type: 'answer',
      id: 'q1',
      answer: { answers: [{ chosen: ['Canvas'] }, null, { text: 'Bolt' }] },
    })
  })

  test('an empty reply inside answers counts as not answered; all empty is no answer', () => {
    assert.deepEqual(answer({ answers: [{ text: '' }, { chosen: ['x'] }] })?.type, 'answer')
    assert.deepEqual((answer({ answers: [{ text: '' }, { chosen: ['x'] }] }) as { answer: unknown }).answer, { answers: [null, { chosen: ['x'] }] })
    assert.equal(answer({ answers: [null, { text: ' ' }] }), null)
  })

  test('at most four answers, and nothing but picks and text', () => {
    const parsed = answer({ answers: [{ text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }, { text: '5' }] }) as { answer: { answers: unknown[] } }
    assert.equal(parsed.answer.answers.length, 4)
    const stripped = answer({ answers: [{ text: 'a', evil: '<script>' }] }) as { answer: { answers: unknown[] } }
    assert.deepEqual(stripped.answer.answers, [{ text: 'a' }])
  })
})
