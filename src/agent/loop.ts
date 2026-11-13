// =============================================================================
// The agent loop — Yellowscript's host for the shared agent-core loop.
// =============================================================================
// The loop itself (turns, the tool-call budget, recovering calls a model wrote
// as text, steering, ask_user, update_plan and its completion check, the turn
// limit) is agent-core's runAgentLoop: the same code chat-ui, the agent bench
// and Nest's task runner run (redstart-project shared/agent-core, vendored
// under src/vendor/agent-core). A fix to how the loop behaves goes there.
//
// This file supplies agent-core's ports from Yellowscript's parts, and keeps
// the result shape ChatSession already renders:
//
//   model.streamTurn   NestClient.streamChatCompletion, with the tool payload
//                      and wire-safe history. Tool-call fragments are
//                      reassembled here (assembleToolCalls).
//   tools.execute      the merged registry (ws_* plus Nest's tools). A write or
//                      command tool returns a PLAN; its review (checkpoint →
//                      diff → Apply/Reject, or the command prompt) runs here,
//                      after the tool, because the change has to be computed
//                      before it can be shown. Nest's tools ask inside their
//                      own executor (nest/approval.ts).
//   gate.approve       always true, for the reason above: every approval in
//                      Yellowscript happens inside execute, on the computed
//                      change, not on the bare call.
//   ask / plan         passed through when the host can answer them (the
//                      webview's question card and checklist).
//   limit.askContinue  the host's prompt when the turn limit is reached;
//                      absent, the flow stops there and says so ('turn-cap').
//   steering           never: Yellowscript queues a prompt typed mid-flow
//                      behind the running turn instead.
//
// No `vscode` import: the whole loop is testable against a fake streamer.
// =============================================================================

import type { ChatCompletionRequest, StreamHandlers, StreamResult } from '../nest/client.ts'
import type { ToolCall } from '../nest/types.ts'
import type { ToolCallDelta, StreamTimings } from '../nest/streaming.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { PendingCommand, PendingWrite, ToolContext, ToolResult } from '../tools/types.ts'
import {
  FALLBACK_ID_PREFIX,
  runAgentLoop as runCoreLoop,
  wireSafeToolCalls,
  type AgentMessage,
  type AgentPorts,
  type AgentToolCall,
} from './agent-core.ts'

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
  /** ask_user: put a question to the person. Absent, the core does not route
   *  ask_user (and Nest does not offer it to a client that did not declare it). */
  ask?: AgentPorts['ask']
  /** update_plan: where the conversation's plan lives. */
  plan?: AgentPorts['plan']
  /** The turn limit was reached: may the flow go on? Absent: no. */
  askContinue?: (signal?: AbortSignal) => Promise<boolean>
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
  const signal = options.signal

  // Worked on a copy: the caller's transcript is its own business, and the
  // assistant/tool messages the core appends are loop bookkeeping that
  // ChatSession renders from `toolRuns` instead.
  const messages = [...options.request.messages] as AgentMessage[]

  const contentParts: string[] = []
  const reasoningParts: string[] = []
  const toolRuns: ToolRun[] = []

  let iterations = 0
  let hitTurnCap = false
  let streamCut = false
  let last: StreamResult | undefined

  const ports: AgentPorts = {
    model: {
      streamTurn: async ({ acc, messages: turnMessages, signal: turnSignal }) => {
        iterations++
        handlers.onIteration?.(iterations)
        const result = await options.client.streamChatCompletion(
          {
            ...options.request,
            messages: toWire(turnMessages),
            // Sending tools changes what the gateway injects: it only claims
            // Nest capabilities when a request actually carries them.
            tools: toolPayload,
          },
          {
            ...handlers,
            // Fill the accumulator as chunks arrive, so the core still has the
            // partial answer if the stream fails mid-turn.
            onContent: (chunk) => {
              acc.content += chunk
              handlers.onContent?.(chunk)
            },
            onReasoning: (chunk) => {
              acc.reasoning += chunk
              handlers.onReasoning?.(chunk)
            },
          },
          turnSignal,
        )
        last = result
        // The client's assembled strings are the record; the deltas paint.
        acc.content = result.content
        acc.reasoning = result.reasoning
        if (result.timings) {
          acc.timings = result.timings
          acc.captured = result.timings
        }
        // A turn cut short ends the flow as an answer with what arrived. No
        // calls from it run, not even ones recovered from its partial text.
        streamCut = result.aborted
        acc.toolCalls = result.aborted ? [] : assembleToolCalls(result.toolCalls)
      },
    },
    tools: {
      execute: async (call) => {
        // A call the core recovered from the model's text, not from tool_calls.
        // Worth surfacing: the model's output was malformed.
        const recovered = call.id.startsWith(FALLBACK_ID_PREFIX)
        const toolCall = call as ToolCall
        handlers.onToolCall?.(toolCall, recovered)
        const toolResult = await options.tools.execute(call.function.name, call.function.arguments, options.toolContext)
        const resultForModel = await review(toolResult, options)
        handlers.onToolResult?.(toolCall, resultForModel)
        toolRuns.push({ call: toolCall, result: resultForModel, recovered })
        // A failure goes back as content, not as an exception: the model needs
        // to read why and try something else.
        return { text: resultForModel.content, isError: resultForModel.isError }
      },
    },
    gate: { approve: async () => true },
    limit: {
      askContinue: async (limitSignal) => {
        const go = options.askContinue ? await options.askContinue(limitSignal) : false
        if (!go) hitTurnCap = true
        return go
      },
    },
    steering: { pending: () => false },
    fallbackParser: () => streamCut ? null : ({
      patterns: ['braces', 'xml', 'fn', 'json'],
      availableTools: options.tools.names.map((name) => ({ name })),
    }),
    // A host-resolved call (ask_user, update_plan) also shows as a card.
    ...(options.ask ? { ask: wrapAsk(options.ask, handlers) } : {}),
    ...(options.plan ? { plan: options.plan } : {}),
    // The core waits a macrotask between steps so a browser can repaint. The
    // extension host has nothing to repaint.
    yield: () => Promise.resolve(),
  }

  await runCoreLoop({
    messages,
    maxTurns: maxIterations,
    ports,
    ...(signal ? { signal } : {}),
    callbacks: {
      onAssistantTurnComplete: async (content, reasoning) => {
        if (content) contentParts.push(content)
        if (reasoning) reasoningParts.push(reasoning)
      },
    },
  })

  const aborted = signal?.aborted === true || last?.aborted === true
  const stopReason: StopReason = aborted ? 'aborted' : hitTurnCap ? 'turn-cap' : 'complete'
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

