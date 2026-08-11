// =============================================================================
// The extension ↔ webview message contract.
// =============================================================================
// This is the load-bearing interface of the whole extension: every later phase
// (tool approval cards, diff review, checkpoints, modes) adds message types
// here rather than changing the ones below. Four rules make that possible.
//
// 1. THE HOST IS THE SOURCE OF TRUTH; THE WEBVIEW IS A RENDERER.
//    VSCode destroys a webview's DOM whenever the panel is hidden, and rebuilds
//    it from scratch on reveal. So the webview owns no state it cannot be handed
//    again: on `ready` the host replies with a full `conversation` snapshot and
//    the webview redraws from zero. Anything the webview accumulated is a cache,
//    never the record.
//
// 2. EVERY STREAMING MESSAGE CARRIES ITS TURN id.
//    A late delta from an aborted turn must not append itself to the turn that
//    replaced it. In Phase 2 the same id is what attaches a tool-call card to
//    the right assistant message.
//
// 3. TEXT CHANNELS ARE TEXT; STRUCTURE GETS ITS OWN MESSAGE TYPE.
//    `content` and `reasoning` are both plain streamed text, so they share one
//    delta message discriminated by `channel`. Tool calls are structured, so in
//    Phase 2 they arrive as their own message type — resisting the temptation to
//    make them a third channel is what keeps that addition non-breaking.
//
// 4. NO SECRETS CROSS THE BOUNDARY.
//    The webview never receives a token, an API key, or an Authorization header.
//    The extension host owns every HTTP request. The gateway's CORS policy would
//    technically permit the webview to call the Nest directly; it must not.
//
// Both sides import these types, so a change that breaks one breaks the other's
// typecheck — which is the point.
// =============================================================================

import type { StreamChannel } from '../nest/streaming.ts'

/**
 * Bumped when a message shape changes incompatibly. The webview announces the
 * version it was built with; a mismatch means VSCode served a cached bundle
 * from a previous install, and the host says so rather than half-working.
 */
export const PROTOCOL_VERSION = 2

// ---------------------------------------------------------------------------
// Shared view model
// ---------------------------------------------------------------------------

export type ChatRole = 'user' | 'assistant'

/** One rendered message. `reasoning` is kept separate so the UI can collapse it
 *  and so it can be excluded from the next request's context if desired. */
export interface ChatMessageView {
  id: string
  role: ChatRole
  content: string
  reasoning?: string
  /** Set on a failed turn; rendered as an inline error rather than as content. */
  error?: string
  /** True while this turn is still streaming. */
  streaming?: boolean
  /** True when the user stopped this turn — partial content is still valid. */
  aborted?: boolean
  /** True while this prompt is queued behind a turn that is still running. It
   *  becomes part of the transcript (pending flips to false) when its turn
   *  starts, so a queued prompt shows in order, greyed, until then. */
  pending?: boolean
  stats?: TurnStats
}

export interface TurnStats {
  tokensPerSecond?: number
  promptTokens?: number
  completionTokens?: number
  /** 'stop', 'length', 'tool_calls' … straight from the model. */
  finishReason?: string
}

/** One conversation tab. `busy` and `queued` let the strip show a running tab
 *  and how many prompts are waiting behind it, without the webview tracking
 *  every conversation's stream. */
export interface ConversationView {
  id: string
  title: string
  busy: boolean
  queued: number
}

/**
 * Everything the webview needs to decide what to render around the transcript:
 * whether it can send, and what to say if it can't.
 *
 * A flattened projection of ConnectionState rather than the state itself — the
 * webview should not have to know the shape of the connection state machine,
 * and Phase 2 will add fields here (active tool count, approval mode) without
 * touching that machine.
 */
export interface SessionSnapshot {
  connection: 'disconnected' | 'discovering' | 'connecting' | 'unauthenticated' | 'connected' | 'error'
  /** Human-readable explanation of `connection`, ready to display. */
  detail: string
  /** Present once connected. Not a secret — but still only for display. */
  serverUrl?: string
  model?: string
  /** False whenever sending would fail: only when not connected. A queued turn
   *  is allowed even while `busy`, so this no longer depends on `busy`. */
  canSend: boolean
  /** True while the active conversation's turn is streaming, so the UI can offer Stop. */
  busy: boolean
  /** Prompts waiting behind the active conversation's running turn. */
  queued: number
}

// ---------------------------------------------------------------------------
// webview → host
// ---------------------------------------------------------------------------

