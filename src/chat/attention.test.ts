import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { AttentionTracker, waitingFor } from './attention.ts'
import { EMPTY_CONVERSATION_STATE, type ConversationState } from './protocol.ts'

const approval = { id: 'a1', kind: 'command' as const, title: 'Run a command', subject: 'npm i', options: [], queued: 0 }
const state = (over: Partial<ConversationState>): ConversationState => ({ ...EMPTY_CONVERSATION_STATE, ...over })

describe('waitingFor', () => {
  test('approval, then question, then the turn limit', () => {
    assert.equal(waitingFor(state({ approval })), 'an approval')
    assert.equal(waitingFor(state({ question: { id: 'q', question: 'Which?', multiSelect: false } })), 'an answer')
    assert.equal(waitingFor(state({ atTurnLimit: true })), 'a go-ahead at the turn limit')
    assert.equal(waitingFor(EMPTY_CONVERSATION_STATE), null)
  })
})

describe('AttentionTracker', () => {
  test('says it once, when a conversation starts waiting', () => {
    const t = new AttentionTracker()
    assert.equal(t.update('c1', state({ approval })), 'an approval')
    assert.equal(t.update('c1', state({ approval })), null, 'still waiting is not news')
    assert.equal(t.count, 1)
    assert.equal(t.update('c1', EMPTY_CONVERSATION_STATE), null)
    assert.equal(t.count, 0)
    assert.equal(t.update('c1', state({ approval })), 'an approval', 'a new wait is news again')
  })

  test('counts every waiting conversation, and names the first', () => {
    const t = new AttentionTracker()
    t.update('c1', state({ approval }))
    t.update('c2', state({ atTurnLimit: true }))
    assert.equal(t.count, 2)
    assert.equal(t.firstWaiting(), 'c1')
    t.forget('c1')
    assert.equal(t.firstWaiting(), 'c2')
  })

  test('times a run', () => {
    const t = new AttentionTracker()
    t.runStarted('c1', 1_000)
    assert.equal(t.runEnded('c1', 181_000), 180_000)
    assert.equal(t.runEnded('c1', 200_000), null, 'only once')
  })
})
