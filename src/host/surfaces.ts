// =============================================================================
// Surfaces: the sidebar and the editor tabs, each on its own conversation.
// =============================================================================
// A chat lives in one place at a time. An editor tab is one chat (VSCode's own
// tabs, movable between groups and windows); the sidebar has a strip of every
// other open chat. Switching in one never moves another.
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
  'surfaces' | 'sidebar' | 'editorFor' | 'focused' | 'postTo' | 'setTitle' | 'openEditor' | 'closeEditor' | 'reveal' | 'revealSidebar' | 'sendInit'
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
  openInEditor(id: string): void
  /** The sidebar's chat, moved to an editor tab of its own. */
  moveSidebarToEditor(): void
  /** An editor tab's chat, moved back into the sidebar's strip. */
  moveEditorToSidebar(surface: Surface | undefined): void
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
  /** Bring the chat a command lands in to the front; undefined: there is none. */
  revealTarget(): Promise<Surface | undefined>
  /** The New Chat command: a new chat in the sidebar's strip. */
  newChat(): Promise<void>
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
  /** A conversation the sidebar should open on once VSCode creates its view
   *  (a command ran before the view existed). */
  let pendingSidebarConversation: string | null = null

  function pushSession(): void {
    for (const surface of view()?.surfaces() ?? []) {
      view()?.postTo(surface, { type: 'session', session: sessions.snapshot(surface.conversationId) })
    }
  }

  /** The sidebar's tab strip: open chats of this account not in an editor tab. */
  function sidebarConversations(): Conversation[] {
    return conversations.list(deps.account() ?? undefined).filter((c) => !view()?.editorFor(c.id))
  }

  function toViews(list: Conversation[]): ConversationView[] {
    return list.map((c) => {
      const session = sessions.find(c.id)
      return { id: c.id, title: c.title, busy: session?.busy === true, queued: session?.queued ?? 0, draft: c.draft ?? '' }
    })
  }

  function pushConversations(): void {
    for (const surface of view()?.surfaces() ?? []) {
      if (surface.kind === 'sidebar') {
        view()?.postTo(surface, { type: 'conversationList', conversations: toViews(sidebarConversations()), activeId: surface.conversationId })
        continue
      }
      const own = surface.conversationId ? conversations.get(surface.conversationId) : undefined
      view()?.postTo(surface, { type: 'conversationList', conversations: own ? toViews([own]) : [], activeId: surface.conversationId })
      if (own) view()?.setTitle(surface, editorTitle(own))
    }
  }

  function create(): Conversation {
    return conversations.create('New chat', [], deps.account() ?? undefined)
  }

  /**
   * The chat the sidebar should show: `preferred` when it is open, this
   * account's and not in an editor tab; else the first of the strip; else a new one.
   */
  function pickSidebarConversation(preferred: string | null | undefined): string {
    const candidates = sidebarConversations()
    const account = deps.account()
    if (preferred) {
      const conv = conversations.get(preferred)
      if (conv && !view()?.editorFor(preferred) && (!account || !conv.accountId || conv.accountId === account)) {
        if (conv.archived) conversations.unarchive(preferred)
        return preferred
      }
    }
    return candidates[0]?.id ?? create().id
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

  function openInEditor(id: string): void {
    const chatView = view()
    const existing = chatView?.editorFor(id)
    if (existing) {
      void chatView?.reveal(existing)
      return
    }
    const conv = conversations.get(id)
    if (!conv || !chatView) return
    if (conv.archived) conversations.unarchive(id)
    // Off the sidebar first, so it is never on screen in two places.
    const sidebar = chatView.sidebar()
    chatView.openEditor(id, editorTitle(conv))
    if (sidebar && sidebar.conversationId === id) showIn(sidebar, pickSidebarConversation(null))
    pushConversations()
  }

  /** Show a conversation in the sidebar, or once it exists; then bring it up. */
  async function showInSidebar(id: string): Promise<void> {
    const sidebar = view()?.sidebar()
    if (sidebar) showIn(sidebar, id)
    else pendingSidebarConversation = id
    await view()?.revealSidebar()
  }

  /** Close a chat: to history, or deleted outright when there was nothing in it. */
  function retire(id: string): void {
    const closing = conversations.get(id)
    if (closing && isBlank(closing)) conversations.delete(id)
    else conversations.archive(id)
  }

  /** A chat is gone from the strip: an editor tab on it closes, the sidebar moves on. */
  function vacate(id: string): void {
    for (const surface of view()?.surfaces() ?? []) {
      if (surface.conversationId !== id) continue
      if (surface.kind === 'editor') view()?.closeEditor(surface)
      else showIn(surface, pickSidebarConversation(null))
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

  /** Bring the chat a command lands in to the front. With none in focus it is
   *  the sidebar's. */
  async function revealTarget(): Promise<Surface | undefined> {
    const to = view()?.focused() ?? view()?.sidebar()
    await view()?.reveal(to)
    return to ?? view()?.sidebar()
  }

  async function showConversation(conversationId: string): Promise<void> {
    // Wherever it is on screen; else it comes up in the sidebar.
    const shownIn = view()?.surfaces().find((s) => s.conversationId === conversationId)
    if (shownIn) {
      await view()?.reveal(shownIn)
      return
    }
    const conv = conversations.get(conversationId)
    if (!conv) return
    if (conv.archived) conversations.unarchive(conversationId)
    await showInSidebar(conversationId)
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

    moveSidebarToEditor() {
      openInEditor(view()?.sidebar()?.conversationId ?? create().id)
    },

    moveEditorToSidebar(surface) {
      const chatView = view()
      // The tab closes without that counting as closing the chat: a run carries on.
      if (!surface || surface.kind !== 'editor' || !chatView) return
      const id = surface.conversationId
      chatView.closeEditor(surface)
      if (!id) return
      const sidebar = chatView.sidebar()
      if (sidebar) showIn(sidebar, id)
      else pendingSidebarConversation = id
      void chatView.revealSidebar()
    },

    // Fires on first open AND every time VSCode rebuilds a view it destroyed
    // while hidden — so this must be a complete handoff, not a delta.
    ready(from, restoredId) {
      if (from.kind === 'editor') {
        // The chat this tab was opened on, or showed before a reload. Gone
        // (deleted meanwhile) means a fresh chat rather than an empty tab.
        let id = from.conversationId ?? restoredId ?? null
        const conv = id ? conversations.get(id) : undefined
        if (!conv) id = create().id
        else if (conv.archived) conversations.unarchive(conv.id)
        from.conversationId = id
        // A chat lives in one place. The sidebar may have picked it up while
        // this tab was still being restored.
        const sidebar = view()?.sidebar()
        if (sidebar && sidebar.conversationId === id) showIn(sidebar, pickSidebarConversation(null))
      } else {
        from.conversationId = pickSidebarConversation(pendingSidebarConversation ?? restoredId ?? from.conversationId)
        pendingSidebarConversation = null
      }
      const id = from.conversationId!
      const conv = conversations.get(id)
      const session = sessions.get(id)
      // A saved transcript and nothing streaming: seed the session so the
      // view opens on the right chat.
      if (conv && !session.busy) session.load(conv.messages, conv.plan ?? null, conv.inFlight ?? null)
      view()?.sendInit(from, sessions.snapshot(id), session.snapshot(), session.state())
      pushConversations()
    },

    newIn(from) {
      // An editor tab is one chat: a new one gets a tab of its own, like any
      // other editor. The sidebar keeps a strip of them.
      if (from.kind === 'editor') openInEditor(create().id)
      else showIn(from, create().id)
    },

    switchTo(from, id) {
      const editor = view()?.editorFor(id)
      if (editor && editor !== from) void view()?.reveal(editor)
      else showIn(from, id)
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
      // A run still going is not thrown away with its tab: it carries on in
      // the sidebar's strip, where it can be found.
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
      if (from.kind === 'editor') openInEditor(id)
      else showIn(from, id)
    },

    followAccount() {
      const account = deps.account()
      for (const surface of view()?.surfaces() ?? []) {
        const conv = surface.conversationId ? conversations.get(surface.conversationId) : undefined
        if (surface.kind === 'sidebar' && conv && account && conv.accountId && conv.accountId !== account) {
          showIn(surface, pickSidebarConversation(null))
        }
      }
      pushConversations()
    },

    revealTarget,

    newChat: () => showInSidebar(create().id),

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
