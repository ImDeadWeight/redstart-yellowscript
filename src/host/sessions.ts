// =============================================================================
// Sessions: one ChatSession per conversation, and what follows from its runs.
// =============================================================================
// Tabs own their own transcript and request lifecycle, so switching tabs is a
// pure view change and a running turn keeps streaming in its own tab. This
// keeps the sessions, persists them, builds the snapshot a view shows around
// one, and reacts to what a run emits: tasks starting and ending, who is
// waiting on the person, the status bar, the log.
//
// It tells the views what happened only through SessionViews (post to a
// conversation, the conversations changed, the snapshots changed), so it does
// not depend on surfaces.ts and surfaces.ts does not depend on it.
//
// No `vscode` import.
// =============================================================================

import { describeState, type ConnectionState } from '../connection.ts'
import { ContextTracker } from '../agent/context-budget.ts'
import { AttentionTracker, LONG_RUN_MS } from '../chat/attention.ts'
import { attachmentLabel } from '../chat/attachments.ts'
import { PLAN_DIR, PLAN_FILE } from '../chat/plan-file.ts'
import type { AttachmentView, HostMessage, SessionSnapshot } from '../chat/protocol.ts'
import type { ChatSession } from '../chat/session.ts'
import type { NestClient } from '../nest/client.ts'
import type { Surface } from '../ui/chat-view.ts'
import type { ConversationStore } from '../ui/conversation-store.ts'
import type { StatusBar } from '../ui/status-bar.ts'
import type { Tasks } from './tasks.ts'

/** What sessions tell the views. */
export interface SessionViews {
  /** To the views showing this conversation; the others are on their own. */
  post(conversationId: string, message: HostMessage): void
  /** The tab strips and editor titles changed (a run started or ended). */
  conversationsChanged(): void
  /** Each view's snapshot changed (busy, queued, model, vision). */
  sessionsChanged(): void
  /** The conversation on this surface, opening a new chat there when it has none. */
  conversationOn(surface: Surface): string
  /** A run needs the person, or a long one finished. */
  needsAttention(conversationId: string, what: string): void
}

/** What a session is given by the host that keeps it. */
export interface SessionHooks {
  emit(message: HostMessage): void
  /** The transcript changed durably: save it. */
  onPersist(): void
  /** The connected client's context window. */
  context(): ContextTracker | null
}

export interface SessionsDeps {
  connection: { readonly state: ConnectionState; readonly activeClient: NestClient | null }
  conversations: ConversationStore
  views: SessionViews
  statusBar: Pick<StatusBar, 'setWaiting' | 'setModel'>
  tasks: Pick<Tasks, 'start' | 'end' | 'readPlan'>
  log: { info(line: string): void }
  /** The linked Nest project, shown in the snapshot. */
  project: () => { id: string; name: string } | null
  /** The server address the person set, if any (redstartYellowscript.serverUrl). */
  configuredUrl: () => string
  /** Build one conversation's session (agent/compose.ts in the extension). */
  createSession: (conversationId: string, hooks: SessionHooks) => ChatSession
}

export interface Sessions {
  /** A conversation's session, created and loaded on demand. */
  get(id: string): ChatSession
  /** A conversation's session if it has one; none is created. */
  find(id: string): ChatSession | undefined
  /** Stop a conversation's run and forget its session. */
  drop(id: string): void
  /** The window is closing: cancel every run. */
  abortAll(): void
  /**
   * Send to the conversation on a surface (opening one if it has none), and
   * title a new chat from its first prompt, or from the workflow it ran.
   */
  send(surface: Surface, text: string, workflow?: { name: string; title: string }, attachments?: AttachmentView[]): void
  /** The snapshot a view shows around a conversation (null: none on it). */
  snapshot(id: string | null): SessionSnapshot
  /** The conversation waiting on the person longest, if any. */
  firstWaiting(): string | null
}

