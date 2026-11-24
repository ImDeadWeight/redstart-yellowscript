// =============================================================================
// Tests for the sessions host: sending, titling, persisting, the snapshot, and
// what a run's messages set off. Real ChatSessions against a fake client.
// =============================================================================

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { ConnectionState } from '../connection.ts'
import { ChatSession } from '../chat/session.ts'
import { EMPTY_CONVERSATION_STATE, type HostMessage } from '../chat/protocol.ts'
import type { NestClient, StreamResult } from '../nest/client.ts'
import type { Surface } from '../ui/chat-view.ts'
import { conversationStore } from '../ui/conversation-store.ts'
import type { PlanStep } from '../agent/agent-core.ts'
import type { SessionHooks } from '../agent/compose.ts'
import { createSessions, titleFor } from './sessions.ts'

function memento() {
  const data = new Map<string, unknown>()
  return { get: <T>(key: string) => data.get(key) as T | undefined, update: async (key: string, value: unknown) => void data.set(key, value), keys: () => [...data.keys()] }
}

const replies = (content: string): NestClient =>
  ({
    streamChatCompletion: async (_request: unknown, handlers: { onContent?: (c: string) => void }) => {
      handlers.onContent?.(content)
      return { content, reasoning: '', toolCalls: [], aborted: false } satisfies StreamResult
    },
  }) as unknown as NestClient

function setup(options: { state?: ConnectionState; plan?: PlanStep[] | null } = {}) {
  const conversations = conversationStore(memento() as never)
  const posted: Array<{ id: string; message: HostMessage }> = []
  const events: string[] = []
  const logs: string[] = []
  const hooks = new Map<string, SessionHooks>()
  const opened: Surface[] = []
  const sessions = createSessions({
    connection: { state: options.state ?? ({ status: 'connected', url: 'http://nest:19080' } as ConnectionState), activeClient: null },
    conversations,
    views: {
      post: (id, message) => void posted.push({ id, message }),
      conversationsChanged: () => void events.push('conversations'),
      sessionsChanged: () => void events.push('sessions'),
      conversationOn: (surface) => {
        if (!surface.conversationId) {
          surface.conversationId = conversations.create('New chat', [], 'pat').id
          opened.push(surface)
        }
        return surface.conversationId
      },
      needsAttention: (id, what) => void events.push(`attention ${id} ${what}`),
    },
    statusBar: { setWaiting: (n) => void events.push(`waiting ${n}`), setModel: () => {} },
    tasks: {
      start: (id) => void events.push(`start ${id}`),
      end: (id) => void events.push(`end ${id}`),
      readPlan: () => options.plan ?? null,
    },
    log: { info: (line) => void logs.push(line) },
    project: () => ({ id: 'p1', name: 'Alpha' }),
    configuredUrl: () => ' http://nest:19080 ',
    createSession: (conversationId, h) => {
      hooks.set(conversationId, h)
      return new ChatSession({ getClient: () => replies('done'), onUnauthorized: () => {}, conversationId, emit: h.emit, onPersist: h.onPersist })
    },
  })
  return { sessions, conversations, posted, events, logs, hooks, opened }
}

/** Until the session's run has finished and its follow-ups have run. */
async function settled(sessions: ReturnType<typeof setup>['sessions'], id: string): Promise<void> {
  for (let i = 0; i < 50 && sessions.find(id)?.busy; i++) await new Promise((r) => setTimeout(r, 5))
  await new Promise((r) => setTimeout(r, 5))
}

