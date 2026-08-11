// =============================================================================
// The agent loop — stream, execute tools, feed results back, repeat.
// =============================================================================
// Replaces the single `streamChatCompletion` call in `ChatSession.send`. The
// seam was left there deliberately in Phase 1, so transcript handling, abort
// and error reporting stay exactly where they are: this module owns the
// round-trip cycle and nothing else.
//
// FOUR THINGS THIS HAS TO GET RIGHT:
//
// 1. TOOL CALLS ARRIVE IN FRAGMENTS. `delta.tool_calls` streams a name a few
//    characters at a time and arguments across many chunks, keyed by `index`.
//    They must be reassembled before anything can be executed — see
//    `assembleToolCalls`, which is where the off-by-one lives if it lives
//    anywhere.
//
// 2. A TURN WITH NO STRUCTURED CALLS IS NOT NECESSARILY A TURN WITH NO CALLS.
//    Local models emit them as plain text in half a dozen malformed shapes, and
//    a client that only reads `tool_calls` drops them — the model then narrates
//    work it never did. The vendored recovery parser is the fallback, and it
//    reads the reasoning stream too, because that is where the call often is.
//
// 3. EVERY TOOL RESULT MUST CARRY ITS `tool_call_id`. The model matches results
//    to calls by that id; without it a multi-call turn silently misattributes
//    which answer belongs to which question.
//
// 4. THE LOOP MUST TERMINATE. A model that keeps calling the same tool, or
//    responds to every result with another call, would otherwise run forever.
//    The cap is a hard stop and is reported rather than hidden — a turn that
//    ended because it ran out of iterations is not a turn that finished.
//
// No `vscode` import: the whole loop is testable against a fake streamer.
// =============================================================================

import type { ChatCompletionRequest, StreamHandlers, StreamResult } from '../nest/client.ts'
import type { ToolCall } from '../nest/types.ts'
import type { ToolCallDelta, StreamTimings } from '../nest/streaming.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { PendingCommand, PendingWrite, ToolContext, ToolResult } from '../tools/types.ts'
import { createApiToolCalls, parseToolCallsFromTurn } from './tool-call-parser.ts'

/**
 * How many model round trips one user message may cost.
 *
 * Each iteration is a full generation, so on a local model this is also a
 * wall-clock budget. Ten is enough for read → think → read again → answer,
 * and short enough that a loop caused by a confused model is noticed rather
 * than endured.
 */
export const DEFAULT_MAX_ITERATIONS = 10

