// =============================================================================
// ChatSession — the conversation, and the turn currently streaming into it.
// =============================================================================
// Owns the transcript and the request/abort lifecycle. Emits protocol messages
// rather than touching a webview directly, so it can be driven entirely by
// tests: the whole streaming lifecycle is exercised below with a fake client and
// no extension host.
//
// Phase 2 replaces `runTurn` with an agent loop (stream → tool_calls → approval
// → execute → repeat). The seam is deliberate: everything about the transcript,
// abort handling, and error reporting stays put, and the loop slots in where the
// single `streamChatCompletion` call is today.
//
// No `vscode` import.
// =============================================================================

import { NestHttpError } from '../nest/types.ts'
import { tokensPerSecond, type StreamTimings } from '../nest/streaming.ts'
import type { ChatCompletionRequest, NestClient } from '../nest/client.ts'
import type { ChatMessageView, HostMessage, TurnStats } from './protocol.ts'
import { runAgentLoop, type ApprovalGate, type CommandApprovalGate } from '../agent/loop.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { ToolContext } from '../tools/types.ts'

/** Outbound protocol messages, before the owning conversation's id is tagged
 *  on. Distributes the `conversationId` omission across the union so callers can
 *  build a message without it and let ChatSession attach it. */
type OutboundMessage = HostMessage extends infer T ? (T extends { conversationId: string } ? Omit<T, 'conversationId'> : T) : never

/**
 * How the assistant's own thinking is treated on the NEXT request.
 *
 * Sending it back keeps llama.cpp's prompt cache warm (the prefix matches, so
 * the turn starts generating almost immediately). Dropping it saves context,
 * which on a 32k-context local model is the scarcer resource once a
 * conversation runs long. Nest's chat-ui makes this a user setting; Phase 1
 * defaults to dropping it and revisits when context compaction lands.
 */
const INCLUDE_REASONING_IN_CONTEXT = false

export interface SessionDeps {
  /** Resolves the currently connected client, or null when not connected. */
  getClient: () => NestClient | null
  /** Called when a request comes back 401 so the connection can re-prompt. */
  onUnauthorized: () => void | Promise<void>
  emit: (message: HostMessage) => void
  /** Injected so tests get deterministic ids. */
  newId?: () => string
  /**
   * The ws_* tools, and the workspace they act on.
   *
   * Optional, and absent means a plain conversation with no tools — which is
   * not a degraded mode but a legitimate one: with no folder open there is
   * nothing for a workspace tool to do, and offering tools that can only
   * refuse teaches the model to keep trying them. It also keeps every Phase 1
   * test meaningful without rewriting them around a registry.
   */
  tools?: () => ToolRegistry | null
  toolContext?: () => ToolContext
  /** Phase 3: gate for a write tool's planned change. When set, a tool result
   *  carrying a `pendingWrite` is routed through it for checkpoint + review. */
  approveChange?: ApprovalGate
  /** Phase 4.1: gate for a command tool's planned command. When set, a tool
   *  result carrying a `pendingCommand` is routed through it (always-ask). */
  approveCommand?: CommandApprovalGate
  /**
   * The conversation this session owns. Every protocol message it emits is
   * tagged with this id so the webview can route a delta to the right tab even
   * when that tab is not the one on screen.
   */
  conversationId: string
  /**
   * Called whenever the transcript changes durably (a prompt is queued or sent,
   * a turn ends) so the host can persist it without polling. The session passes
   * no payload — the host reads `snapshot()` for the conversation it owns.
   */
  onPersist?: () => void
}

export class ChatSession {
  private readonly deps: SessionDeps
  private messages: ChatMessageView[] = []
  private controller: AbortController | null = null
  private model: string | null = null
  /** Prompts waiting behind a turn that is still streaming. Drained in order
   *  when the turn finishes, so a user can line up several asks per tab. */
  private pending: { id: string; prompt: string }[] = []

  constructor(deps: SessionDeps) {
    this.deps = deps
  }

  /** Prompts queued behind the running turn, for the tab strip / composer. */
  get queued(): number {
    return this.pending.length
  }

  /** Emit, tagging the message with this conversation's id. Every transcript
   *  message carries it so the webview can route deltas to the right tab. */
  private emit(message: OutboundMessage): void {
    this.deps.emit({ ...message, conversationId: this.deps.conversationId } as HostMessage)
  }

  get transcript(): ChatMessageView[] {
    return this.messages
  }

  get busy(): boolean {
    return this.controller !== null
  }

  get currentModel(): string | null {
    return this.model
  }

