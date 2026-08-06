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
export const PROTOCOL_VERSION = 1

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
  stats?: TurnStats
}

export interface TurnStats {
  tokensPerSecond?: number
  promptTokens?: number
  completionTokens?: number
  /** 'stop', 'length', 'tool_calls' … straight from the model. */
  finishReason?: string
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
  /** False whenever sending would fail: not connected, or a turn is running. */
  canSend: boolean
  /** True while a turn is streaming, so the UI can offer Stop. */
  busy: boolean
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
  /** Delegate to an extension command — the webview never drives connection or
   *  auth logic itself, it only asks for the command the user clicked. */
  | { type: 'runCommand'; command: 'connect' | 'signIn' | 'showStatus' }

// ---------------------------------------------------------------------------
// host → webview
// ---------------------------------------------------------------------------

export type HostMessage =
  /** Full state handoff in reply to `ready`. Always safe to apply from scratch. */
  | { type: 'init'; protocolVersion: number; session: SessionSnapshot; messages: ChatMessageView[] }
  | { type: 'session'; session: SessionSnapshot }
  /** Replace the whole transcript (new conversation, restore, compaction). */
  | { type: 'conversation'; messages: ChatMessageView[] }
  /** A message was added — user prompt or the empty assistant turn about to stream. */
  | { type: 'message'; message: ChatMessageView }
  | { type: 'turn/delta'; id: string; channel: StreamChannel; text: string }
  | { type: 'turn/completed'; id: string; stats?: TurnStats; aborted?: boolean }
  | { type: 'turn/failed'; id: string; message: string }
  /** Non-fatal notice to show inline (e.g. a server-side tool denial in Phase 2). */
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string }

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
    case 'runCommand':
      return msg.command === 'connect' || msg.command === 'signIn' || msg.command === 'showStatus'
        ? { type: 'runCommand', command: msg.command }
        : null
    default:
      return null
  }
}
