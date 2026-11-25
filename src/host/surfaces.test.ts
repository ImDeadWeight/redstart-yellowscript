// =============================================================================
// Tests for which conversation each view shows, and where a message lands.
// =============================================================================
// A fake chat view records what each surface was sent; the conversation store
// is the real one over an in-memory memento.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { HostMessage, SessionSnapshot } from '../chat/protocol.ts'
import type { Surface } from '../ui/chat-view.ts'
import { conversationStore } from '../ui/conversation-store.ts'
import { createSurfaces, type ChatView, type SurfaceSessions } from './surfaces.ts'

function memento() {
  const data = new Map<string, unknown>()
  return {
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key: string, value: unknown) => void data.set(key, value),
    keys: () => [...data.keys()],
  }
}

function fakeView() {
  const list: Surface[] = []
  const sent = new Map<string, HostMessage[]>()
  let focused: Surface | undefined
  const revealed: Array<Surface | undefined> = []
  let next = 1
  const view: ChatView & { add(conversationId?: string | null): Surface } = {
    add(conversationId = null) {
      const surface: Surface = { id: `v${next++}`, conversationId }
      list.push(surface)
      return surface
    },
    surfaces: () => [...list],
    editorFor: (id) => list.find((s) => s.conversationId === id),
    focused: () => focused,
    postTo: (surface, message) => {
      const box = sent.get(surface.id) ?? []
      box.push(message)
      sent.set(surface.id, box)
    },
    setTitle: () => {},
    openEditor: (conversationId) => view.add(conversationId),
    closeEditor: (surface) => {
      list.splice(list.indexOf(surface), 1)
    },
    reveal: async (surface) => void revealed.push(surface),
    sendInit: (surface, session, messages) => view.postTo(surface, { type: 'init', session, messages } as unknown as HostMessage),
  }
  return { view, sent, revealed, focus: (s: Surface | undefined) => (focused = s) }
}

function setup(options: { account?: string | null; focused?: boolean } = {}) {
  const { view, sent, revealed, focus } = fakeView()
  const conversations = conversationStore(memento() as never)
  const busy = new Set<string>()
  const dropped: string[] = []
  const notices: string[] = []
  const sessions: SurfaceSessions = {
    find: (id) => (busy.has(id) ? { busy: true, queued: 0 } : undefined),
    get: (id) => ({ busy: busy.has(id), load: () => {}, snapshot: () => [], state: () => ({}) as never }),
    snapshot: (id) => ({ connection: 'connected', detail: '', canSend: true, busy: id ? busy.has(id) : false, queued: 0 }) as SessionSnapshot,
    drop: (id) => void dropped.push(id),
  }
  const account = options.account === undefined ? 'pat' : options.account
  const surfaces = createSurfaces({
    view: () => view,
    conversations,
    account: () => account,
    sessions,
    pages: { push: async () => {}, pushWorkflows: async () => {}, pushSettings: () => {} },
    notifier: {
      focused: () => options.focused ?? false,
      enabled: () => true,
      show: async (message) => {
        notices.push(message)
        return undefined
      },
    },
  })
  const typesSent = (s: Surface) => (sent.get(s.id) ?? []).map((m) => m.type)
  return { surfaces, view, conversations, busy, dropped, notices, revealed, focus, typesSent }
}

describe('a tab announcing itself', () => {
  test('a tab opens on the chat it showed before a reload', () => {
    const { surfaces, view, conversations, typesSent } = setup()
    const a = conversations.create('A', [], 'pat')
    const editor = view.add(null)
    surfaces.ready(editor, a.id)
    assert.equal(editor.conversationId, a.id)
    assert.deepEqual(typesSent(editor), ['init', 'conversationList'])
  })

  test('a tab whose chat is gone opens a fresh one', () => {
    const { surfaces, view, conversations } = setup()
    const editor = view.add('deleted-meanwhile')
    surfaces.ready(editor, undefined)
    assert.notEqual(editor.conversationId, 'deleted-meanwhile')
    assert.equal(conversations.get(editor.conversationId!)?.title, 'New chat')
  })

  test('a tab restored on an archived chat brings it back', () => {
    const { surfaces, view, conversations } = setup()
    const a = conversations.create('A', [{ id: 'm1', role: 'user', content: 'hi' }] as never, 'pat')
    conversations.archive(a.id)
    surfaces.ready(view.add(a.id), undefined)
    assert.equal(conversations.get(a.id)?.archived, false)
  })
})