describe('sending', () => {
  test('a surface with no chat gets one, titled from the prompt, and the run is saved', async () => {
    const { sessions, conversations, opened, events } = setup()
    const surface: Surface = { id: 's1', kind: 'sidebar', conversationId: null }
    sessions.send(surface, '  Make   the player jump higher when Space is held down  ')
    const id = surface.conversationId!
    assert.deepEqual(opened, [surface])
    await settled(sessions, id)
    const conv = conversations.get(id)!
    assert.equal(conv.title, 'Make the player jump higher when Spac…')
    assert.deepEqual(conv.messages.map((m) => [m.role, m.content]), [['user', 'Make   the player jump higher when Space is held down'], ['assistant', 'done']])
    // The run is a task, and the strip follows it.
    assert.ok(events.includes(`start ${id}`) && events.includes(`end ${id}`))
    assert.ok(events.indexOf(`end ${id}`) > events.indexOf(`start ${id}`))
    assert.ok(events.includes('conversations'))
  })

  test('a workflow names the chat, and the draft is cleared', async () => {
    const { sessions, conversations } = setup()
    const conv = conversations.create('New chat', [], 'pat')
    conversations.setDraft(conv.id, 'half-typed')
    sessions.send({ id: 's1', kind: 'sidebar', conversationId: conv.id }, 'long composed text', { name: 'review', title: 'Review the diff' })
    await settled(sessions, conv.id)
    assert.equal(conversations.get(conv.id)?.title, 'Review the diff')
    assert.equal(conversations.get(conv.id)?.draft ?? '', '')
  })

  test('only the views of that conversation are sent its messages', async () => {
    const { sessions, conversations, posted } = setup()
    const conv = conversations.create('New chat', [], 'pat')
    sessions.send({ id: 's1', kind: 'sidebar', conversationId: conv.id }, 'hi')
    await settled(sessions, conv.id)
    assert.ok(posted.length > 0)
    assert.ok(posted.every((p) => p.id === conv.id))
  })
})

describe('a session', () => {
  test('a fresh conversation carries on the open plan in the workspace', () => {
    const plan: PlanStep[] = [{ text: 'Add the jump', status: 'pending' }]
    const { sessions, conversations, logs } = setup({ plan })
    const conv = conversations.create('New chat', [], 'pat')
    assert.deepEqual(sessions.get(conv.id).planSnapshot()?.map((s) => s.text), ['Add the jump'])
    assert.match(logs.join('\n'), /plan: carried 1 step/)
  })

  test('is made once, and dropped on close', () => {
    const { sessions } = setup()
    const first = sessions.get('c1')
    assert.equal(sessions.get('c1'), first)
    sessions.drop('c1')
    assert.equal(sessions.find('c1'), undefined)
  })
})

describe('waiting on the person', () => {
  test('a run that starts waiting says so once, and is the first waiting', () => {
    const { sessions, hooks, events } = setup()
    sessions.get('c1')
    const emit = hooks.get('c1')!.emit
    const waiting = { ...EMPTY_CONVERSATION_STATE, atTurnLimit: true }
    emit({ type: 'conversationState', conversationId: 'c1', state: waiting })
    emit({ type: 'conversationState', conversationId: 'c1', state: waiting })
    assert.deepEqual(events.filter((e) => e.startsWith('attention')), ['attention c1 is waiting for a go-ahead at the turn limit'])
    assert.equal(sessions.firstWaiting(), 'c1')
    emit({ type: 'conversationState', conversationId: 'c1', state: EMPTY_CONVERSATION_STATE })
    assert.equal(sessions.firstWaiting(), null)
    assert.deepEqual(events.filter((e) => e.startsWith('waiting')), ['waiting 1', 'waiting 1', 'waiting 0'])
  })
})

describe('the snapshot', () => {
  test('connected: the server, the project, the address the person set', () => {
    const { sessions } = setup()
    const snap = sessions.snapshot(null)
    assert.equal(snap.canSend, true)
    assert.equal(snap.serverUrl, 'http://nest:19080')
    assert.deepEqual(snap.project, { id: 'p1', name: 'Alpha' })
    assert.equal(snap.configuredUrl, 'http://nest:19080')
    assert.equal(snap.busy, false)
  })

  test('not connected: no sending, no project', () => {
    const { sessions } = setup({ state: { status: 'disconnected' } as ConnectionState })
    const snap = sessions.snapshot(null)
    assert.equal(snap.canSend, false)
    assert.equal(snap.project, undefined)
  })
})

describe('titleFor', () => {
  test('one line, at most 40 characters', () => {
    assert.equal(titleFor('fix\nthe   bug'), 'fix the bug')
    assert.equal(titleFor('x'.repeat(50)), `${'x'.repeat(37)}…`)
  })
})