/** Just the part of NestClient the loop needs, so tests can supply a fake. */
export interface CompletionStreamer {
  streamChatCompletion(
    request: ChatCompletionRequest,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<StreamResult>
}

export interface ToolRun {
  call: ToolCall
  result: ToolResult
  /** True when the call came from the recovery parser rather than from the
   *  structured `tool_calls` field. Worth surfacing: it means the model's
   *  output was malformed, and a UI that hides that hides a real signal. */
  recovered: boolean
}

export type StopReason =
  /** The model answered without asking for another tool. */
  | 'complete'
  /** The user cancelled. */
  | 'aborted'
  /** Hit the iteration cap with the model still calling tools. */
  | 'turn-cap'

export interface AgentResult {
  /** Everything the model said across all iterations, in order. */
  content: string
  reasoning: string
  toolRuns: ToolRun[]
  iterations: number
  stopReason: StopReason
  aborted: boolean
  timings?: StreamTimings
  model?: string
  finishReason?: string
}

export interface AgentLoopHandlers extends StreamHandlers {
  /** A call has been assembled and is about to run. */
  onToolCall?: (call: ToolCall, recovered: boolean) => void
  /** A call has finished. */
  onToolResult?: (call: ToolCall, result: ToolResult) => void
  /** A new round trip is starting; `iteration` is 1-based. */
  onIteration?: (iteration: number) => void
}

/**
 * The approval gate for a planned write.
 *
 * The write tools return a `PendingWrite` (a decoded, containment-checked change
 * that has NOT touched disk). The loop hands it to this gate, which the host
 * implements: checkpoint the pre-write state, show the native diff editor, wait
 * for the user's Apply/Reject, and — only on approve — materialise the bytes.
 *
 * Returning `true` means the change was applied; `false` means rejected (or a
 * per-workspace "always allow" was not granted and the user declined). The loop
 * reports the outcome honestly to the model either way. Kept as an injected port
 * so the whole loop stays testable with a scripted gate — the real one lives in
 * the host alongside `vscode`.
 */
export type ApprovalGate = (pending: PendingWrite) => Promise<boolean>

/**
 * The approval gate for a planned command (Phase 4.1). Unlike writes, a command
 * is always-ask (no "always allow"): the host shows it verbatim, runs it in the
 * integrated terminal on confirmation, captures the output, and returns it. The
 * returned string is the captured stdout/stderr to feed the model; `null` means the
 * user rejected it. Kept as an injected port for testability — the real one lives
 * in the host alongside `vscode`.
 */
export type CommandApprovalGate = (pending: PendingCommand) => Promise<string | null>

export interface AgentLoopOptions {
  client: CompletionStreamer
  /** The conversation so far. Not mutated — the loop works on a copy. */
  request: ChatCompletionRequest
  tools: ToolRegistry
  toolContext: ToolContext
  handlers?: AgentLoopHandlers
  signal?: AbortSignal
  maxIterations?: number
  /** Phase 3 write approval. When present, a tool result carrying a
   *  `pendingWrite` is routed through it before the loop continues. */
  approveChange?: ApprovalGate | undefined
  /** Phase 4.1 command approval. When present, a tool result carrying a
   *  `pendingCommand` is routed through it (always-ask) before the loop continues. */
  approveCommand?: CommandApprovalGate | undefined
}

/**
 * Reassemble streamed `tool_calls` fragments into complete calls.
 *
 * The wire format is a sequence of deltas keyed by `index`: the first usually
 * carries the id and the function name, and the rest carry successive slices of
 * the arguments string. Concatenation order is arrival order, which is why this
 * accumulates rather than merging by field.
 *
 * Calls with no name are dropped. A fragment can legitimately arrive before its
 * name (a chunk boundary in an awkward place) but a call that never gets one is
 * not executable, and inventing a default would run the wrong tool.
 */
export function assembleToolCalls(deltas: readonly ToolCallDelta[]): ToolCall[] {
  const byIndex = new Map<number, { id?: string; name: string; args: string }>()

  for (const delta of deltas) {
    // Index is what ties fragments together. Absent, treat it as the first
    // call rather than discarding the fragment: some servers omit it when
    // there is only ever one.
    const index = typeof delta.index === 'number' ? delta.index : 0
    const entry = byIndex.get(index) ?? { name: '', args: '' }

    if (typeof delta.id === 'string' && delta.id.length > 0) entry.id = delta.id
    if (typeof delta.function?.name === 'string' && delta.function.name.length > 0) {
      // Names arrive whole in practice, but concatenating is correct either
      // way and costs nothing.
      entry.name += delta.function.name
    }
    if (typeof delta.function?.arguments === 'string') entry.args += delta.function.arguments

    byIndex.set(index, entry)
  }

  const calls: ToolCall[] = []
  for (const [index, entry] of [...byIndex].sort((a, b) => a[0] - b[0])) {
    if (entry.name === '') continue
    calls.push({
      // An id is required to match the result back to the call. Servers
      // normally send one; synthesise a stable one when they do not.
      id: entry.id ?? `call_${index}_${entry.name}`,
      type: 'function',
      function: { name: entry.name, arguments: entry.args },
    })
  }
  return calls
}

/**
 * Run the model until it stops asking for tools.
 *
 * Returns rather than throws for every outcome the UI needs to render; a thrown
 * error from the client (a 401, a dead connection) still propagates, because
 * `ChatSession` already knows how to report those and this module should not
 * duplicate that.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentResult> {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const handlers = options.handlers ?? {}
  const toolPayload = options.tools.payload()

  // Worked on a copy: the caller's transcript is its own business, and the
  // assistant/tool messages appended here are loop bookkeeping that
  // ChatSession renders from `toolRuns` instead.
  const messages = [...options.request.messages]

  const contentParts: string[] = []
  const reasoningParts: string[] = []
  const toolRuns: ToolRun[] = []

  let iterations = 0
  let stopReason: StopReason = 'complete'
  let aborted = false
  let last: StreamResult | undefined

  while (iterations < maxIterations) {
    if (options.signal?.aborted) {
      aborted = true
      stopReason = 'aborted'
      break
    }

    iterations++
    handlers.onIteration?.(iterations)

    const result = await options.client.streamChatCompletion(
      {
        ...options.request,
        messages,
        // Sending tools changes what the gateway injects: it only claims Nest
        // capabilities when a request actually carries them. Expect a system
        // block you did not write at the head of the prompt.
        tools: toolPayload,
      },
      handlers,
      options.signal,
    )
    last = result

    if (result.content) contentParts.push(result.content)
    if (result.reasoning) reasoningParts.push(result.reasoning)

    if (result.aborted) {
      aborted = true
      stopReason = 'aborted'
      break
    }

    const structured = assembleToolCalls(result.toolCalls)
    // Only fall back when the structured field produced nothing. The parser is
    // for malformed output; running it over a turn that already parsed cleanly
    // would risk duplicating a call from text the model merely quoted.
    const recovered = structured.length === 0 ? recoverCalls(result, options.tools) : []
    const calls = structured.length > 0 ? structured : recovered
    const wasRecovered = structured.length === 0 && recovered.length > 0

    if (calls.length === 0) {
      stopReason = 'complete'
      break
    }

    // The assistant's own turn, carrying the calls, has to go back in the
    // transcript — otherwise the tool results that follow answer questions the
    // model has no record of asking.
    messages.push({
      role: 'assistant',
      content: result.content,
      tool_calls: calls,
      ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
    })

    for (const call of calls) {
      if (options.signal?.aborted) {
        aborted = true
        stopReason = 'aborted'
        break
      }

      handlers.onToolCall?.(call, wasRecovered)
      const toolResult = await options.tools.execute(
        call.function.name,
        call.function.arguments,
        options.toolContext,
      )

      // Phase 3: a write tool returns a PLAN, not bytes. Route it through the
      // host's approval gate (checkpoint → diff editor → Apply/Reject) before
      // the loop continues. Without a gate the change cannot be applied at all —
      // a configured "always allow" still goes through the gate, which is where
      // the checkpoint is taken.
      let resultForModel = toolResult
      if (toolResult.pendingWrite && options.approveChange) {
        const applied = await options.approveChange(toolResult.pendingWrite)
        // Honest accounting: the model is told whether the write actually
        // happened, never that a pending plan succeeded on its own.
        resultForModel = applied
          ? withAppliedNote(toolResult)
          : withRejectedNote(toolResult)
      } else if (toolResult.pendingCommand && options.approveCommand) {
        // Phase 4.1: a command tool returns a PLAN, not a process. Route it
        // through the always-ask gate (show verbatim → run on approval → capture
        // output). The gate returns the captured output, or null if rejected —
        // which becomes the tool result the model reads back.
        const output = await options.approveCommand(toolResult.pendingCommand)
        resultForModel = withCommandNote(toolResult, output)
      }

      handlers.onToolResult?.(call, resultForModel)
      toolRuns.push({ call, result: resultForModel, recovered: wasRecovered })

      // A failure goes back as content, not as an exception: the model needs to
      // read why and try something else. This is also the shape a server-side
      // denial arrives in from Phase 4.
      messages.push({
        role: 'tool',
        content: resultForModel.content,
        tool_call_id: call.id,
      })
    }

    if (aborted) break

    // Another pass: the model now sees the results and either answers or asks
    // for more. Running out of iterations here is a distinct outcome from
    // finishing, and is reported as one.
    if (iterations >= maxIterations) stopReason = 'turn-cap'
  }

  const result: AgentResult = {
    content: contentParts.join('\n\n'),
    reasoning: reasoningParts.join('\n\n'),
    toolRuns,
    iterations,
    stopReason,
    aborted,
  }
  if (last?.timings) result.timings = last.timings
  if (last?.model) result.model = last.model
  if (last?.finishReason) result.finishReason = last.finishReason
  return result
}

/**
 * Last-resort extraction for a turn that produced no structured calls.
 *
 * Reads the visible answer first and the reasoning stream second, because
 * reasoning models routinely emit the whole call inside their thinking and then
 * merely claim in the answer that it ran. Without this the user is told a tool
 * executed when nothing did.
 */
function recoverCalls(result: StreamResult, tools: ToolRegistry): ToolCall[] {
  const parsed = parseToolCallsFromTurn(result.content, result.reasoning || undefined, {
    patterns: ['braces', 'xml', 'fn', 'json'],
    availableTools: tools.names.map((name) => ({ name })),
  })
  return createApiToolCalls(parsed)
}

/** Replace a pending-write result's text with the honest "applied" outcome, so
 *  the model knows the bytes actually moved and what it can assume next. */
function withAppliedNote(result: ToolResult): ToolResult {
  const next: ToolResult = {
    ...result,
    content: `${result.content}\n\n[Applied: the changes have been written to disk.]`,
    summary: `${result.summary} — applied`,
  }
  // `pendingWrite` is optional and the project sets exactOptionalPropertyTypes,
  // so it must be removed rather than assigned undefined.
  delete next.pendingWrite
  return next
}

/** Replace a pending-write result's text with the honest "rejected" outcome. */
function withRejectedNote(result: ToolResult): ToolResult {
  const next: ToolResult = {
    ...result,
    content:
      `${result.content}\n\n[Rejected: the changes were NOT written. The file on disk is unchanged.]`,
    summary: `${result.summary} — rejected`,
    // A rejection is not a tool failure in the isError sense — but the model
    // must not treat it as success, so it is flagged for the card.
    isError: false,
  }
  delete next.pendingWrite
  return next
}

/** Replace a pending-command result's text with the captured output, or a rejected
 *  note. `output` is the captured stdout/stderr (already budgeted by the caller) or
 *  null if the user declined — in which case the model is told it was not run. */
function withCommandNote(result: ToolResult, output: string | null): ToolResult {
  if (output === null) {
    const next: ToolResult = {
      ...result,
      content: `${result.content}\n\n[Rejected: the command was NOT run.]`,
      summary: `${result.summary} — rejected`,
      isError: false,
    }
    delete next.pendingCommand
    return next
  }
  const next: ToolResult = {
    ...result,
    content: output,
    summary: `${result.summary} — ran`,
    isError: false,
  }
  delete next.pendingCommand
  return next
}