export function createSessions(deps: SessionsDeps): Sessions {
  const { conversations, views } = deps
  const sessions = new Map<string, ChatSession>()
  /** Which conversations wait on the person, and how long runs take. */
  const attention = new AttentionTracker()
  /**
   * One context tracker per connected client: n_ctx is read from the Nest once
   * (llama-server's /props), and the gateway's overhead is learned from replies.
   * Keyed weakly, so a reconnect (a new client) starts fresh.
   */
  const contextTrackers = new WeakMap<NestClient, ContextTracker>()

  function contextFor(client: NestClient | null): ContextTracker | null {
    if (!client) return null
    let tracker = contextTrackers.get(client)
    if (!tracker) {
      tracker = new ContextTracker(client)
      contextTrackers.set(client, tracker)
      void tracker.ready().then(() => {
        // Now known whether the model reads images: the composer says so.
        views.sessionsChanged()
        deps.log.info(`context: n_ctx ${tracker!.contextSize ?? 'unknown (learned from the first refusal)'}`)
      })
    }
    return tracker
  }

  /**
   * Record what the model actually did with its tools.
   *
   * `recovered` is the fact worth having. It says the model did NOT emit a
   * structured `tool_calls` field and the call had to be salvaged out of its text
   * or its reasoning — which is the difference between llama.cpp parsing this
   * model's chat template correctly and the fallback carrying the whole feature.
   * That is a per-model property, invisible from the panel, and the thing to check
   * first when switching models or when the agent starts behaving oddly.
   *
   * Arguments are logged trimmed: they are model-authored and can be a whole file
   * of content on a Phase 3 write call.
   */
  function logToolActivity(message: HostMessage): void {
    if (message.type === 'tool/call') {
      const args = message.arguments.length > 300 ? `${message.arguments.slice(0, 300)}…` : message.arguments
      deps.log.info(`tool call: ${message.name}(${args})` + (message.recovered ? '  [RECOVERED from text — no structured tool_calls]' : ''))
    } else if (message.type === 'tool/result') {
      deps.log.info(`tool result: ${message.name} -> ${message.isError ? 'ERROR' : 'ok'}` + `${message.truncated ? ', truncated' : ''} — ${message.summary}`)
    }
  }

  /** What one conversation's run emits, and what follows from it. */
  function onEmit(id: string, message: HostMessage): void {
    // A task is one user message's run: it starts when that message runs
    // (not when it queues) and ends with the turn. "Apply all in this
    // task" lasts until then; its checkpoints stay for Revert Last Task.
    if (message.type === 'message' && message.message.role === 'user' && !message.message.pending) {
      deps.tasks.start(id)
      attention.runStarted(id)
    } else if (message.type === 'turn/completed' || message.type === 'turn/failed') {
      deps.tasks.end(id)
      const took = attention.runEnded(id)
      if (took !== null && took > LONG_RUN_MS) views.needsAttention(id, `finished after ${Math.round(took / 60_000)} min`)
    } else if (message.type === 'conversationState') {
      const news = attention.update(id, message.state)
      deps.statusBar.setWaiting(attention.count)
      if (news) views.needsAttention(id, `is waiting for ${news}`)
    }
    // Only the views showing this chat; the others are on their own.
    views.post(id, message)
    // The tab strip's busy dots and an editor tab's title follow the run.
    if (
      (message.type === 'message' && message.message.role === 'user' && !message.message.pending) ||
      message.type === 'turn/completed' ||
      message.type === 'turn/failed'
    ) {
      views.conversationsChanged()
    }
    if (message.type === 'turn/completed' && message.stats?.tokensPerSecond) {
      deps.statusBar.setModel(get(message.conversationId).currentModel ?? null, message.stats.tokensPerSecond)
    }
    logToolActivity(message)
  }

  /** Persist a conversation's transcript from its session to the store. */
  function persist(id: string): void {
    const session = sessions.get(id)
    const conv = conversations.get(id)
    if (!session || !conv) return
    conv.messages = session.snapshot()
    const plan = session.planSnapshot()
    if (plan) conv.plan = plan
    else delete conv.plan
    const inFlight = session.inFlightSnapshot()
    if (inFlight) conv.inFlight = inFlight
    else delete conv.inFlight
    conversations.save(conv)
  }

  /**
   * The ChatSession for a conversation, created on demand and cached. Each tab
   * owns its transcript, its AbortController, and its prompt queue, so switching
   * tabs never touches another tab's running turn.
   */
  function get(id: string): ChatSession {
    let session = sessions.get(id)
    if (!session) {
      session = deps.createSession(id, {
        emit: (message) => onEmit(id, message),
        onPersist: () => persist(id),
        context: () => contextFor(deps.connection.activeClient),
      })
      sessions.set(id, session)

      // Lazy-load the transcript from the store so background tabs fully restore
      // when clicked. The host already seeded the active tab on init; this covers
      // every other tab the user opens later.
      const conv = conversations.get(id)
      if (conv && (conv.messages.length > 0 || conv.plan)) {
        session.load(conv.messages, conv.plan ?? null, conv.inFlight ?? null)
      } else {
        // A fresh conversation carries on the workspace's plan while steps are
        // open (.yellowscript/PLAN.md, kept by onPlanChanged).
        const carried = deps.tasks.readPlan()
        if (carried) {
          session.load([], carried)
          deps.log.info(`plan: carried ${carried.length} step(s) from ${PLAN_DIR}/${PLAN_FILE} into a new conversation`)
        }
      }
    }
    return session
  }

  return {
    get,
    find: (id) => sessions.get(id),
    drop(id) {
      sessions.get(id)?.abort()
      sessions.delete(id)
    },
    abortAll() {
      for (const session of sessions.values()) session.abort()
      sessions.clear()
    },

    send(surface, text, workflow, attachments) {
      const conversationId = views.conversationOn(surface)
      // Sent, so no longer a draft. Cleared here rather than trusting the
      // webview's follow-up, which could land after a save below.
      conversations.setDraft(conversationId, '')
      // Title a still-untitled chat now, from what was sent. Waiting for the run
      // to finish left a long run as one more "New chat" tab for its whole length,
      // indistinguishable from the empty ones around it.
      const conv = conversations.get(conversationId)
      if (conv && conv.title === 'New chat') {
        const label = workflow ? workflow.title : text.trim() || (attachments?.[0] ? attachmentLabel(attachments[0]) : '')
        if (label) {
          conv.title = titleFor(label)
          conversations.save(conv)
        }
      }
      const finished = get(conversationId).send(text, workflow, attachments)
      views.conversationsChanged()
      views.sessionsChanged()
      void finished.then(() => {
        views.conversationsChanged()
        views.sessionsChanged()
      })
    },

    /** Snapshot for one conversation: `connected` gates sending; `busy` and
     *  `queued` describe that conversation's own turn, not a global one. */
    snapshot(id) {
      const state = deps.connection.state
      const connected = state.status === 'connected'
      const session = id ? sessions.get(id) : undefined
      const busy = session?.busy === true
      const queued = session?.queued ?? 0

      const base: SessionSnapshot = {
        connection: state.status,
        detail: describeState(state),
        // Sending only needs a connection — a queued turn is allowed while busy.
        canSend: connected,
        busy,
        queued,
      }
      if ('url' in state && state.url) base.serverUrl = state.url
      const model = session?.currentModel
      if (model) base.model = model
      const project = connected ? deps.project() : null
      if (project) base.project = { id: project.id, name: project.name }
      const tracker = connected ? contextFor(deps.connection.activeClient) : null
      if (tracker) base.vision = tracker.vision
      const configured = deps.configuredUrl().trim()
      if (configured) base.configuredUrl = configured
      return base
    },

    firstWaiting: () => attention.firstWaiting(),
  }
}

/** A chat's title from what was sent first: one line, at most 40 characters. */
export function titleFor(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, ' ')
  return cleaned.length <= 40 ? cleaned : cleaned.slice(0, 37).trimEnd() + '…'
}
