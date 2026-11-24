import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { EMPTY_CONVERSATION_STATE, PROTOCOL_VERSION, type HostMessage } from '../chat/protocol.ts'
import {
  commandView,
  contextMeter,
  waitingNote,
  applyHostMessage,
  atQuery,
  fitWithin,
  argumentsPreview,
  buildAnswer,
  composerPlaceholder,
  initialViewState,
  latestTaskId,
  matchWorkflows,
  planProgress,
  serverUrlProblem,
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
  surface: 'sidebar',
  ...over,
})

describe('applyHostMessage', () => {
  test('init says whether this view is the sidebar or an editor tab', () => {
    assert.equal(run(init()).surface, 'sidebar')
    assert.equal(run(init({ surface: 'editor' })).surface, 'editor')
  })

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
      { type: 'tool/call', conversationId: 'c1', turnId: 't1', callId: 'k1', name: 'ys_read_file', arguments: '{"path":"a.ts"}', recovered: false },
      { type: 'tool/call', conversationId: 'c1', turnId: 't1', callId: 'k1', name: 'ys_read_file', arguments: '{}', recovered: false },
      { type: 'tool/result', conversationId: 'c1', turnId: 't1', callId: 'k1', name: 'ys_read_file', summary: 'a.ts, 10 lines', isError: false, truncated: false },
    )
    assert.equal(s.messages[0]?.tools?.length, 1, 'a repeated call id is one card')
    assert.equal(s.messages[0]?.tools?.[0]?.status, 'done')
    assert.equal(s.messages[0]?.tools?.[0]?.summary, 'a.ts, 10 lines')
  })

  test('a result\'s effect is added to its turn\'s run, for the task summary', () => {
    const effect = { kind: 'write' as const, applied: true, files: [{ path: 'a.ts', isNew: false, isDeleted: false }] }
    const s = run(
      init(),
      { type: 'message', conversationId: 'c1', message: { id: 't1', role: 'assistant', content: '' } },
      { type: 'tool/call', conversationId: 'c1', turnId: 't1', callId: 'k1', name: 'ys_replace', arguments: '{}', recovered: false },
      { type: 'tool/result', conversationId: 'c1', turnId: 't1', callId: 'k1', name: 'ys_replace', summary: 'applied', isError: false, truncated: false, effect },
      { type: 'tool/result', conversationId: 'c1', turnId: 't1', callId: 'k2', name: 'ys_read_file', summary: 'read', isError: false, truncated: false },
    )
    assert.deepEqual(s.messages[0]?.run, [effect])
  })

  test('only the newest task with a checkpointed write offers Revert', () => {
    const write = (checkpoint: boolean) => ({
      kind: 'write' as const, applied: true, files: [{ path: 'a.ts', isNew: false, isDeleted: false }],
      ...(checkpoint ? { checkpoint: { revision: 'r', root: '/w' } } : {}),
    })
    assert.equal(latestTaskId([
      { id: 'a1', role: 'assistant', content: '', run: [write(true)] },
      { id: 'a2', role: 'assistant', content: '', run: [write(true)] },
      { id: 'a3', role: 'assistant', content: '', run: [write(false)] },
      { id: 'a4', role: 'assistant', content: 'just talk' },
    ]), 'a2')
    assert.equal(latestTaskId([{ id: 'u', role: 'user', content: 'hi' }]), null)
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

describe('attachments in the composer', () => {
  test('the @ query at the caret', () => {
    assert.equal(atQuery('look at @src/ga'), 'src/ga')
    assert.equal(atQuery('@'), '')
    assert.equal(atQuery('mail me@example.com'), null, 'not inside a word')
    assert.equal(atQuery('look at @src/game.js now'), null)
  })

  test('downscaled to 1,280px on the longer edge', () => {
    assert.deepEqual(fitWithin(2560, 1440), { width: 1280, height: 720 })
    assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 })
  })

  test('file matches and chips from the host land in the view state', () => {
    const s = run(
      init(),
      { type: 'fileMatches', query: 'ga', paths: ['src/game.js'] },
      { type: 'addAttachment', attachment: { kind: 'selection', path: 'a.js', startLine: 1, endLine: 2, text: 'x' } },
    )
    assert.deepEqual(s.fileMatches, { query: 'ga', paths: ['src/game.js'] })
    assert.equal(s.inbox.length, 1)
  })
})

describe('connection details', () => {
  test('a Nest address: empty means discovery, a bare host gets http://, junk is refused', () => {
    assert.equal(serverUrlProblem(''), null)
    assert.equal(serverUrlProblem('192.168.1.20:19080'), null)
    assert.equal(serverUrlProblem('https://nest.example.com'), null)
    assert.equal(serverUrlProblem('http://'), 'That is not a valid URL.')
    assert.equal(serverUrlProblem('not a url'), 'That is not a valid URL.')
  })
})

describe('context meter and waiting note', () => {
  test('meter: a fraction of the window, levelled; unknown window shows tokens', () => {
    assert.deepEqual(
      { ...contextMeter({ used: 16_000, size: 32_000 })!, title: undefined },
      { fraction: 0.5, label: '50%', level: 'ok', title: undefined },
    )
    assert.equal(contextMeter({ used: 20_000, size: 32_000 })!.level, 'high')
    assert.equal(contextMeter({ used: 30_000, size: 32_000 })!.level, 'full')
    assert.equal(contextMeter({ used: 12_345, size: null })!.label, '12k')
    assert.match(contextMeter({ used: 1, size: 10, trimmed: 2 })!.title, /trimmed to fit 2 times/)
    assert.equal(contextMeter(null), null)
  })

  test('waiting: quiet for under 3s says nothing; long waits name the likely cause', () => {
    assert.equal(waitingNote(2_999, false), null)
    assert.equal(waitingNote(5_000, false), 'Waiting for the model · 5s')
    assert.match(waitingNote(4_000, true)!, /read the result/)
    assert.match(waitingNote(20_000, false)!, /busy with another request/)
  })
})

describe('commandView', () => {
  test('a run: command in, status and output out', () => {
    const v = commandView({
      name: 'ys_run_command',
      arguments: '{"command":"npm test","cwd":"pkg"}',
      output: 'Exit code 1 · 2.0s\n--- stdout ---\nfail: 1\n--- stderr ---\nboom',
    })!
    assert.deepEqual(v, {
      command: 'npm test',
      cwd: 'pkg',
      background: false,
      read: false,
      status: 'Exit code 1 · 2.0s',
      output: 'fail: 1\n--- stderr ---\nboom',
    })
  })

  test('still running: no status, no output', () => {
    const v = commandView({ name: 'ys_run_command', arguments: '{"command":"npm test"}' })!
    assert.equal(v.status, undefined)
    assert.equal(v.output, '')
  })

  test('process start and output reads are commands; list and stop are not', () => {
    assert.equal(commandView({ name: 'ys_process', arguments: '{"action":"start","command":"npm run dev"}' })!.background, true)
    const read = commandView({ name: 'ys_process', arguments: '{"action":"output","id":"p1"}', output: 'p1 (npm run dev) is running.\n(no new output)' })!
    assert.equal(read.command, 'output of p1')
    assert.equal(read.output, '')
    assert.equal(commandView({ name: 'ys_process', arguments: '{"action":"list"}' }), null)
    assert.equal(commandView({ name: 'ys_read_file', arguments: '{}' }), null)
  })
})
