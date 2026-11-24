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
  type AttachmentView,
  type ChatMessageView,
  type ConversationState,
  type ConversationView,
  type HostMessage,
  type PageName,
  type ProjectView,
  type SessionSnapshot,
  type WorkflowView,
} from '../chat/protocol.ts'
import type { SettingView } from '../chat/settings.ts'
import { appendPart } from '../chat/turn-parts.ts'

export interface HistoryItem {
  id: string
  title: string
  lastAccessedAt: number
  messageCount: number
  /** Only an unsent draft, no messages. */
  draft?: boolean
  /** Still open in a tab. */
  open?: boolean
  /** Its run is still going. */
  running?: boolean
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
  /** A page that takes over the panel, or null for the chat. */
  page: PageName | null
  /** null while loading (or never loaded). */
  projects: { items: ProjectView[] | null; linkedId: string | null; error?: string }
  workflows: { items: WorkflowView[] | null; error?: string }
  /** null until the host first sends them. */
  settings: SettingView[] | null
  /** Set when the host was built with a different protocol: the panel is stale. */
  stale: boolean
  /** Bumped when the whole transcript is replaced, so the view can jump to the
   *  end instead of following. */
  generation: number
  /** The @ picker's last answer from the host. */
  fileMatches: { query: string; paths: string[] } | null
  /** Chips the host asked the composer to add (Add to Yellowscript), not yet taken. */
  inbox: AttachmentView[]
  /** Text the host handed back to the composer (queued messages Stop did not send), not yet taken. */
  composerText: string | null
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
    page: null,
    projects: { items: null, linkedId: null },
    workflows: { items: null },
    settings: null,
    stale: false,
    generation: 0,
    fileMatches: null,
    inbox: [],
    composerText: null,
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
          ? { ...m, content: m.content + message.text, parts: appendPart(m.parts, { kind: 'text', text: message.text }) }
          : {
              ...m,
              reasoning: (m.reasoning ?? '') + message.text,
              parts: appendPart(m.parts, { kind: 'reasoning', text: message.text }),
            },
      )

    case 'composerText':
      if (elsewhere(state, message.conversationId)) return state
      return { ...state, composerText: state.composerText ? `${state.composerText}\n\n${message.text}` : message.text }

    case 'turn/notice':
      if (elsewhere(state, message.conversationId)) return state
      return patch(state, message.id, (m) => ({ ...m, parts: appendPart(m.parts, { kind: 'notice', text: message.text }) }))

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
          parts: appendPart(m.parts, { kind: 'tool', callId: message.callId }),
        }
      })

    case 'tool/result':
      if (elsewhere(state, message.conversationId)) return state
      return patch(state, message.turnId, (m) => ({
        ...m,
        tools: (m.tools ?? []).map((t) =>
          t.callId === message.callId
            ? {
                ...t,
                status: message.isError ? 'error' : 'done',
                summary: message.summary,
                truncated: message.truncated,
                ...(message.output ? { output: message.output } : {}),
              }
            : t,
        ),
        ...(message.effect ? { run: [...(m.run ?? []), message.effect] } : {}),
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
      return { ...state, page: null, history: { open: true, items: [...message.conversations] } }

    case 'projects':
      return {
        ...state,
        projects: {
          items: message.projects,
          linkedId: message.linkedId,
          ...(message.error ? { error: message.error } : {}),
        },
      }

    case 'workflows':
      return { ...state, workflows: { items: message.workflows, ...(message.error ? { error: message.error } : {}) } }

    case 'settings':
      return { ...state, settings: [...message.settings] }

    case 'fileMatches':
      return { ...state, fileMatches: { query: message.query, paths: message.paths } }

    case 'addAttachment':
      return { ...state, inbox: [...state.inbox, message.attachment] }

    case 'showPage':
      return { ...state, page: message.page, history: { ...state.history, open: false } }
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

/** Why a typed Nest address will not do, or null when it will. Empty is fine:
 *  it means discovery. Mirrors normalizeBaseUrl (a bare host gets http://). */
export function serverUrlProblem(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const url = new URL(withScheme)
    return url.hostname ? null : 'That is not a valid URL.'
  } catch {
    return 'That is not a valid URL.'
  }
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

/** Workflows whose name or title starts with (then contains) what follows `/`. */
export function matchWorkflows(items: readonly WorkflowView[], typed: string): WorkflowView[] {
  const q = typed.trim().toLowerCase()
  if (!q) return [...items]
  const starts = items.filter((w) => w.name.toLowerCase().startsWith(q) || w.title.toLowerCase().startsWith(q))
  const contains = items.filter(
    (w) => !starts.includes(w) && (w.name.toLowerCase().includes(q) || w.title.toLowerCase().includes(q)),
  )
  return [...starts, ...contains]
}

/** What the composer is typing when it is a `/workflow` command, or null. */
export function slashQuery(text: string): string | null {
  const m = /^\/([\w-]*)$/.exec(text)
  return m ? (m[1] ?? '') : null
}

/**
 * The newest assistant turn whose run made a checkpointed write: the only
 * task summary that offers Revert, since undoing an older task would also
 * undo every later change to the same files.
 */
export function latestTaskId(messages: readonly ChatMessageView[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.run?.some((e) => e.kind === 'write' && e.applied && e.checkpoint)) return m.id
  }
  return null
}

/**
 * The @ query being typed at the end of `beforeCaret` ("look at @src/ga" →
 * "src/ga"), or null when the caret is not in one.
 */
export function atQuery(beforeCaret: string): string | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(beforeCaret)
  return m ? m[2]! : null
}

/** The size to draw an image at so its longer edge is at most `max`. */
export function fitWithin(width: number, height: number, max = 1_280): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

/** "12.3k" for the context meter. */
export function compactTokens(n: number): string {
  if (n < 1_000) return String(n)
  const k = n / 1_000
  return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`
}

/** The context meter: how full, as a fraction, and what to say. */
export function contextMeter(usage: { used: number; size: number | null; trimmed?: number } | null | undefined): {
  fraction: number | null
  label: string
  title: string
  level: 'ok' | 'high' | 'full'
} | null {
  if (!usage) return null
  const fraction = usage.size ? Math.min(1, usage.used / usage.size) : null
  const label = usage.size ? `${Math.round((fraction ?? 0) * 100)}%` : compactTokens(usage.used)
  const level = fraction === null ? 'ok' : fraction >= 0.85 ? 'full' : fraction >= 0.6 ? 'high' : 'ok'
  const lines = [
    usage.size
      ? `Context: ${compactTokens(usage.used)} of ${compactTokens(usage.size)} tokens in the last request`
      : `Context: ${compactTokens(usage.used)} tokens in the last request (window size unknown)`,
  ]
  if (usage.trimmed) lines.push(`Older tool results were trimmed to fit ${usage.trimmed} time${usage.trimmed === 1 ? '' : 's'} in the latest run.`)
  else if (level === 'full') lines.push('Near the limit: older tool results will be trimmed to fit.')
  return { fraction, label, title: lines.join('\n'), level }
}

/** What a streaming turn is waiting on, for the line under it; null while
 *  tokens are arriving. `idleMs` is the time since anything last arrived. */
export function waitingNote(idleMs: number, afterTool: boolean): string | null {
  if (idleMs < 3_000) return null
  const seconds = Math.floor(idleMs / 1_000)
  const what = afterTool ? 'Waiting for the model to read the result' : 'Waiting for the model'
  // llama-server queues a request while its slots are busy: nothing arrives,
  // with no error, until another chat's reply finishes.
  return seconds >= 15
    ? `${what} · ${seconds}s. The Nest may be busy with another request; this one starts when it is free.`
    : `${what} · ${seconds}s`
}

/** A command tool's card, read for the terminal-style view. */
export interface CommandCardView {
  /** The line that ran (or would have), or the process it read. */
  command: string
  cwd?: string
  /** Started in the background (ys_process start). */
  background: boolean
  /** Reading a background process's output (ys_process output). */
  read: boolean
  /** How it ended: "Exit code 0 · 1.2s", "Timed out…", "p1 (…) is running.". */
  status?: string
  /** What it printed, without the head line and the stdout marker. */
  output: string
}

/** The terminal view of a command card, or null for any other tool. */
export function commandView(card: { name: string; arguments: string; output?: string }): CommandCardView | null {
  if (card.name !== 'ys_run_command' && card.name !== 'ys_process') return null
  let args: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(card.arguments || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
  } catch {
    // Malformed: the card still shows what there is.
  }
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined)
  const action = card.name === 'ys_process' ? str('action') : undefined
  if (card.name === 'ys_process' && action !== 'start' && action !== 'output') return null
  const read = action === 'output'
  const command = read ? `output of ${str('id') ?? 'a process'}` : (str('command') ?? '')
  const cwd = str('cwd')
  const lines = (card.output ?? '').split('\n')
  const status = card.output ? lines.shift()?.trim() : undefined
  const output = lines
    .filter((l) => l !== '--- stdout ---' && l !== '--- output ---')
    .join('\n')
    .replace(/^\(no (new )?output\)$/, '')
    .trim()
  return {
    command,
    ...(cwd ? { cwd } : {}),
    background: action === 'start',
    read,
    ...(status ? { status } : {}),
    output,
  }
}