describe('a chat is in one tab', () => {
  test('opening a chat that has a tab brings up that tab', () => {
    const { surfaces, view, conversations, revealed } = setup()
    const a = conversations.create('A', [], 'pat')
    const editor = view.add(a.id)
    assert.equal(surfaces.openInEditor(a.id), editor)
    assert.deepEqual(revealed, [editor])
    assert.equal(view.surfaces().length, 1)
  })

  test('switching to a chat with no tab opens one; to one with a tab, reveals it', () => {
    const { surfaces, view, conversations, revealed } = setup()
    const a = conversations.create('A', [], 'pat')
    const b = conversations.create('B', [], 'pat')
    const here = view.add(a.id)
    surfaces.switchTo(here, b.id)
    assert.equal(here.conversationId, a.id, 'the tab keeps its own chat')
    const bTab = view.editorFor(b.id)
    assert.ok(bTab)
    surfaces.switchTo(here, b.id)
    assert.deepEqual(revealed, [bTab])
  })

  test('New Chat opens a tab on a new chat', () => {
    const { surfaces, view } = setup()
    surfaces.newChat()
    surfaces.newIn(view.surfaces()[0]!)
    assert.equal(view.surfaces().length, 2)
    assert.notEqual(view.surfaces()[0]!.conversationId, view.surfaces()[1]!.conversationId)
  })
})

describe('where a command lands', () => {
  test('the chat used last, else a new tab', async () => {
    const { surfaces, view, focus } = setup()
    const opened = await surfaces.revealTarget()
    assert.ok(opened)
    assert.equal(view.surfaces().length, 1)
    const editor = view.add('x')
    focus(editor)
    assert.equal(await surfaces.revealTarget(), editor)
    assert.equal(view.surfaces().length, 2)
  })

  test('showing a conversation opens its tab', async () => {
    const { surfaces, view, conversations } = setup()
    const a = conversations.create('A', [], 'pat')
    await surfaces.showConversation(a.id)
    assert.equal(view.editorFor(a.id)?.conversationId, a.id)
  })
})

describe('closing', () => {
  test('a tab closed on a running chat keeps it open, for History', () => {
    const { surfaces, view, conversations, busy } = setup()
    const a = conversations.create('A', [{ id: 'm1', role: 'user', content: 'hi' }] as never, 'pat')
    busy.add(a.id)
    surfaces.closed(view.add(a.id))
    assert.equal(conversations.get(a.id)?.archived, false)
  })

  test('a closed chat goes to history; a blank one is deleted', () => {
    const { surfaces, view, conversations } = setup()
    const kept = conversations.create('A', [{ id: 'm1', role: 'user', content: 'hi' }] as never, 'pat')
    const blank = conversations.create('New chat', [], 'pat')
    surfaces.closed(view.add(kept.id))
    surfaces.closed(view.add(blank.id))
    assert.equal(conversations.get(kept.id)?.archived, true)
    assert.equal(conversations.get(blank.id), undefined)
  })

  test('closing a chat stops the run and closes its tab', () => {
    const { surfaces, view, conversations, dropped } = setup()
    const a = conversations.create('A', [{ id: 'm1', role: 'user', content: 'hi' }] as never, 'pat')
    const editor = view.add(a.id)
    surfaces.close(a.id)
    assert.deepEqual(dropped, [a.id])
    assert.equal(view.surfaces().includes(editor), false)
  })
})

describe('the waiting notification', () => {
  test('only when the window is not focused', () => {
    const away = setup({ focused: false })
    const c = away.conversations.create('Build it', [], 'pat')
    away.surfaces.notifyUnwatched(c.id, 'is waiting for an approval')
    assert.deepEqual(away.notices, ['Yellowscript: "Build it" is waiting for an approval.'])

    const here = setup({ focused: true })
    here.surfaces.notifyUnwatched(c.id, 'is waiting for an approval')
    assert.deepEqual(here.notices, [])
  })
})
