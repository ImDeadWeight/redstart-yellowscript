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
  const view: ChatView & { add(kind: 'sidebar' | 'editor', conversationId?: string | null): Surface } = {
    add(kind, conversationId = null) {
      const surface: Surface = { id: `v${next++}`, kind, conversationId }
      list.push(surface)
      return surface
    },
    surfaces: () => [...list],
    sidebar: () => list.find((s) => s.kind === 'sidebar'),
    editorFor: (id) => list.find((s) => s.kind === 'editor' && s.conversationId === id),
    focused: () => focused,
    postTo: (surface, message) => {
      const box = sent.get(surface.id) ?? []
      box.push(message)
      sent.set(surface.id, box)
    },
    setTitle: () => {},
    openEditor: (conversationId) => view.add('editor', conversationId),
    closeEditor: (surface) => {
      list.splice(list.indexOf(surface), 1)
    },
    reveal: async (surface) => void revealed.push(surface),
    revealSidebar: async () => {},
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
    pages: { push: async () => {}, pushWorkflows: async () => {} },
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

describe('a view announcing itself', () => {
  test('the sidebar opens on the chat it showed before a reload', () => {
    const { surfaces, view, conversations, typesSent } = setup()
    const a = conversations.create('A', [], 'pat')
    conversations.create('B', [], 'pat')
    const sidebar = view.add('sidebar')
    surfaces.ready(sidebar, a.id)
    assert.equal(sidebar.conversationId, a.id)
    assert.deepEqual(typesSent(sidebar), ['init', 'conversationList'])
  })

  test("the sidebar does not open on another account's chat", () => {
    const { surfaces, view, conversations } = setup()
    const theirs = conversations.create('Theirs', [], 'sam')
    const mine = conversations.create('Mine', [], 'pat')
    const sidebar = view.add('sidebar')
    surfaces.ready(sidebar, theirs.id)
    assert.equal(sidebar.conversationId, mine.id)
  })

  test('an editor tab whose chat is gone opens a fresh one', () => {
    const { surfaces, view, conversations } = setup()
    const editor = view.add('editor', 'deleted-meanwhile')
    surfaces.ready(editor, undefined)
    assert.notEqual(editor.conversationId, 'deleted-meanwhile')
    assert.equal(conversations.get(editor.conversationId!)?.title, 'New chat')
  })

  test('an editor tab restored on the chat the sidebar shows takes it; the sidebar moves on', () => {
    const { surfaces, view, conversations } = setup()
    const a = conversations.create('A', [], 'pat')
    const b = conversations.create('B', [], 'pat')
    const sidebar = view.add('sidebar', a.id)
    const editor = view.add('editor', a.id)
    surfaces.ready(editor, undefined)
    assert.equal(editor.conversationId, a.id)
    assert.equal(sidebar.conversationId, b.id)
  })
})

describe('a chat lives in one place', () => {
  test('opening the sidebar chat in an editor tab moves the sidebar to another', () => {
    const { surfaces, view, conversations } = setup()
    const a = conversations.create('A', [], 'pat')
    const b = conversations.create('B', [], 'pat')
    const sidebar = view.add('sidebar', a.id)
    surfaces.openInEditor(a.id)
    assert.equal(view.editorFor(a.id)?.conversationId, a.id)
    assert.equal(sidebar.conversationId, b.id)
  })

  test('switching to a chat that has an editor tab brings up that tab', () => {
    const { surfaces, view, conversations, revealed } = setup()
    const a = conversations.create('A', [], 'pat')
    const sidebar = view.add('sidebar', null)
    const editor = view.add('editor', a.id)
    surfaces.switchTo(sidebar, a.id)
    assert.equal(sidebar.conversationId, null)
    assert.deepEqual(revealed, [editor])
  })
})

describe('where a command lands', () => {
  test('the chat used last, else the sidebar', async () => {
    const { surfaces, view, focus } = setup()
    const sidebar = view.add('sidebar', null)
    const editor = view.add('editor', 'x')
    assert.equal(await surfaces.revealTarget(), sidebar)
    focus(editor)
    assert.equal(await surfaces.revealTarget(), editor)
  })
})

describe('closing', () => {
  test('a tab closed on a running chat keeps it in the strip', () => {
    const { surfaces, view, conversations, busy } = setup()
    const a = conversations.create('A', [{ id: 'm1', role: 'user', content: 'hi' }] as never, 'pat')
    busy.add(a.id)
    surfaces.closed(view.add('editor', a.id))
    assert.equal(conversations.get(a.id)?.archived, false)
  })

  test('a closed chat goes to history; a blank one is deleted', () => {
    const { surfaces, view, conversations } = setup()
    const kept = conversations.create('A', [{ id: 'm1', role: 'user', content: 'hi' }] as never, 'pat')
    const blank = conversations.create('New chat', [], 'pat')
    surfaces.closed(view.add('editor', kept.id))
    surfaces.closed(view.add('editor', blank.id))
    assert.equal(conversations.get(kept.id)?.archived, true)
    assert.equal(conversations.get(blank.id), undefined)
  })

  test('the strip close stops the run and takes the chat off every view', () => {
    const { surfaces, view, conversations, dropped } = setup()
    const a = conversations.create('A', [{ id: 'm1', role: 'user', content: 'hi' }] as never, 'pat')
    const editor = view.add('editor', a.id)
    surfaces.close(a.id)
    assert.deepEqual(dropped, [a.id])
    assert.equal(view.surfaces().includes(editor), false)
  })
})

describe('signing in as another account', () => {
  test("the sidebar leaves the other account's chat", () => {
    const { surfaces, view, conversations } = setup()
    const theirs = conversations.create('Theirs', [], 'sam')
    const mine = conversations.create('Mine', [], 'pat')
    const sidebar = view.add('sidebar', theirs.id)
    surfaces.followAccount()
    assert.equal(sidebar.conversationId, mine.id)
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