/** The history as it may be sent: earlier calls with malformed arguments go as
 *  "{}", because llama-server refuses a whole request over one of them. */
function toWire(messages: AgentMessage[]): ChatCompletionRequest['messages'] {
  return messages.map((m) =>
    m.tool_calls ? { ...m, tool_calls: wireSafeToolCalls(m.tool_calls) ?? [] } : m,
  ) as ChatCompletionRequest['messages']
}

/** Show an ask_user call as a tool card too, so the transcript records it. */
function wrapAsk(ask: NonNullable<AgentPorts['ask']>, handlers: AgentLoopHandlers): NonNullable<AgentPorts['ask']> {
  return {
    ...ask,
    user: async (request, signal, call?: AgentToolCall) => {
      if (call) handlers.onToolCall?.(call as ToolCall, false)
      const answer = await ask.user(request, signal, call)
      if (call) {
        handlers.onToolResult?.(call as ToolCall, {
          content: '',
          isError: false,
          summary: answerSummary(answer),
          truncated: false,
        })
      }
      return answer
    },
  }
}

/** One line for the ask_user card: what the person answered. */
function answerSummary(answer: { chosen?: string[]; text?: string } | null): string {
  if (!answer) return 'Skipped'
  const parts = [...(answer.chosen ?? []), ...(answer.text ? [answer.text] : [])]
  const line = parts.join(', ').replace(/\s+/g, ' ')
  return `Answered: ${line.length > 80 ? line.slice(0, 79) + '…' : line}`
}

/**
 * A write or command tool returns a PLAN, not bytes. Route it through the
 * host's review before the model reads anything: without a gate the change
 * cannot be applied at all — a configured "always allow" still goes through
 * the gate, which is where the checkpoint is taken.
 */
async function review(toolResult: ToolResult, options: AgentLoopOptions): Promise<ToolResult> {
  if (toolResult.pendingWrite && options.approveChange) {
    const applied = await options.approveChange(toolResult.pendingWrite)
    // Honest accounting: the model is told whether the write actually
    // happened, never that a pending plan succeeded on its own.
    return applied ? withAppliedNote(toolResult) : withRejectedNote(toolResult)
  }
  if (toolResult.pendingCommand && options.approveCommand) {
    // Always-ask: show verbatim → run on approval → capture output. The gate
    // returns the captured output, or null if rejected.
    const output = await options.approveCommand(toolResult.pendingCommand)
    return withCommandNote(toolResult, output)
  }
  return toolResult
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
