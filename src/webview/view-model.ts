// =============================================================================
// The webview's view model — host messages in, view state out.
// =============================================================================
// A pure reducer, so the panel's behaviour is testable under `node --test`
// with no DOM and no Svelte: the components only read `ViewState` and post
// `WebviewMessage`s. The rule from protocol.ts holds here too: the HOST is the
// source of truth. Everything in this state can be rebuilt from an `init`, and
// is, every time VSCode recreates the view.
//
// Each apply returns a new state object (never mutates), which is what lets
// the Svelte store swap it in one assignment.
// =============================================================================

import {
  EMPTY_CONVERSATION_STATE,
  PROTOCOL_VERSION,
  type ChatMessageView,
  type ConversationState,
  type ConversationView,
  type HostMessage,
  type SessionSnapshot,
} from '../chat/protocol.ts'

export interface HistoryItem {
  id: string
  title: string
  lastAccessedAt: number
  messageCount: number
}

export interface Notice {
  id: number
  level: 'info' | 'warning' | 'error'
  message: string
}

export interface ViewState {
  session: SessionSnapshot
  /** The conversation on screen. Messages for any other are dropped: the host
   *  keeps every transcript and repaints on switch. */
  conversationId: string | null
  messages: ChatMessageView[]
  conversation: ConversationState
  tabs: ConversationView[]
  notices: Notice[]
  history: { open: boolean; items: HistoryItem[] }
  /** Set when the host was built with a different protocol: the panel is stale. */
  stale: boolean
  /** Bumped when the whole transcript is replaced, so the view can jump to the
   *  end instead of following. */
  generation: number
}

export function initialViewState(): ViewState {
  return {
    session: { connection: 'disconnected', detail: 'Starting…', canSend: false, busy: false, queued: 0 },
    conversationId: null,
    messages: [],
    conversation: EMPTY_CONVERSATION_STATE,
    tabs: [],
    notices: [],
    history: { open: false, items: [] },
    stale: false,
    generation: 0,
  }
}

let noticeId = 0

/** Update one message by id; a no-op when it is not on screen. */
function patch(state: ViewState, id: string, change: (m: ChatMessageView) => ChatMessageView): ViewState {
  let hit = false
  const messages = state.messages.map((m) => {
    if (m.id !== id) return m
    hit = true
    return change(m)
  })
  return hit ? { ...state, messages } : state
}

/** True when a per-conversation message is for some other tab. */
function elsewhere(state: ViewState, conversationId: string): boolean {
  return conversationId !== state.conversationId
}

export function applyHostMessage(state: ViewState, message: HostMessage): ViewState {
  switch (message.type) {
    case 'init':
      if (message.protocolVersion !== PROTOCOL_VERSION) return { ...state, stale: true }
      return {
        ...state,
        stale: false,
        session: message.session,
        conversationId: message.conversationId ?? state.conversationId,
        messages: message.messages,
        conversation: message.state,
        notices: [],
        generation: state.generation + 1,
      }

    case 'session':
      return { ...state, session: message.session }

    case 'conversation':
      if (elsewhere(state, message.conversationId)) return state
      return {
        ...state,
        messages: message.messages,
        conversation: message.state,
        notices: [],
        generation: state.generation + 1,
      }

    case 'conversationState':
      if (elsewhere(state, message.conversationId)) return state
      return { ...state, conversation: message.state }

    case 'conversationList':
      return {
        ...state,
        tabs: message.conversations,
        conversationId: message.activeId ?? state.conversationId,
      }

    case 'activeConversationChanged':
      return { ...state, conversationId: message.id }

    case 'message': {
      if (elsewhere(state, message.conversationId)) return state
      const exists = state.messages.some((m) => m.id === message.message.id)
      // Same id = the same bubble (a queued prompt flipping to active).
      return exists
        ? patch(state, message.message.id, () => message.message)
        : { ...state, messages: [...state.messages, message.message] }
    }

    case 'turn/delta':
      if (elsewhere(state, message.conversationId)) return state
      return patch(state, message.id, (m) =>
        message.channel === 'content'
          ? { ...m, content: m.content + message.text }
          : { ...m, reasoning: (m.reasoning ?? '') + message.text },
      )

    case 'turn/completed':
      if (elsewhere(state, message.conversationId)) return state
      return patch(state, message.id, (m) => {
        const next: ChatMessageView = { ...m, streaming: false }
        if (message.stats) next.stats = message.stats
        if (message.aborted) next.aborted = true
        return next
      })

    case 'turn/failed':
      if (elsewhere(state, message.conversationId)) return state
      return patch(state, message.id, (m) => ({ ...m, streaming: false, error: message.message }))

    case 'tool/call':
      if (elsewhere(state, message.conversationId)) return state
      return patch(state, message.turnId, (m) => {
        const tools = m.tools ?? []
        if (tools.some((t) => t.callId === message.callId)) return m
        return {
          ...m,
          tools: [
            ...tools,
            {
              callId: message.callId,
              name: message.name,
              arguments: message.arguments,
              recovered: message.recovered,
              status: 'running',
            },
          ],
        }
      })

    case 'tool/result':
      if (elsewhere(state, message.conversationId)) return state
      return patch(state, message.turnId, (m) => ({
        ...m,
        tools: (m.tools ?? []).map((t) =>
          t.callId === message.callId
            ? { ...t, status: message.isError ? 'error' : 'done', summary: message.summary, truncated: message.truncated }
            : t,
        ),
      }))

    case 'notice':
      return {
        ...state,
        notices: [...state.notices, { id: ++noticeId, level: message.level, message: message.message }],
      }

    case 'tools':
      return state

    case 'historyList':
      return { ...state, history: { ...state.history, items: [...message.conversations] } }

    case 'showHistoryPanel':
      return { ...state, history: { open: true, items: [...message.conversations] } }
  }
}

/** What the composer's placeholder says. */
export function composerPlaceholder(state: ViewState): string {
  const { session, conversation } = state
  if (!session.canSend) return 'Connect to a Redstart Nest to start.'
  if (conversation.question) return 'Type your answer, or pick one above…'
  if (session.queued > 0) return `Queued: ${session.queued} prompt${session.queued === 1 ? '' : 's'} waiting…`
  if (session.busy) return 'Working. Type to queue another prompt…'
  return 'Ask Yellowscript…'
}

/** "2 of 5 done" for the plan header. */
export function planProgress(steps: readonly { status: string }[]): { open: number; label: string } {
  const finished = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length
  return { open: steps.length - finished, label: `${finished} of ${steps.length} done` }
}

/** The arguments as one short line for a tool card. */
export function argumentsPreview(raw: string, max = 80): string {
  let text = raw.trim()
  try {
    const parsed: unknown = JSON.parse(text || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>)
      if (entries.length === 0) return ''
      // A single path-like argument reads best on its own.
      if (entries.length === 1 && typeof entries[0]![1] === 'string') text = entries[0]![1] as string
      else text = entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')
    }
  } catch {
    // Not JSON: show what the model wrote.
  }
  text = text.replace(/\s+/g, ' ')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The answer a question card sends, or null when there is nothing to send. */
export function buildAnswer(selected: readonly string[], text: string): { chosen?: string[]; text?: string } | null {
  const trimmed = text.trim()
  if (selected.length === 0 && !trimmed) return null
  return {
    ...(selected.length > 0 ? { chosen: [...selected] } : {}),
    ...(trimmed ? { text: trimmed } : {}),
  }
}