  /** Discard the conversation. Aborts a turn in flight rather than orphaning it. */
  reset(): void {
    this.abort()
    this.pending = []
    this.messages = []
    this.emit({ type: 'conversation', messages: [] })
    this.deps.onPersist?.()
  }

  /**
   * Replace the transcript with an existing conversation's messages. Used to
   * seed a session from the store (e.g. on open) — deliberately does NOT abort,
   * because a turn that is already streaming belongs to this same conversation
   * and must be allowed to finish. Switching tabs never calls this; it is a
   * pure view change handled by the host.
   */
  load(messages: ChatMessageView[]): void {
    this.messages = messages.map((message) => ({ ...message }))
    this.emit({ type: 'conversation', messages: this.messages })
  }

  /** A snapshot of the transcript, safe to hand across the webview boundary. */
  snapshot(): ChatMessageView[] {
    return this.messages.map((message) => ({ ...message }))
  }

  /** Stop the running turn. Whatever streamed so far stays on screen — the user
   *  asked it to stop, not to throw the answer away. */
  abort(): void {
    this.controller?.abort()
    this.controller = null
  }

  /**
   * Send a prompt and stream the reply.
   *
   * Never throws: every failure becomes a `turn/failed` message plus an error
   * recorded on the assistant turn. A rejected promise here would surface as an
   * unhandled rejection in the extension host, which the user never sees.
   *
   * While a turn is already streaming this queues the prompt behind it (shown
   * in order, greyed) instead of dropping it or aborting the running turn — so
   * a user can start a long ask and line up the next one in another tab or
   * below. Queued prompts drain in order as each turn finishes.
   */
  async send(text: string): Promise<void> {
    const prompt = text.trim()
    if (!prompt) return

    if (this.busy) {
      const id = this.nextId()
      this.pending.push({ id, prompt })
      this.emit({ type: 'message', message: { id, role: 'user', content: prompt, pending: true } })
      this.deps.onPersist?.()
      return
    }

    await this.runTurn({ id: this.nextId(), role: 'user', content: prompt })

    // Drain anything that queued up while this turn ran.
    while (this.pending.length > 0) {
      const next = this.pending.shift()!
      // Flip the queued user message to active: same id, pending cleared. The
      // webview updates the existing (greyed) bubble rather than adding a new
      // one.
      this.emit({ type: 'message', message: { id: next.id, role: 'user', content: next.prompt, pending: false } })
      await this.runTurn({ id: next.id, role: 'user', content: next.prompt })
    }
  }

  /**
   * Run one turn for `userMessage`. `runTurn` owns the transcript append, the
   * assistant placeholder, the request/abort lifecycle, and the final persist.
   */
  private async runTurn(userMessage: ChatMessageView): Promise<void> {
    const client = this.deps.getClient()
    if (!client) {
      this.emit({
        type: 'notice',
        level: 'error',
        message: 'Not connected to a Redstart Nest.',
      })
      return
    }

    this.messages.push(userMessage)
    this.emit({ type: 'message', message: { ...userMessage } })

    const turn: ChatMessageView = { id: this.nextId(), role: 'assistant', content: '', streaming: true }
    this.messages.push(turn)
    // Emit a copy. `turn` keeps mutating as the stream arrives, and a protocol
    // message is meant to be a snapshot of one moment — handing out the live
    // object makes "what did we send?" unanswerable for any in-process consumer
    // (tests, logging, a future transcript recorder). postMessage would clone it
    // anyway; this makes the guarantee true on both sides of the boundary.
    this.emit({ type: 'message', message: { ...turn } })
    this.deps.onPersist?.()

    const controller = new AbortController()
    this.controller = controller

    try {
      const handlers = {
        onContent: (chunk: string) => {
          turn.content += chunk
          this.emit({ type: 'turn/delta', id: turn.id, channel: 'content', text: chunk })
        },
        onReasoning: (chunk: string) => {
          turn.reasoning = (turn.reasoning ?? '') + chunk
          this.emit({ type: 'turn/delta', id: turn.id, channel: 'reasoning', text: chunk })
        },
        onModel: (model: string) => {
          this.model = model
        },
      }

      // The seam. With tools available the turn becomes a loop — stream,
      // execute, feed results back — and without them it stays the single
      // round trip Phase 1 shipped. Everything after this point is identical
      // either way, which is the whole reason the loop returns a
      // StreamResult-shaped object.
      const registry = this.deps.tools?.() ?? null
      const result = registry
        ? await runAgentLoop({
            client,
            request: this.buildRequest(registry),
            tools: registry,
            toolContext: this.deps.toolContext?.() ?? { workspaceRoots: [] },
            signal: controller.signal,
            approveChange: this.deps.approveChange,
            approveCommand: this.deps.approveCommand,
            handlers: {
              ...handlers,
              onToolCall: (call, recovered) => {
                this.emit({
                  type: 'tool/call',
                  turnId: turn.id,
                  callId: call.id,
                  name: call.function.name,
                  arguments: call.function.arguments,
                  recovered,
                })
              },
              onToolResult: (call, toolResult) => {
                this.emit({
                  type: 'tool/result',
                  turnId: turn.id,
                  callId: call.id,
                  name: call.function.name,
                  summary: toolResult.summary,
                  isError: toolResult.isError,
                  truncated: toolResult.truncated,
                })
              },
            },
          })
        : await client.streamChatCompletion(this.buildRequest(null), handlers, controller.signal)

      turn.streaming = false
      turn.aborted = result.aborted

      // Take the final text from the RESULT, not from what the delta handlers
      // happened to accumulate. The client already assembled the authoritative
      // string, and re-deriving it here duplicates that job for no gain — the
      // deltas exist to paint the screen as text arrives, not to be the record.
      // This also matters from Phase 2 on, where recovering a malformed tool
      // call operates on the complete text rather than on any single chunk.
      turn.content = result.content
      if (result.reasoning) turn.reasoning = result.reasoning

      const stats = buildStats(result.timings, result.finishReason)
      if (stats) turn.stats = stats

      // A turn that produced nothing at all is not a success. Silence reads as
      // a broken extension; say what actually happened.
      if (!result.content && !result.reasoning && !result.aborted) {
        turn.error = 'The model returned an empty response.'
      }

      this.emit({
        type: 'turn/completed',
        id: turn.id,
        ...(stats ? { stats } : {}),
        ...(result.aborted ? { aborted: true } : {}),
      })
    } catch (err) {
      turn.streaming = false
      const message = describeFailure(err)
      turn.error = message
      this.emit({ type: 'turn/failed', id: turn.id, message })

      if (err instanceof NestHttpError && err.isUnauthorized) {
        // Mid-conversation 401: the Nest was almost certainly restarted. Hand
        // off to the connection manager so the user gets a sign-in prompt
        // instead of a dead panel.
        await this.deps.onUnauthorized()
      }
    } finally {
      if (this.controller === controller) this.controller = null
      this.deps.onPersist?.()
    }
  }

