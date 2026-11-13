import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { EMPTY_CONVERSATION_STATE, PROTOCOL_VERSION, type HostMessage } from '../chat/protocol.ts'
import {
  applyHostMessage,
  argumentsPreview,
  buildAnswer,
  composerPlaceholder,
  initialViewState,
  matchWorkflows,
  planProgress,
  slashQuery,
  type ViewState,
} from './view-model.ts'

const connected = { connection: 'connected' as const, detail: 'ok', canSend: true, busy: false, queued: 0 }

function run(...messages: HostMessage[]): ViewState {
  return messages.reduce(applyHostMessage, initialViewState())
}

const init = (over: Partial<Extract<HostMessage, { type: 'init' }>> = {}): HostMessage => ({
  type: 'init',
  protocolVersion: PROTOCOL_VERSION,
  session: connected,
  messages: [],
  conversationId: 'c1',
  state: EMPTY_CONVERSATION_STATE,
  ...over,
})

describe('applyHostMessage', () => {
  test('init replaces everything; a different protocol marks the panel stale', () => {
    const s = run(init({ messages: [{ id: 'm1', role: 'user', content: 'hi' }] }))
    assert.equal(s.messages.length, 1)
    assert.equal(s.conversationId, 'c1')
    assert.equal(run(init({ protocolVersion: PROTOCOL_VERSION - 1 })).stale, true)
  })

  test('streams deltas into the right turn, and drops another tab\'s', () => {
    const s = run(
      init(),
      { type: 'message', conversationId: 'c1', message: { id: 't1', role: 'assistant', content: '', streaming: true } },
      { type: 'turn/delta', conversationId: 'c1', id: 't1', channel: 'content', text: 'Hel' },
      { type: 'turn/delta', conversationId: 'c1', id: 't1', channel: 'content', text: 'lo' },
      { type: 'turn/delta', conversationId: 'c1', id: 't1', channel: 'reasoning', text: 'hmm' },
      { type: 'turn/delta', conversationId: 'other', id: 't1', channel: 'content', text: 'NO' },
      { type: 'turn/completed', conversationId: 'c1', id: 't1', stats: { tokensPerSecond: 12 } },
    )
    assert.equal(s.messages[0]?.content, 'Hello')
    assert.equal(s.messages[0]?.reasoning, 'hmm')
    assert.equal(s.messages[0]?.streaming, false)
    assert.equal(s.messages[0]?.stats?.tokensPerSecond, 12)
  })

  test('a queued prompt with the same id updates in place', () => {
    const s = run(
      init(),
      { type: 'message', conversationId: 'c1', message: { id: 'u2', role: 'user', content: 'next', pending: true } },
      { type: 'message', conversationId: 'c1', message: { id: 'u2', role: 'user', content: 'next', pending: false } },
    )
    assert.equal(s.messages.length, 1)
    assert.equal(s.messages[0]?.pending, false)
  })

  test('tool calls become cards on their turn and finish with their result', () => {
    const s = run(
      init(),
      { type: 'message', conversationId: 'c1', message: { id: 't1', role: 'assistant', content: '' } },
      { type: 'tool/call', conversationId: 'c1', turnId: 't1', callId: 'k1', name: 'ws_read_file', arguments: '{"path":"a.ts"}', recovered: false },
      { type: 'tool/call', conversationId: 'c1', turnId: 't1', callId: 'k1', name: 'ws_read_file', arguments: '{}', recovered: false },
      { type: 'tool/result', conversationId: 'c1', turnId: 't1', callId: 'k1', name: 'ws_read_file', summary: 'a.ts, 10 lines', isError: false, truncated: false },
    )
    assert.equal(s.messages[0]?.tools?.length, 1, 'a repeated call id is one card')
    assert.equal(s.messages[0]?.tools?.[0]?.status, 'done')
    assert.equal(s.messages[0]?.tools?.[0]?.summary, 'a.ts, 10 lines')
  })

  test('conversation state follows the active tab only', () => {
    const question = { id: 'q', question: 'Which?', multiSelect: false }
    const s = run(
      init(),
      { type: 'conversationState', conversationId: 'other', state: { question, plan: null, atTurnLimit: false } },
    )
    assert.equal(s.conversation.question, null)
    const t = applyHostMessage(s, { type: 'conversationState', conversationId: 'c1', state: { question, plan: null, atTurnLimit: false } })
    assert.equal(t.conversation.question?.question, 'Which?')
  })

  test('switching tabs then receiving the conversation repaints it', () => {
    const s = run(
      init(),
      { type: 'activeConversationChanged', id: 'c2' },
      { type: 'conversation', conversationId: 'c2', messages: [{ id: 'x', role: 'user', content: 'two' }], state: EMPTY_CONVERSATION_STATE },
    )
    assert.equal(s.conversationId, 'c2')
    assert.equal(s.messages[0]?.content, 'two')
  })
})