export type WebviewMessage =
  /** Sent once per webview lifetime, after the DOM is built. The host answers
   *  with `init`. Also re-sent after VSCode rebuilds a hidden view. */
  | { type: 'ready'; protocolVersion: number }
  | { type: 'send'; text: string }
  | { type: 'abort' }
  | { type: 'newConversation' }
  | { type: 'listConversations' }
  | { type: 'switchConversation'; id: string }
  | { type: 'createConversation' }
  | { type: 'deleteConversation'; id: string }
  /** Delegate to an extension command — the webview never drives connection or
   *  auth logic itself, it only asks for the command the user clicked. */
  | { type: 'runCommand'; command: 'connect' | 'signIn' | 'showStatus' }
  /** Webview-side sign-in form submission. Carries credentials directly so the
   *  host can call the manager without native dialogs. */
  | { type: 'signIn'; method: 'password'; username: string; password: string }
  | { type: 'signIn'; method: 'apiKey'; key: string }
  | { type: 'signIn'; method: 'clientKey' }

// ---------------------------------------------------------------------------
// host → webview
// ---------------------------------------------------------------------------

export type HostMessage =
  /** Full state handoff in reply to `ready`. Always safe to apply from scratch. */
  | { type: 'init'; protocolVersion: number; session: SessionSnapshot; messages: ChatMessageView[]; conversationId: string | null }
  | { type: 'session'; session: SessionSnapshot }
   /** Replace the whole transcript (switch / restore). Now carries which tab it
    *  belongs to so a delta for a background tab can be dropped or buffered. */
   | { type: 'conversation'; conversationId: string; messages: ChatMessageView[] }
   /** The full list of local conversations, for the tab strip. */
   | { type: 'conversationList'; conversations: ConversationView[]; activeId: string | null }
   /** The active conversation changed (switch / create / delete). */
   | { type: 'activeConversationChanged'; id: string | null }
  /** A message was added — user prompt or the empty assistant turn about to stream. */
  | { type: 'message'; conversationId: string; message: ChatMessageView }
  | { type: 'turn/delta'; conversationId: string; id: string; channel: StreamChannel; text: string }
  | { type: 'turn/completed'; conversationId: string; id: string; stats?: TurnStats; aborted?: boolean }
  | { type: 'turn/failed'; conversationId: string; id: string; message: string }
  // Tool activity gets its own message types rather than a third text channel.
  // A tool call is STRUCTURE, and `turn/delta` carries text — repurposing it
  // would mean the renderer parsing prose to find out what ran. Both carry the
  // turn id so a late message from an aborted turn cannot attach itself to the
  // turn that replaced it.
  | { type: 'tool/call'; conversationId: string; turnId: string; callId: string; name: string; arguments: string; recovered: boolean }
  | {
      type: 'tool/result'
      conversationId: string
      turnId: string
      callId: string
      name: string
      /** One line for the card. The full output goes to the model, not here —
       *  a 20k-character file listing is not something to render in a chat
       *  bubble, and the user can open the file themselves. */
      summary: string
      isError: boolean
      truncated: boolean
    }
   /** Non-fatal notice to show inline (e.g. a server-side tool denial in Phase 2). */
   | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string }
   /** Phase 4: the current tool-set inventory (local ws_* + live Nest tools), sent
    *  so the webview can render the tool picker and grey out server-banned names.
    *  Each entry carries its origin so the card can show "runs on Nest" vs local. */
   | {
       type: 'tools'
       names: readonly string[]
     }

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Validate a message arriving from the webview.
 *
 * A webview is a browser context. Treat anything it posts as untrusted input and
 * check it structurally before acting — the alternative is a malformed message
 * throwing somewhere deep in the send path.
 */
export function parseWebviewMessage(value: unknown): WebviewMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const msg = value as Record<string, unknown>

  switch (msg.type) {
    case 'ready':
      return typeof msg.protocolVersion === 'number'
        ? { type: 'ready', protocolVersion: msg.protocolVersion }
        : null
    case 'send':
      return typeof msg.text === 'string' ? { type: 'send', text: msg.text } : null
    case 'abort':
      return { type: 'abort' }
    case 'newConversation':
      return { type: 'newConversation' }
    case 'listConversations':
      return { type: 'listConversations' }
    case 'switchConversation':
      return typeof msg.id === 'string' ? { type: 'switchConversation', id: msg.id } : null
    case 'createConversation':
      return { type: 'createConversation' }
    case 'deleteConversation':
      return typeof msg.id === 'string' ? { type: 'deleteConversation', id: msg.id } : null
    case 'runCommand':
      return msg.command === 'connect' || msg.command === 'signIn' || msg.command === 'showStatus'
        ? { type: 'runCommand', command: msg.command }
        : null
    case 'signIn':
      if (typeof msg.method !== 'string') return null
      if (msg.method === 'password') {
        return typeof msg.username === 'string' && typeof msg.password === 'string'
          ? { type: 'signIn', method: 'password', username: msg.username, password: msg.password }
          : null
      }
      if (msg.method === 'apiKey') {
        return typeof msg.key === 'string'
          ? { type: 'signIn', method: 'apiKey', key: msg.key }
          : null
      }
      if (msg.method === 'clientKey') {
        return { type: 'signIn', method: 'clientKey' }
      }
      return null
    default:
      return null
  }
}
