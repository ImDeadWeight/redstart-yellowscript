// =============================================================================
// SSE parsing for /v1/chat/completions.
// =============================================================================
// llama.cpp streams OpenAI-shaped chunks as `data: {...}` lines terminated by a
// `data: [DONE]` sentinel. Two things about this stream are specific to Nest and
// easy to get wrong:
//
//  1. Reasoning models emit their thinking on `delta.reasoning_content`, a
//     SEPARATE channel from `delta.content`. It has to be captured, because from
//     Phase 2 onward tool calls hide in there — a model will emit the whole call
//     inside its thinking and then merely *claim* in the answer that it ran.
//     Dropping the reasoning stream makes that impossible to detect.
//
//  2. Timings arrive at the TOP LEVEL of a chunk (`chunk.timings`), not inside
//     `choices`. They stream repeatedly, and the last one wins.
//
// Everything here is pure: a byte-splitter and a chunk-shape reader, both
// unit-tested without a server.
// =============================================================================

/** Which stream a piece of text came from. Phase 2 adds tool calls as their own
 *  message type rather than a third channel — they are structured, not text. */
export type StreamChannel = 'content' | 'reasoning'

/** llama.cpp's timing block. Fields are all optional — a chunk may carry a
 *  partial block, and older builds omit some entirely. */
export interface StreamTimings {
  prompt_n?: number
  prompt_ms?: number
  predicted_n?: number
  predicted_ms?: number
  predicted_per_second?: number
  cache_n?: number
}

/** Progress while the prompt is still being evaluated (before any token). */
export interface PromptProgress {
  cache: number
  processed: number
  total: number
  time_ms: number
}

/** A raw `tool_calls` delta. Carried through unparsed in Phase 1 — the agent
 *  loop in Phase 2 is what assembles and executes them. */
export interface ToolCallDelta {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

export interface ParsedChunk {
  content?: string
  reasoning?: string
  toolCalls?: ToolCallDelta[]
  timings?: StreamTimings
  promptProgress?: PromptProgress
  model?: string
  finishReason?: string
}

/**
 * Splits a byte stream into complete `data:` payloads.
 *
 * A network chunk can end anywhere — mid-JSON, mid-line, between the `\r` and
 * the `\n`. Buffering until a line is actually complete is the whole job; doing
 * this inline in the read loop is where truncated-JSON bugs come from.
 */
export class SseParser {
  private buffer = ''

  /** Feed raw text; get back every complete `data:` payload it completed. */
  push(chunk: string): string[] {
    this.buffer += chunk
    const payloads: string[] = []

    let newlineIndex: number
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newlineIndex + 1)

      if (line.startsWith('data:')) {
        // The space after the colon is conventional, not guaranteed.
        payloads.push(line.slice(5).trimStart())
      }
      // Blank lines are event separators and comment lines start with ':' —
      // both are noise for our purposes.
    }

    return payloads
  }

  /** Anything left unterminated when the stream ended. */
  flush(): string[] {
    const remainder = this.buffer.trim()
    this.buffer = ''
    if (remainder.startsWith('data:')) {
      const payload = remainder.slice(5).trimStart()
      return payload ? [payload] : []
    }
    return []
  }
}

export const DONE_SENTINEL = '[DONE]'

/**
 * Read one chunk payload into the pieces we care about.
 *
 * Returns null for `[DONE]` and for anything unparseable. Malformed JSON mid
 * stream is not worth aborting a turn over — a dropped chunk costs a few tokens,
 * a thrown error costs the whole response.
 */
export function parseStreamChunk(payload: string): ParsedChunk | null {
  if (payload === DONE_SENTINEL) return null

  let raw: unknown
  try {
    raw = JSON.parse(payload)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null

  const chunk = raw as Record<string, any>
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
  const delta = choice?.delta

  const parsed: ParsedChunk = {}

  if (typeof delta?.content === 'string' && delta.content.length > 0) {
    parsed.content = delta.content
  }
  if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
    parsed.reasoning = delta.reasoning_content
  }
  if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
    parsed.toolCalls = delta.tool_calls as ToolCallDelta[]
  }
  if (typeof choice?.finish_reason === 'string') {
    parsed.finishReason = choice.finish_reason
  }
  if (typeof chunk.model === 'string' && chunk.model.length > 0) {
    parsed.model = chunk.model
  }
  if (chunk.timings && typeof chunk.timings === 'object') {
    parsed.timings = chunk.timings as StreamTimings
  }
  if (chunk.prompt_progress && typeof chunk.prompt_progress === 'object') {
    parsed.promptProgress = chunk.prompt_progress as PromptProgress
  }

  return parsed
}

/**
 * Generation speed in tokens/second, or null when the timings can't support the
 * claim.
 *
 * Prefer llama.cpp's own `predicted_per_second`; fall back to computing it.
 * A zero `predicted_ms` would divide to Infinity and render as a nonsense
 * status-bar number, so it is treated as "unknown" instead.
 */
export function tokensPerSecond(timings: StreamTimings | undefined): number | null {
  if (!timings) return null

  if (typeof timings.predicted_per_second === 'number' && Number.isFinite(timings.predicted_per_second)) {
    return timings.predicted_per_second
  }

  const { predicted_n: n, predicted_ms: ms } = timings
  if (typeof n !== 'number' || typeof ms !== 'number' || ms <= 0 || n <= 0) return null
  return (n / ms) * 1000
}
