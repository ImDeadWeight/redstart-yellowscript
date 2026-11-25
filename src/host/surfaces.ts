// =============================================================================
// Surfaces: the editor tabs, each on its own conversation.
// =============================================================================
// A chat is an editor tab (VSCode's own tabs, movable between groups and
// windows), and is in one tab at a time. There was a sidebar view too, with a
// strip of every chat not in a tab; a chat in a tab was then on no list the
// sidebar showed, and a blank sidebar chat looked like the running one
// (2026-11-24). History lists every chat, running ones first.
//
// This decides which conversation each view shows and keeps the views' tab
// lists, titles, history panel and snapshots current. It reaches the sessions
// only through SurfaceSessions, so sessions and surfaces do not import each
// other's state.
//
// No `vscode` import: the views, the store and the notification are passed in.
// =============================================================================

import { tabLabel, type ConversationView, type PageName, type SessionSnapshot } from '../chat/protocol.ts'
import type { ChatSession } from '../chat/session.ts'
import type { ChatViewProvider, Surface } from '../ui/chat-view.ts'
import { isBlank, type Conversation, type ConversationStore, type HistoryEntry } from '../ui/conversation-store.ts'

/** The parts of the chat view this uses. */
export type ChatView = Pick<
  ChatViewProvider,
  'surfaces' | 'editorFor' | 'focused' | 'postTo' | 'setTitle' | 'openEditor' | 'closeEditor' | 'reveal' | 'sendInit'
>

/** What the views need from the conversations' sessions. */
export interface SurfaceSessions {
  /** A conversation's session if it has one; none is created. */
  find(id: string): Pick<ChatSession, 'busy' | 'queued'> | undefined
  /** A conversation's session, created (and loaded) on demand. */
  get(id: string): Pick<ChatSession, 'busy' | 'load' | 'snapshot' | 'state'>
  /** The snapshot a view shows around a conversation (null: none on it). */
  snapshot(id: string | null): SessionSnapshot
  /** Stop a conversation's run and forget its session. */
  drop(id: string): void
}

/** Telling the person a run needs them while they are looking elsewhere. */
export interface Notifier {
  /** Whether the window has focus (then the card is already on screen). */
  focused(): boolean
  /** Whether the person wants to be told (redstartYellowscript.notifyWhenWaiting). */
  enabled(): boolean
  /** Show a message with one action; resolves with the action when chosen. */
  show(message: string, action: string): PromiseLike<string | undefined>
}

export interface SurfacesDeps {
  view: () => ChatView | undefined
  conversations: ConversationStore
  /** The signed-in account, or null. */
  account: () => string | null
  sessions: SurfaceSessions
  /** The projects, workflows and settings pages. */
  pages: { push(to: Surface): Promise<void>; pushWorkflows(to: Surface): Promise<void>; pushSettings(to: Surface): void }
  notifier: Notifier
}

export interface Surfaces {
  /** Each view's snapshot: busy, queued and model are its own chat's. */
  pushSession(): void
  /** Each view's tab list, and every editor tab's title. */
  pushConversations(): void
  /** A new, empty chat of this account. */
  create(): Conversation
  /** Put a conversation on a surface; a pure view change. */
  showIn(surface: Surface, id: string): void
  /** The conversation on a surface, opening a new chat there when it has none. */
  conversationOn(surface: Surface): string
  /** A chat in a new editor tab, or the tab it is already in. */
  openInEditor(id: string): Surface | undefined
  /** A view announced itself (first open, or rebuilt): give it everything. */
  ready(from: Surface, restoredId: string | undefined): void
  /** The view's + button. */
  newIn(from: Surface): void
  /** A tab in the strip was clicked. */
  switchTo(from: Surface, id: string): void
  /** The tab-strip close: stop its run, retire it, and take it off every view. */
  close(id: string): void
  /** The person closed an editor tab. */
  closed(surface: Surface): void
  openHistory(from: Surface): void
  searchHistory(from: Surface, query: string): void
  /** Delete from history for good, open or not. */
  deleteForever(from: Surface, id: string): void
  restore(from: Surface, id: string): void
  /** Signed in: a view still on another account's chat moves to this one's. */
  followAccount(): void
  /** Bring the chat a command lands in to the front: the one used last, else
   *  a new one in a tab. Undefined only when no tab can be opened. */
  revealTarget(): Promise<Surface | undefined>
  /** The New Chat command: a new chat in a tab of its own. */
  newChat(): void
  /** The Open Chat command (and the status bar): the chat used last, else a new one. */
  openChat(): Promise<void>
  /** Reveal the panel on a page, and load its data. */
  showPage(page: PageName): void
  /** The Open History command. */
  showHistory(): void
  /** Reveal the chat with this conversation in front. */
  showConversation(conversationId: string): Promise<void>
  /** A run needs the person, or a long one finished: say so if they are elsewhere. */
  notifyUnwatched(conversationId: string, what: string): void
}

