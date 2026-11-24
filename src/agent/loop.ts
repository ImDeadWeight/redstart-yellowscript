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
//   tools.execute      the merged registry (ys_* plus Nest's tools). A write or
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
// Around the core, two agent-core records of the run:
//
//   stagnation         stagnation.mjs watches every call and the streaming
//                      reasoning. A firing is a note at the tail of the next
//                      request, then a refusal of the repeated action, then a
//                      stop with a summary for the person ('stuck'). A
//                      reasoning loop is caught while it streams: that
//                      response is dropped and asked for again with the note.
//                      onRecovery shows each one in the turn's timeline.
//   working state      working-state.mjs keeps what the run found, and rides
//                      at the tail of every request once old results have
//                      been trimmed (context-budget.ts stubs them).
//
// No `vscode` import: the whole loop is testable against a fake streamer.
// =============================================================================

import type { ChatCompletionRequest, StreamHandlers, StreamResult } from '../nest/client.ts'
import { NestHttpError, type ToolCall } from '../nest/types.ts'
import type { ToolCallDelta, StreamTimings } from '../nest/streaming.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import { isProcessStart } from '../tools/process-tools.ts'
import type { PendingCommand, PendingWrite, ToolContext, ToolEffect, ToolResult } from '../tools/types.ts'
import {
  FALLBACK_ID_PREFIX,
  callToolTarget,
  createStagnationMonitor,
  createWorkingState,
  failureLine,
  repeatedCallResult as coreRepeatedCallResult,
  STAGNATION_LIMITS,
  type CallInfo,
  type CallKind,
  type CallOutcome,
  type Recovery,
  type StagnationLimits,
  runAgentLoop as runCoreLoop,
  wireSafeToolCalls,
  type AgentMessage,
  type AgentPorts,
  type AgentToolCall,
  ASK_USER_DEFINITION,
  UPDATE_PLAN_DEFINITION,
  type HostToolDefinition,
} from './agent-core.ts'
import type { ToolPayloadEntry } from '../tools/registry.ts'
import { fitMessages, totalTokens, type BudgetMessage, type ContextTracker, type FitReport } from './context-budget.ts'

/**
 * How many model round trips one user message may cost before the person is
 * asked whether to keep going (Continue grants as many again).
 *
 * Each iteration is a full generation, so on a local model this is also a
 * wall-clock budget. A multi-file task needs dozens; a confused model is
 * caught sooner by the repeat check below than by this cap.
 */
export const DEFAULT_MAX_ITERATIONS = 40

/**
 * The same call (tool and arguments) this many times in one run is a loop:
 * the result cannot change, so the call is not run again and the model is
 * told why. A write that failed and is retried unchanged is the usual case.
 */
export const MAX_IDENTICAL_CALLS = STAGNATION_LIMITS.identicalCalls

/** What the model reads instead of a repeated call's result (agent-core stagnation.mjs). */
export const repeatedCallResult: (name: string, times: number) => string = coreRepeatedCallResult

/** Every stagnation detector off but the exact-repeat guard: the bench's "before". */
export const STAGNATION_OFF: Partial<StagnationLimits> = {
  sameFailure: Infinity,
  noProgressRounds: Infinity,
  sentenceRepeats: Infinity,
  repeatedShare: Infinity,
  theorizingChars: Infinity,
  reversals: Infinity,
}

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
  /** Stopped as stuck (stagnation recovery level 3); the answer says what was tried. */
  | 'stuck'

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
  /** Every stagnation recovery in this run, oldest first. */
  recoveries: Recovery[]
}

