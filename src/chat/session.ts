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
}

export class ChatSession {
  private readonly deps: SessionDeps
  private messages: ChatMessageView[] = []
  private controller: AbortController | null = null
  private model: string | null = null

  constructor(deps: SessionDeps) {
    this.deps = deps
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
    this.messages = []
    this.deps.emit({ type: 'conversation', messages: this.messages })
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
   */
  async send(text: string): Promise<void> {
    const prompt = text.trim()
    if (!prompt) return

    if (this.busy) {
      this.deps.emit({ type: 'notice', level: 'warning', message: 'A response is still streaming.' })
      return
    }

    const client = this.deps.getClient()
    if (!client) {
      this.deps.emit({
        type: 'notice',
        level: 'error',
        message: 'Not connected to a Redstart Nest.',
      })
      return
    }

    const userMessage: ChatMessageView = { id: this.nextId(), role: 'user', content: prompt }
    this.messages.push(userMessage)
    this.deps.emit({ type: 'message', message: userMessage })

    const turn: ChatMessageView = { id: this.nextId(), role: 'assistant', content: '', streaming: true }
    this.messages.push(turn)
    this.deps.emit({ type: 'message', message: turn })

    const controller = new AbortController()
    this.controller = controller

    try {
      const result = await client.streamChatCompletion(
        this.buildRequest(),
        {
          onContent: (chunk) => {
            turn.content += chunk
            this.deps.emit({ type: 'turn/delta', id: turn.id, channel: 'content', text: chunk })
          },
          onReasoning: (chunk) => {
            turn.reasoning = (turn.reasoning ?? '') + chunk
            this.deps.emit({ type: 'turn/delta', id: turn.id, channel: 'reasoning', text: chunk })
          },
          onModel: (model) => {
            this.model = model
          },
        },
        controller.signal,
      )

      turn.streaming = false
      turn.aborted = result.aborted
      const stats = buildStats(result.timings, result.finishReason)
      if (stats) turn.stats = stats

      // A turn that produced nothing at all is not a success. Silence reads as
      // a broken extension; say what actually happened.
      if (!result.content && !result.reasoning && !result.aborted) {
        turn.error = 'The model returned an empty response.'
      }

      this.deps.emit({
        type: 'turn/completed',
        id: turn.id,
        ...(stats ? { stats } : {}),
        ...(result.aborted ? { aborted: true } : {}),
      })
    } catch (err) {
      turn.streaming = false
      const message = describeFailure(err)
      turn.error = message
      this.deps.emit({ type: 'turn/failed', id: turn.id, message })

      if (err instanceof NestHttpError && err.isUnauthorized) {
        // Mid-conversation 401: the Nest was almost certainly restarted. Hand
        // off to the connection manager so the user gets a sign-in prompt
        // instead of a dead panel.
        await this.deps.onUnauthorized()
      }
    } finally {
      if (this.controller === controller) this.controller = null
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
  private buildRequest(): ChatCompletionRequest {
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