  /**
   * Build the request body from the transcript.
   *
   * Turns that failed outright are excluded: replaying an error message back to
   * the model as if it were the assistant's own words teaches it to imitate the
   * failure. Aborted turns ARE included — partial text is still something the
   * assistant said, and dropping it would leave the user's follow-up
   * ("continue") with nothing to refer to.
   */
  private buildRequest(registry: ToolRegistry | null): ChatCompletionRequest {
    const messages: ChatCompletionRequest['messages'] = []

    for (const message of this.messages) {
      if (message.role === 'assistant') {
        if (message.error) continue
        if (!message.content && !message.reasoning) continue
        const entry: ChatCompletionRequest['messages'][number] = {
          role: 'assistant',
          content: message.content,
        }
        if (INCLUDE_REASONING_IN_CONTEXT && message.reasoning) {
          entry.reasoning_content = message.reasoning
        }
        messages.push(entry)
      } else {
        messages.push({ role: 'user', content: message.content })
      }
    }

    // No `tools` in Phase 1. That is load-bearing, not an omission: the gateway
    // only claims Nest capabilities in its injected system prompt when the
    // request actually carries tools, so a toolless request correctly produces a
    // model that does not believe it can call anything.
    return { messages }
  }

  private nextId(): string {
    return this.deps.newId ? this.deps.newId() : `m${Date.now()}${Math.random().toString(36).slice(2, 8)}`
  }
}

function buildStats(timings: StreamTimings | undefined, finishReason: string | undefined): TurnStats | undefined {
  const rate = tokensPerSecond(timings)
  if (rate === null && !timings && !finishReason) return undefined

  const stats: TurnStats = {}
  if (rate !== null) stats.tokensPerSecond = rate
  if (typeof timings?.prompt_n === 'number') stats.promptTokens = timings.prompt_n
  if (typeof timings?.predicted_n === 'number') stats.completionTokens = timings.predicted_n
  if (finishReason) stats.finishReason = finishReason
  return Object.keys(stats).length > 0 ? stats : undefined
}

/** Turn an exception into something worth putting in front of a user. */
function describeFailure(err: unknown): string {
  if (err instanceof NestHttpError) {
    if (err.isUnauthorized) return 'The Nest rejected the request — you need to sign in again.'
    if (err.isNoModel) return 'No model is running on the Nest. Start one and try again.'
    if (err.status === 0) return err.message
    return `The Nest returned an error (${err.status}): ${err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}