export interface AgentLoopHandlers extends StreamHandlers {
  /** A call has been assembled and is about to run. */
  onToolCall?: (call: ToolCall, recovered: boolean) => void
  /** A call has finished. */
  onToolResult?: (call: ToolCall, result: ToolResult) => void
  /** A new round trip is starting; `iteration` is 1-based. */
  onIteration?: (iteration: number) => void
  /** Older messages were trimmed to fit the context window before a request. */
  onContextTrimmed?: (report: FitReport) => void
  /** The run was noticed going nowhere, and what is done about it. */
  onRecovery?: (recovery: Recovery) => void
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
export type ApprovalGate = (pending: PendingWrite) => Promise<boolean | WriteOutcome>

/** An approval gate's answer, with the checkpoint it took before applying. */
export interface WriteOutcome {
  applied: boolean
  checkpoint?: { revision: string; root: string }
}

/**
 * The approval gate for a planned command (Phase 4.1). Unlike writes, a command
 * is always-ask (no "always allow"): the host shows it verbatim, runs it in the
 * integrated terminal on confirmation, captures the output, and returns it. The
 * returned string is the captured stdout/stderr to feed the model; `null` means the
 * user rejected it. Kept as an injected port for testability — the real one lives
 * in the host alongside `vscode`.
 */
export type CommandApprovalGate = (pending: PendingCommand) => Promise<CommandOutcome | string | null>

/** What an approved command produced: the model's text, and whether it failed
 *  (non-zero exit, timeout, could not start), so the card shows it. */
export interface CommandOutcome {
  text: string
  isError: boolean
  /** For the run log; null when it did not exit (timed out, still running). */
  exitCode?: number | null
  /** Started in the background as this process. */
  processId?: string
  /** The address the background process said it serves. */
  url?: string
  /** It ran without asking, under this rule (safe-commands.ts). */
  autoRule?: string
}

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
  /** The connection's context window. Absent: no trimming, and a request
   *  that overflows fails as it always did. */
  context?: ContextTracker | undefined
  /** After a write is applied: the problems now reported in those files
   *  (absolute paths), appended to the result. Absent: nothing appended. */
  diagnosticsAfterWrite?: ((files: string[]) => Promise<string | null>) | undefined
  /** Stagnation thresholds (agent-core STAGNATION_LIMITS). STAGNATION_OFF
   *  leaves only the exact-repeat guard. */
  stagnation?: Partial<StagnationLimits> | undefined
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
export function assembleToolCalls(deltas: readonly ToolCallDelta[], iteration = 1): ToolCall[] {
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
      // normally send one; synthesise a stable one when they do not. Past the
      // first round trip it names the round too: the same tool at the same
      // index in a later round is a different call, and the panel and the
      // results are matched by id.
      id: entry.id ?? `call_${index}_${entry.name}${iteration > 1 ? `_r${iteration}` : ''}`,
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
  const toolPayload = withHostTools(options.tools.payload(), options)
  const signal = options.signal

  // Worked on a copy: the caller's transcript is its own business, and the
  // assistant/tool messages the core appends are loop bookkeeping that
  // ChatSession renders from `toolRuns` instead.
  const messages = [...options.request.messages] as AgentMessage[]

  const contentParts: string[] = []
  const reasoningParts: string[] = []
  const toolRuns: ToolRun[] = []

  let iterations = 0
  /** Images of the result being stored, handed to extraParts right after. */
  let resultImages: string[] = []
  const monitor = createStagnationMonitor(options.stagnation)
  const workingState = createWorkingState()
  /** Old results have been trimmed in this run: the working state rides along. */
  let trimmed = false
  /** The note owed to the next request (a stagnation recovery). */
  let pendingNote: string | null = null
  /** Stopped as stuck: what the person reads instead of another request. */
  let stuck: Recovery | null = null
  /** A round of calls has run since the last request. */
  let roundOpen = false
  let hitTurnCap = false
  let streamCut = false
  let last: StreamResult | undefined

  /** End the flow on the stuck summary: it is the answer, painted as one. */
  const answerStuck = (acc: { content: string; reasoning: string; toolCalls: unknown[] }, recovery: Recovery): void => {
    handlers.onContent?.(recovery.note)
    acc.content = recovery.note
    acc.reasoning = ''
    acc.toolCalls = []
  }

  const ports: AgentPorts = {
    model: {
      streamTurn: async ({ acc, messages: turnMessages, signal: turnSignal }) => {
        iterations++
        handlers.onIteration?.(iterations)
        // The round that just ended: does a pattern show?
        if (roundOpen) {
          roundOpen = false
          const recovery = monitor.endRound()
          if (recovery) {
            handlers.onRecovery?.(recovery)
            if (recovery.stop) stuck = recovery
            else pendingNote = recovery.note
          }
        }
        // Stuck: no request. The summary is the answer, and the flow ends.
        if (stuck) return answerStuck(acc, stuck)
        const context = options.context
        // Fit the run to the window, editing its messages in place (see
        // context-budget.ts). `force` after the server refused: its numbers
        // beat the estimate.
        const fit = async (force: boolean) => {
          if (!context) return
          await context.ready(turnSignal)
          const limits = context.limits()
          if (!limits) return
          const report = fitMessages(turnMessages as BudgetMessage[], limits, force)
          if (report.stubbed) trimmed = true
          if (report.stubbed || report.shrunk || report.capped) handlers.onContextTrimmed?.(report)
        }
        /** A reasoning loop caught while this response streamed (set in a callback). */
        const watch: { looping: Recovery | null } = { looping: null }
        const send = (): Promise<StreamResult> => {
          // Its own controller, so a reasoning loop can drop this response
          // without ending the run.
          const request = new AbortController()
          const stop = () => request.abort()
          if (turnSignal?.aborted) request.abort()
          else turnSignal?.addEventListener('abort', stop, { once: true })
          monitor.startResponse()
          workingState.setPlan(options.plan?.get())
          const note = pendingNote
          const tail = [note, trimmed && !workingState.empty ? workingState.render() : null]
          pendingNote = null
          return options.client
            .streamChatCompletion(
              {
                ...options.request,
                messages: toWire(withTailNotes(turnMessages, tail)),
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
                  if (watch.looping) return
                  const recovery = monitor.reasoning(chunk)
                  if (recovery) {
                    watch.looping = recovery
                    request.abort()
                  }
                },
              },
              request.signal,
            )
            .catch((err: unknown) => {
              // Refused before it streamed (too big, say): the retry still owes the note.
              if (!watch.looping) pendingNote ??= note
              throw err
            })
            .finally(() => turnSignal?.removeEventListener('abort', stop))
        }
        /** Send. A response dropped as a reasoning loop is asked for again
         *  with the note, or ends the run as stuck (null). */
        const sendWatched = async (): Promise<StreamResult | null> => {
          for (;;) {
            watch.looping = null
            let result: StreamResult
            try {
              result = await send()
            } catch (err) {
              if (!watch.looping || turnSignal?.aborted) throw err
              result = { content: acc.content, reasoning: acc.reasoning, toolCalls: [], aborted: true }
            }
            // Set by onReasoning during send(), which TypeScript cannot see.
            const caught = watch.looping as Recovery | null
            if (!caught || turnSignal?.aborted) return result
            handlers.onRecovery?.(caught)
            if (caught.stop) {
              stuck = caught
              return null
            }
            pendingNote = caught.note
            acc.content = ''
            acc.reasoning = ''
          }
        }
        await fit(false)
        let estimate = totalTokens(turnMessages as BudgetMessage[])
        let sent: StreamResult | null
        try {
          sent = await sendWatched()
        } catch (err) {
          // Too big after all: llama-server says how big the window is. Trim
          // to that and try once more; a second refusal is reported as usual.
          if (!context || !(err instanceof NestHttpError) || !err.contextExceeded) throw err
          context.recordExceeded(err.contextExceeded.nCtx, err.contextExceeded.promptTokens, estimate)
          await fit(true)
          estimate = totalTokens(turnMessages as BudgetMessage[])
          sent = await sendWatched()
        }
        // Stuck while it streamed: the summary is the answer.
        if (!sent) return answerStuck(acc, stuck!)
        const result = sent
        // The prompt the server really processed: what the overhead is.
        if (context && typeof result.timings?.prompt_n === 'number') {
          context.recordPrompt(result.timings.prompt_n + (result.timings.cache_n ?? 0), estimate)
        }
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
        acc.toolCalls = result.aborted ? [] : assembleToolCalls(result.toolCalls, iterations)
      },
    },
    tools: {
      execute: async (call) => {
        // A call the core recovered from the model's text, not from tool_calls.
        // Worth surfacing: the model's output was malformed.
        const recovered = call.id.startsWith(FALLBACK_ID_PREFIX)
        const toolCall = call as ToolCall
        handlers.onToolCall?.(toolCall, recovered)
        roundOpen = true
        const info = callInfo(call.function.name, call.function.arguments)
        const refused = monitor.check(info)
        let resultForModel: ToolResult
        let outcome: CallOutcome
        if (refused) {
          resultForModel = {
            content: refused.refuse,
            isError: true,
            summary: refused.reason === 'repeated' ? 'Not run: repeated call' : 'Not run: paused until there is new evidence',
            truncated: false,
          }
          outcome = { ok: false, refused: refused.reason, text: refused.refuse }
        } else {
          const planned = await options.tools.execute(call.function.name, call.function.arguments, options.toolContext)
          resultForModel = await review(planned, options)
          outcome = callOutcome(info, planned, resultForModel)
        }
        monitor.record(info, outcome)
        workingState.observe(info, outcome)
        handlers.onToolResult?.(toolCall, resultForModel)
        toolRuns.push({ call: toolCall, result: resultForModel, recovered })
        resultImages = resultForModel.images ?? []
        // A failure goes back as content, not as an exception: the model needs
        // to read why and try something else.
        return { text: resultForModel.content, isError: resultForModel.isError }
      },
      // A result's images (a page screenshot) go to the model as image parts,
      // only when it reads images. The core calls these right after execute.
      extractAttachments: (text: string) => {
        const attachments = resultImages
        resultImages = []
        return { text, attachments }
      },
      extraParts: async (_text: string, attachments: unknown[]) =>
        options.context?.vision
          ? (attachments as string[]).map((url) => ({ type: 'image_url', image_url: { url } }))
          : [],
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

  const aborted = signal?.aborted === true || (!stuck && last?.aborted === true)
  const stopReason: StopReason = aborted ? 'aborted' : stuck ? 'stuck' : hitTurnCap ? 'turn-cap' : 'complete'
  const result: AgentResult = {
    content: contentParts.join('\n\n'),
    reasoning: reasoningParts.join('\n\n'),
    toolRuns,
    iterations,
    stopReason,
    aborted,
    recoveries: monitor.firings,
  }
  if (last?.timings) result.timings = last.timings
  if (last?.model) result.model = last.model
  if (last?.finishReason) result.finishReason = last.finishReason
  return result
}

/** How agent-core's own tail notes (update-plan.mjs) begin. */
const CORE_NOTE_PREFIX = '[Automatic note, not from the user]'

/** The line above the notes appended to a tool result: who is speaking. */
export const HARNESS_NOTE_HEADER = "--- From Yellowscript, the editor running this task (not part of the tool's output) ---"

/**
 * `messages` with notes for this request only, so the history the server has
 * cached stays as it was.
 *
 * After a tool result they go INTO that result, under a line that says who
 * wrote them, with agent-core's own tail note (the plan's) folded in too. A
 * bracketed user message after a tool result reads as an injection: in the
 * Crestline rerun (2026-11-24) Ornith reasoned "I'll disregard this injected
 * note entirely. It's trying to manipulate me", and set the plan note and the
 * stagnation notes aside. After an answer or a person's message there is no
 * tool result to carry them, and they stay one user message.
 */
export function withTailNotes<M extends { role: string; content?: unknown }>(messages: M[], notes: ReadonlyArray<string | null | undefined>): M[] {
  let list = messages
  let core: string | null = null
  const last = list[list.length - 1]
  if (last && last.role === 'user' && typeof last.content === 'string' && last.content.startsWith(CORE_NOTE_PREFIX) && list.length > 1 && list[list.length - 2]!.role !== 'user') {
    core = last.content
    list = list.slice(0, -1)
  }
  const all = [core, ...notes].filter((n): n is string => !!n)
  if (all.length === 0) return messages
  const text = all.join('\n\n')
  const tail = list[list.length - 1]
  if (tail && tail.role === 'tool') {
    const note = `${HARNESS_NOTE_HEADER}\n${text}`
    const content =
      typeof tail.content === 'string'
        ? `${tail.content}\n\n${note}`
        : Array.isArray(tail.content)
          ? [...(tail.content as unknown[]), { type: 'text', text: note }]
          : note
    return [...list.slice(0, -1), { ...tail, content }]
  }
  return [...list, { role: 'user', content: text } as M]
}

/** What the stagnation monitor and the working state need to know of a call. */
export function callInfo(name: string, args: string): CallInfo {
  return { name, args, kind: callKind(name, args), signature: callSignature(name, args) }
}

/** What kind of evidence a call gathers, or what it changes. */
export function callKind(name: string, args: string): CallKind {
  switch (name) {
    case 'ys_read_file':
    case 'ys_editor_context':
    case 'ys_process_output':
      return 'read'
    case 'ys_grep':
    case 'ys_glob':
    case 'ys_list_directory':
    case 'ys_find_symbol':
    case 'ys_references':
    case 'ys_outline':
      return 'search'
    case 'ys_write_file':
    case 'ys_edit_file':
    case 'ys_replace':
    case 'ys_delete_file':
    case 'ys_move_file':
    case 'ys_note':
      return 'write'
    case 'ys_run_command':
    case 'ys_process_start':
      return 'command'
    case 'ys_process':
      return isProcessStart(args) ? 'command' : 'read'
    case 'ys_diagnostics':
    case 'ys_check_page':
      return 'diagnostics'
    case 'call_tool': {
      // Nest's catalog dispatcher: what the call it carries does.
      let parsed: unknown
      try {
        parsed = JSON.parse(args)
      } catch {
        return 'other'
      }
      const target = callToolTarget(name, parsed)
      return target ? nestToolKind(target.name) : 'other'
    }
    default:
      return nestToolKind(name)
  }
}

/** A Nest tool's kind, by the words in its name. */
function nestToolKind(name: string): CallKind {
  if (/(^|_)(read|get|view|fetch|open|show)(_|$)/.test(name)) return 'read'
  if (/(^|_)(search|list|find|query|grep|glob)(_|$)/.test(name)) return 'search'
  if (/(^|_)(write|create|edit|update|delete|move|rename|replace|save)(_|$)/.test(name)) return 'write'
  if (/(^|_)(run|exec|execute|python|shell)(_|$)/.test(name)) return 'command'
  return 'other'
}

/** How a call went, for the monitor and the working state. */
function callOutcome(info: CallInfo, planned: ToolResult, result: ToolResult): CallOutcome {
  const effect = result.effect
  const rejected = (effect?.kind === 'write' && !effect.applied) || (effect?.kind === 'command' && !effect.ran)
  const outcome: CallOutcome = { ok: !result.isError && !rejected, text: result.content }
  if (rejected) outcome.rejected = true
  let args: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(info.args)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
  } catch {
    // Arguments that do not parse: nothing to read from them.
  }
  if (outcome.ok && info.kind === 'read' && typeof args.path === 'string') outcome.reads = [args.path]
  if (effect?.kind === 'write' && effect.applied && planned.pendingWrite) {
    outcome.writes = planned.pendingWrite.changes.map((c) => ({ path: c.path, before: c.before, after: c.after, isNew: c.isNew, isDeleted: c.isDeleted }))
  }
  if (info.name === 'ys_note' && outcome.ok && typeof args.text === 'string') {
    outcome.note = `${typeof args.section === 'string' ? `${args.section}: ` : ''}${args.text}`
  }
  return outcome
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

interface AskReplyShape {
  chosen?: string[]
  text?: string
}
interface AskAnswerShape extends AskReplyShape {
  answers?: Array<AskReplyShape | null>
}

/** One line for the ask_user card: what the person answered. */
function answerSummary(answer: AskAnswerShape | null): string {
  if (!answer) return 'Skipped'
  // Several questions answered on the card come back one reply per question.
  const replies = answer.answers ? answer.answers.filter((a) => a !== null) : [answer]
  if (replies.length === 0) return 'Skipped'
  const parts = replies.flatMap((r) => [...(r.chosen ?? []), ...(r.text ? [r.text] : [])])
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
    const pending = toolResult.pendingWrite
    const answer = await options.approveChange(pending)
    const outcome: WriteOutcome = typeof answer === 'boolean' ? { applied: answer } : answer
    const applied = outcome.applied
    // Honest accounting: the model is told whether the write actually
    // happened, never that a pending plan succeeded on its own.
    const effect: ToolEffect = {
      kind: 'write',
      applied,
      files: pending.changes.map((c) => ({ path: c.path, absolutePath: c.absolutePath, isNew: c.isNew, isDeleted: c.isDeleted })),
    }
    if (outcome.checkpoint) effect.checkpoint = outcome.checkpoint
    if (!applied) return { ...withRejectedNote(toolResult), effect }
    const done: ToolResult = { ...withAppliedNote(toolResult), effect }
    // What the write broke, without another call. Deleted files have none.
    const written = pending.changes.filter((c) => !c.isDeleted).map((c) => c.absolutePath)
    if (options.diagnosticsAfterWrite && written.length > 0) {
      const report = await options.diagnosticsAfterWrite(written).catch(() => null)
      if (report) done.content = `${done.content}\n\n${report}`
    }
    return done
  }
  if (toolResult.pendingCommand && options.approveCommand) {
    // Always-ask: show verbatim → run on approval → capture output. The gate
    // returns the captured output, or null if rejected.
    const pending = toolResult.pendingCommand
    const output = await options.approveCommand(pending)
    return { ...withCommandNote(toolResult, output), effect: commandEffect(pending, output) }
  }
  return toolResult
}

/** The run log's record of a command, from what the gate returned. */
function commandEffect(pending: PendingCommand, outcome: CommandOutcome | string | null): ToolEffect {
  if (outcome === null) return { kind: 'command', command: pending.command, ran: false, exitCode: null }
  const output = typeof outcome === 'string' ? { text: outcome, isError: false } : outcome
  const effect: ToolEffect = { kind: 'command', command: pending.command, ran: true, exitCode: output.exitCode ?? null }
  if (output.processId) {
    effect.processId = output.processId
    effect.cwd = pending.cwd
  }
  if (output.autoRule) effect.autoRule = output.autoRule
  if (output.url) effect.url = output.url
  if (output.isError) {
    effect.failed = true
    const last = lastMeaningfulLine(output.text)
    if (last) effect.lastLine = last
  }
  return effect
}

/** The line of a failed command's output worth quoting: the one that says
 *  what failed, without colour codes or a CLI's frame (agent-core
 *  failureLine; it skips the "Exit code 1 · 2.4s" header). Until 2026-11-24
 *  it was the last line, which for Crestline's `sv` and `svelte-check` runs
 *  was "└" and "[39m". */
function lastMeaningfulLine(text: string): string | null {
  const line = failureLine(text)
  return line ? line.slice(0, 120) : null
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
function withCommandNote(result: ToolResult, outcome: CommandOutcome | string | null): ToolResult {
  const output = outcome === null ? null : typeof outcome === 'string' ? { text: outcome, isError: false } : outcome
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
    content: output.text,
    summary: `${result.summary.replace(/ \(pending approval\)$/, '')} — ${output.isError ? 'failed' : 'ran'}${output.autoRule ? ` without asking (${output.autoRule})` : ''}`,
    isError: output.isError,
  }
  delete next.pendingCommand
  return next
}

/**
 * ask_user and update_plan, offered whenever this loop can answer them.
 *
 * Nest offers both over MCP to a client that declares them, but this loop is
 * what answers them, so it must not depend on that: with Nest's tools missing
 * (MCP down, an older Nest) the model was left without a way to ask, and,
 * told elsewhere that a question in its reply ends the turn unanswered, it
 * spun through throwaway commands instead (2026-11-19). Nest's copy, when
 * present, wins; it is the same definition from the same agent-core.
 */
export function withHostTools(payload: ToolPayloadEntry[], options: Pick<AgentLoopOptions, 'ask' | 'plan'>): ToolPayloadEntry[] {
  const have = new Set(payload.map((t) => t.function.name))
  const extra: ToolPayloadEntry[] = []
  const add = (def: HostToolDefinition) => {
    if (!have.has(def.name)) extra.push({ type: 'function', function: { name: def.name, description: def.description, parameters: def.inputSchema } })
  }
  if (options.ask) add(ASK_USER_DEFINITION)
  if (options.plan) add(UPDATE_PLAN_DEFINITION)
  return extra.length ? [...payload, ...extra] : payload
}

/**
 * What makes two calls "the same call" for the repeat check. Exact, except
 * for commands: there digits are ignored, so `echo break2`, `echo break3`…
 * count as one repeated call (seen 2026-11-19, a model evading the exact
 * check). Reads keep exact arguments: level-01 … level-30 are different work.
 */
export function callSignature(name: string, args: string): string {
  const loose = name === 'ys_run_command' || name === 'ys_process_start' || (name === 'ys_process' && isProcessStart(args))
  return `${name}\u0000${(loose ? args.replace(/\d+/g, '#') : args).trim()}`
}