describe('helpers', () => {
  test('placeholder says what typing will do', () => {
    const s = run(init())
    assert.equal(composerPlaceholder(s), 'Ask Yellowscript…')
    const asking = { ...s, conversation: { ...s.conversation, question: { id: 'q', question: '?', multiSelect: false } } }
    assert.match(composerPlaceholder(asking), /answer/)
  })

  test('planProgress counts done and skipped as finished', () => {
    assert.deepEqual(planProgress([{ status: 'done' }, { status: 'skipped' }, { status: 'pending' }]), { open: 1, label: '2 of 3 done' })
  })

  test('argumentsPreview shows a lone path by itself and cuts long lines', () => {
    assert.equal(argumentsPreview('{"path":"src/a.ts"}'), 'src/a.ts')
    assert.equal(argumentsPreview('{"pattern":"x","glob":"*.ts"}'), 'pattern: x, glob: *.ts')
    assert.equal(argumentsPreview('{}'), '')
    assert.equal(argumentsPreview('not json'), 'not json')
    assert.ok(argumentsPreview(JSON.stringify({ a: 'x'.repeat(200) })).endsWith('…'))
  })

  test('buildAnswer needs a pick or text', () => {
    assert.equal(buildAnswer([], '  '), null)
    assert.deepEqual(buildAnswer(['A'], ''), { chosen: ['A'] })
    assert.deepEqual(buildAnswer([], ' mine '), { text: 'mine' })
  })
})

describe('projects, workflows and pages', () => {
  test('pages, project lists and workflow lists come from the host', () => {
    const s = run(
      init(),
      { type: 'showPage', page: 'projects' },
      { type: 'projects', projects: [{ id: 'p1', name: 'Greenhouse' }], linkedId: 'p1' },
      { type: 'workflows', workflows: [], error: 'No connection' },
    )
    assert.equal(s.page, 'projects')
    assert.equal(s.projects.items?.[0]?.name, 'Greenhouse')
    assert.equal(s.projects.linkedId, 'p1')
    assert.equal(s.workflows.error, 'No connection')
  })

  test('slashQuery reads a /command only at the start, with nothing after it', () => {
    assert.equal(slashQuery('/'), '')
    assert.equal(slashQuery('/week'), 'week')
    assert.equal(slashQuery('/weekly-report'), 'weekly-report')
    assert.equal(slashQuery('/weekly report'), null)
    assert.equal(slashQuery('see /weekly'), null)
  })

  test('matchWorkflows ranks prefix matches before contains matches', () => {
    const w = (name: string, title: string) => ({ name, title, arguments: [] })
    const list = [w('notes-to-report', 'Turn notes into a report'), w('report', 'Weekly report'), w('standup', 'Daily standup')]
    assert.deepEqual(matchWorkflows(list, 'rep').map((x) => x.name), ['report', 'notes-to-report'])
    assert.equal(matchWorkflows(list, '').length, 3)
  })
})