export function createSurfaces(deps: SurfacesDeps): Surfaces {
  const { conversations, sessions } = deps
  const view = deps.view

  function pushSession(): void {
    for (const surface of view()?.surfaces() ?? []) {
      view()?.postTo(surface, { type: 'session', session: sessions.snapshot(surface.conversationId) })
    }
  }

  function toViews(list: Conversation[]): ConversationView[] {
    return list.map((c) => {
      const session = sessions.find(c.id)
      return { id: c.id, title: c.title, busy: session?.busy === true, queued: session?.queued ?? 0, draft: c.draft ?? '' }
    })
  }

  function pushConversations(): void {
    for (const surface of view()?.surfaces() ?? []) {
      const own = surface.conversationId ? conversations.get(surface.conversationId) : undefined
      view()?.postTo(surface, { type: 'conversationList', conversations: own ? toViews([own]) : [], activeId: surface.conversationId })
      if (own) view()?.setTitle(surface, editorTitle(own))
    }
  }

  function create(): Conversation {
    return conversations.create('New chat', [], deps.account() ?? undefined)
  }

  /** Paint a surface's conversation: its transcript and what sits around it. */
  function postConversation(surface: Surface): void {
    const id = surface.conversationId
    if (!id) return
    const session = sessions.get(id)
    view()?.postTo(surface, { type: 'conversation', conversationId: id, messages: session.snapshot(), state: session.state() })
  }

  /** Put a conversation on a surface. A pure view change: whatever it is doing
   *  (streaming, waiting on a question) carries on untouched. */
  function showIn(surface: Surface, id: string): void {
    surface.conversationId = id
    // activeConversationChanged FIRST so the webview takes the transcript that
    // follows (it drops one for any chat other than its own).
    view()?.postTo(surface, { type: 'activeConversationChanged', id })
    postConversation(surface)
    view()?.postTo(surface, { type: 'session', session: sessions.snapshot(id) })
    pushConversations()
  }

  function openInEditor(id: string): Surface | undefined {
    const chatView = view()
    const existing = chatView?.editorFor(id)
    if (existing) {
      void chatView?.reveal(existing)
      return existing
    }
    const conv = conversations.get(id)
    if (!conv || !chatView) return undefined
    if (conv.archived) conversations.unarchive(id)
    const opened = chatView.openEditor(id, editorTitle(conv))
    pushConversations()
    return opened
  }

  /** Close a chat: to history, or deleted outright when there was nothing in it. */
  function retire(id: string): void {
    const closing = conversations.get(id)
    if (closing && isBlank(closing)) conversations.delete(id)
    else conversations.archive(id)
  }

  /** A chat is gone: the tab on it closes. */
  function vacate(id: string): void {
    for (const surface of view()?.surfaces() ?? []) {
      if (surface.conversationId === id) view()?.closeEditor(surface)
    }
  }

  /** Every chat of this account, open ones included, newest first. Open chats
   *  are listed too, so one is never somewhere the person cannot find it. */
  function historyItems(): Array<HistoryEntry & { running: boolean }> {
    const account = deps.account()
    if (!account) return []
    return conversations.history(account).map((h) => ({ ...h, running: sessions.find(h.id)?.busy === true }))
  }

  function pushHistoryPanel(to: Surface): void {
    view()?.postTo(to, { type: 'showHistoryPanel', conversations: historyItems() })
  }

  /** Refresh the history list without opening it. */
  function refreshHistory(to: Surface): void {
    view()?.postTo(to, { type: 'historyList', conversations: historyItems() })
  }

  /** Bring the chat a command lands in to the front: the one used last, else a
   *  new chat in a tab. A tab just opened takes what is posted to it once its
   *  page has loaded (ChatViewProvider queues it). */
  async function revealTarget(): Promise<Surface | undefined> {
    const to = view()?.focused()
    if (to) {
      await view()?.reveal(to)
      return to
    }
    return openInEditor(create().id)
  }

  async function showConversation(conversationId: string): Promise<void> {
    // In its tab, or a tab opened on it.
    openInEditor(conversationId)
  }

  return {
    pushSession,
    pushConversations,
    create,
    showIn,
    conversationOn(surface) {
      if (!surface.conversationId) showIn(surface, create().id)
      return surface.conversationId!
    },
    openInEditor,

    // Fires on first open AND every time VSCode rebuilds a view it destroyed
    // while hidden — so this must be a complete handoff, not a delta.
    ready(from, restoredId) {
      // The chat this tab was opened on, or showed before a reload. Gone
      // (deleted meanwhile) means a fresh chat rather than an empty tab.
      let opened = from.conversationId ?? restoredId ?? null
      const existing = opened ? conversations.get(opened) : undefined
      if (!existing) opened = create().id
      else if (existing.archived) conversations.unarchive(existing.id)
      from.conversationId = opened
      const id = opened!
      const conv = conversations.get(id)
      const session = sessions.get(id)
      // A saved transcript and nothing streaming: seed the session so the
      // view opens on the right chat.
      if (conv && !session.busy) session.load(conv.messages, conv.plan ?? null, conv.inFlight ?? null)
      view()?.sendInit(from, sessions.snapshot(id), session.snapshot(), session.state())
      pushConversations()
    },

    newIn() {
      // A tab is one chat: a new one gets a tab of its own, like any other editor.
      openInEditor(create().id)
    },

    switchTo(from, id) {
      const editor = view()?.editorFor(id)
      if (editor && editor !== from) void view()?.reveal(editor)
      else if (!editor) openInEditor(id)
    },

    close(id) {
      sessions.drop(id)
      retire(id)
      vacate(id)
      pushConversations()
      for (const surface of view()?.surfaces() ?? []) refreshHistory(surface)
    },

    closed(surface) {
      const id = surface.conversationId
      if (!id) return
      // A run still going is not thrown away with its tab: it carries on, and
      // History lists it as running, where it can be opened again.
      if (sessions.find(id)?.busy) {
        pushConversations()
        return
      }
      retire(id)
      pushConversations()
    },

    openHistory: pushHistoryPanel,

    searchHistory(from, query) {
      const all = historyItems()
      const q = query.trim().toLowerCase()
      const filtered = q ? all.filter((c) => c.title.toLowerCase().includes(q)) : all
      view()?.postTo(from, { type: 'historyList', conversations: filtered })
    },

    deleteForever(from, id) {
      // Permanent, open or not; the history panel has the person confirm
      // first, and says so when the chat is open or still running.
      sessions.drop(id)
      conversations.delete(id)
      vacate(id)
      pushConversations()
      refreshHistory(from)
    },

    restore(from, id) {
      const conv = conversations.get(id)
      if (!conv) return
      // Already open somewhere: go there instead of opening it twice.
      const shownIn = view()?.surfaces().find((s) => s.conversationId === id)
      if (shownIn) {
        void view()?.reveal(shownIn)
        return
      }
      conversations.unarchive(id)
      openInEditor(id)
    },

    followAccount() {
      // Each tab is the chat it was opened on, whoever is signed in now.
      pushConversations()
    },

    revealTarget,

    newChat() {
      openInEditor(create().id)
    },

    async openChat() {
      await revealTarget()
    },

    showPage(page) {
      void revealTarget().then((target) => {
        if (!target) return
        view()?.postTo(target, { type: 'showPage', page })
        if (page === 'projects') void deps.pages.push(target)
        else if (page === 'settings') deps.pages.pushSettings(target)
        else void deps.pages.pushWorkflows(target)
      })
    },

    showHistory() {
      void revealTarget().then((target) => {
        if (target) pushHistoryPanel(target)
      })
    },

    showConversation,

    notifyUnwatched(conversationId, what) {
      if (deps.notifier.focused()) return
      if (!deps.notifier.enabled()) return
      const title = conversations.get(conversationId)?.title ?? 'A chat'
      void deps.notifier.show(`Yellowscript: "${title}" ${what}.`, 'Show').then((choice) => {
        if (choice === 'Show') void showConversation(conversationId)
      })
    },
  }
}

/** An editor tab is named for its chat, so a row of them can be told apart. */
function editorTitle(conv: Conversation): string {
  return tabLabel(conv.title)
}
