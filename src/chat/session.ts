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
import type {
  AnswerView,
  ChatMessageView,
  ConversationState,
  ContextUsageView,
  HostMessage,
  PlanStepView,
  AttachmentView,
  InFlightRun,
  QuestionItemView,
  QuestionView,
  ToolCardView,
  TurnStats,
} from './protocol.ts'
import { ApprovalQueue, type ApprovalRequest } from './approvals.ts'
import { runAgentLoop, type AgentResult, type ApprovalGate, type CommandApprovalGate } from '../agent/loop.ts'
import type { ContextTracker, FitReport } from '../agent/context-budget.ts'
import type { AskAnswer, AskRequest, PlanStep, Recovery, StagnationLimits } from '../agent/agent-core.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { ToolContext, ToolEffect } from '../tools/types.ts'
import { FULL_LOGS_KEPT, RUN_LOG_NOTE, collapsedRunLog, formatRunLog } from './run-log.ts'
import { withoutCopiedTail } from '../agent/phantom-call.ts'
import { userContent } from './attachments.ts'
import { appendPart } from './turn-parts.ts'

/** Outbound protocol messages, before the owning conversation's id is tagged
 *  on. Distributes the `conversationId` omission across the union so callers can
 *  build a message without it and let ChatSession attach it. */
type OutboundMessage = HostMessage extends infer T ? (T extends { conversationId: string } ? Omit<T, 'conversationId'> : T) : never

/** What Continue sends after a reload cut a run off. */
export const RESUME_PROMPT = 'Continue the task from where it stopped.'

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
  /** A turn started or ended (queued ones too): the Stop button and the tab's
   *  busy dot read it. Until 2026-11-24 only the first send and the end of the
   *  whole queue were reported, so a queued turn ran with no Stop button. */
  onBusyChanged?: () => void
  /** Resolves the currently connected client, or null when not connected. */
  getClient: () => NestClient | null
  /** Called when a request comes back 401 so the connection can re-prompt. */
  onUnauthorized: () => void | Promise<void>
  emit: (message: HostMessage) => void
  /** Injected so tests get deterministic ids. */
  newId?: () => string
  /**
   * The ys_* tools, and the workspace they act on.
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
  /** The Nest project the workspace is linked to, sent with every request so
   *  Nest adds its instructions and memories. */
  projectId?: () => string | null
  /** The connection's context window, so a long run is trimmed to fit. */
  context?: () => ContextTracker | null
  /** Round trips before the person is asked whether to keep going. */
  maxTurns?: () => number
  /** Stagnation thresholds for each run (agent-core STAGNATION_LIMITS);
   *  STAGNATION_OFF keeps only the exact-repeat guard. Absent: the defaults. */
  stagnation?: () => Partial<StagnationLimits> | undefined
  /** A system message about the workspace (its instructions, its files),
   *  sent first on every request that carries tools. */
  workspaceContext?: () => string | null
  /** What is running right now (a dev server and its address), computed on
   *  each request and put before the newest message, not stored. */
  liveState?: () => string | null
  /** The plan changed (null: cleared), so the host can keep it on disk. */
  onPlanChanged?: (steps: PlanStep[] | null) => void
  /** After an applied write: the problems now in those files, for the model. */
  diagnosticsAfterWrite?: (files: string[]) => Promise<string | null>
  /** Older messages of a run were trimmed to fit the window (for the log). */
  onContextTrimmed?: (report: FitReport) => void
  /** A run of the agent loop ended: everything it did (the bench's record). */
  onAgentResult?: (result: AgentResult) => void
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
  private pending: { id: string; prompt: string; workflow?: { name: string; title: string }; attachments?: AttachmentView[] }[] = []
  /** The conversation's update_plan checklist. Kept by the model through the
   *  loop's plan port; saved with the conversation; cleared by the person. */
  private plan: PlanStepView[] | null = null
  /** The ask_user question the running flow is waiting on. */
  private question: { view: QuestionView; resolve: (answer: AskAnswer | null) => void } | null = null
  /** The running flow is waiting at its turn limit for "keep going?". */
  private limitWait: ((go: boolean) => void) | null = null
  /** Tool calls waiting for allow / deny, shown one at a time. */
  private readonly approvals: ApprovalQueue
  /** The running turn's record, saved with the conversation. */
  private inFlight: InFlightRun | null = null
  /** A run from an earlier window that never ended: offered to continue. */
  private interrupted: InFlightRun | null = null
  /** Tokens the last request filled (prompt, cached, reply); null: none yet
   *  this window, so the last saved turn's stats stand in. */
  private contextUsed: number | null = null
  /** Times the running (or last) run trimmed old results to fit. */
  private trimmed = 0

  constructor(deps: SessionDeps) {
    this.deps = deps
    this.approvals = new ApprovalQueue(() => this.emitState(), () => this.nextId())
  }

  /**
   * Ask the person to allow a tool call, on the card in this conversation.
   * Resolves with the chosen option id; the request's deny option when the
   * turn is stopped first. The gates the host builds for this session call
   * this, so an approval always shows in the tab whose run asked for it.
   */
  readonly askApproval = (request: ApprovalRequest): Promise<string> =>
    this.approvals.ask(request, this.controller?.signal)

  /** Decide the open approval. False for a stale id or an unknown choice. */
  approve(id: string, choice: string): boolean {
    return this.approvals.decide(id, choice)
  }

  /** Show one of the open write approval's files as a diff. */
  openApprovalFile(id: string, index: number): void {
    this.approvals.openFile(id, index)
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

  /** What the panel shows around the transcript: question, plan, limit wait. */
  state(): ConversationState {
    return {
      question: this.question ? { ...this.question.view } : null,
      plan: this.plan ? this.plan.map((step) => ({ ...step })) : null,
      atTurnLimit: this.limitWait !== null,
      approval: this.approvals.view(),
      interrupted: this.interrupted ? { startedAt: this.interrupted.startedAt, processes: this.interrupted.processes.map((p) => p.command) } : null,
      context: this.contextUsage(),
    }
  }

  /** The context meter: the last request's size against the window. */
  private contextUsage(): ContextUsageView | null {
    let used = this.contextUsed
    if (used === null) {
      for (let i = this.messages.length - 1; i >= 0 && used === null; i--) {
        const tokens = this.messages[i]!.stats?.contextTokens
        if (typeof tokens === 'number') used = tokens
      }
    }
    if (used === null) return null
    const size = this.deps.context?.()?.contextSize ?? null
    return { used, size, ...(this.trimmed ? { trimmed: this.trimmed } : {}) }
  }

  /** The running turn's record, for persistence; null when idle. */
  inFlightSnapshot(): InFlightRun | null {
    return this.inFlight ? { startedAt: this.inFlight.startedAt, processes: this.inFlight.processes.map((p) => ({ ...p })) } : null
  }

  /** Put the "interrupted" card away. */
  dismissInterrupted(): void {
    if (!this.interrupted) return
    this.interrupted = null
    this.emitState()
    this.deps.onPersist?.()
  }

  /**
   * Continue an interrupted run. Returns the background commands it had
   * running, for the host to restart first when the person asked to; then
   * sends the message that picks the task up again. The run log of what had
   * finished is on its turn already, so the model starts knowing it.
   */
  resumeInterrupted(): { processes: { command: string; cwd: string }[]; sent: Promise<void> } | null {
    const was = this.interrupted
    if (!was || this.busy) return null
    this.interrupted = null
    this.emitState()
    return { processes: was.processes.map(({ command, cwd }) => ({ command, cwd })), sent: this.send(RESUME_PROMPT) }
  }

  /** The plan, for persistence. */
  planSnapshot(): PlanStepView[] | null {
    return this.plan ? this.plan.map((step) => ({ ...step })) : null
  }

  private emitState(): void {
    this.emit({ type: 'conversationState', state: this.state() })
  }

  /**
   * Answer the open question. `id` must name it: a late click on a card the
   * panel still showed must not answer the next question. Returns false when
   * there was nothing to answer.
   */
  answer(id: string, answer: AnswerView | null): boolean {
    const open = this.question
    if (!open || open.view.id !== id) return false
    this.question = null
    open.resolve(answer)
    this.emitState()
    return true
  }

  /** Clear the plan (the × on the checklist). Steps no longer steer the chat. */
  clearPlan(): void {
    if (this.plan === null) return
    this.plan = null
    this.emitState()
    this.deps.onPersist?.()
    this.deps.onPlanChanged?.(null)
  }

  /** At the turn limit: keep going (true) or stop. */
  continueAtLimit(go: boolean): void {
    const wait = this.limitWait
    if (!wait) return
    this.limitWait = null
    wait(go)
    this.emitState()
  }

  /** Discard the conversation. Aborts a turn in flight rather than orphaning it. */
  reset(): void {
    this.abort()
    this.pending = []
    this.messages = []
    this.plan = null
    this.emit({ type: 'conversation', messages: [], state: this.state() })
    this.deps.onPersist?.()
  }

  /**
   * Replace the transcript with an existing conversation's messages. Used to
   * seed a session from the store (e.g. on open) — deliberately does NOT abort,
   * because a turn that is already streaming belongs to this same conversation
   * and must be allowed to finish. Switching tabs never calls this; it is a
   * pure view change handled by the host.
   */
  load(messages: ChatMessageView[], plan: PlanStepView[] | null = null, inFlight: InFlightRun | null = null): void {
    // A turn saved mid-stream by a window that then closed is not streaming
    // any more: it stopped.
    this.messages = messages.map((message) => (message.streaming && !this.busy ? { ...message, streaming: false, aborted: true } : { ...message }))
    if (!this.busy) {
      this.plan = plan ? plan.map((step) => ({ ...step })) : null
      this.interrupted = inFlight ? { startedAt: inFlight.startedAt, processes: inFlight.processes.map((p) => ({ ...p })) } : null
    }
    this.emit({ type: 'conversation', messages: this.messages, state: this.state() })
  }

  /** A snapshot of the transcript, safe to hand across the webview boundary. */
  /** What the run of assistant turn `turnId` did (for its task summary). */
  runOf(turnId: string): ToolEffect[] | null {
    return this.messages.find((m) => m.id === turnId && m.role === 'assistant')?.run ?? null
  }

  snapshot(): ChatMessageView[] {
    return this.messages.map((message) => ({
      ...message,
      ...(message.tools ? { tools: message.tools.map((card) => ({ ...card })) } : {}),
    }))
  }

  /** Stop the running turn. Whatever streamed so far stays on screen — the user
   *  asked it to stop, not to throw the answer away. */
  /**
   * Stop: the running turn, and the queue behind it. Queued messages are not
   * sent; their text goes back to the composer, so nothing typed is lost. Stop
   * that only ended the current turn let the next queued one start at once,
   * and it read as Stop not working.
   *
   * The session stays busy until the turn has actually unwound (runTurn's
   * finally clears the controller and reports it), so the Stop button does
   * not disappear while a command is still being ended.
   */
  abort(): void {
    this.controller?.abort()
    // A flow waiting on the person ends with the abort: nobody will answer.
    if (this.question) this.answer(this.question.view.id, null)
    this.approvals.denyAll()
    this.continueAtLimit(false)
    if (this.pending.length > 0) {
      const text = this.pending.map((p) => p.prompt).filter(Boolean).join('\n\n')
      this.pending = []
      // The greyed bubbles go: the transcript is what was actually sent.
      this.emit({ type: 'conversation', messages: this.snapshot(), state: this.state() })
      if (text) this.emit({ type: 'composerText', text })
      this.deps.onPersist?.()
    }
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
  async send(text: string, workflow?: { name: string; title: string }, attachments?: AttachmentView[]): Promise<void> {
    const prompt = text.trim()
    const attached = attachments?.length ? attachments.map((a) => ({ ...a })) : null
    if (!prompt && !attached) return
    const extra = {
      ...(workflow ? { workflow: { ...workflow } } : {}),
      ...(attached ? { attachments: attached } : {}),
    }

    // A message typed while the assistant waits on a question IS the answer
    // (agent-core's contract): it goes to the question, not into the queue.
    // One with attachments is a new message: an answer has nowhere to put them.
    if (this.question && !workflow && !attached) {
      // On a several-question card it is one reply to all of them.
      this.answer(this.question.view.id, { text: prompt })
      return
    }

    if (this.busy) {
      const id = this.nextId()
      this.pending.push({ id, prompt, ...extra })
      this.emit({ type: 'message', message: { id, role: 'user', content: prompt, pending: true, ...extra } })
      this.deps.onPersist?.()
      return
    }

    await this.runTurn({ id: this.nextId(), role: 'user', content: prompt, ...extra })

    // Drain anything that queued up while this turn ran.
    while (this.pending.length > 0) {
      const next = this.pending.shift()!
      // Flip the queued user message to active: same id, pending cleared. The
      // webview updates the existing (greyed) bubble rather than adding a new
      // one.
      const nextExtra = {
        ...(next.workflow ? { workflow: next.workflow } : {}),
        ...(next.attachments ? { attachments: next.attachments } : {}),
      }
      this.emit({ type: 'message', message: { id: next.id, role: 'user', content: next.prompt, pending: false, ...nextExtra } })
      await this.runTurn({ id: next.id, role: 'user', content: next.prompt, ...nextExtra })
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
    // Recorded before the first save, so a crash from here on reads as
    // interrupted on the next load.
    this.inFlight = { startedAt: Date.now(), processes: [] }
    if (this.interrupted) {
      this.interrupted = null
      this.emitState()
    }

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
    this.deps.onBusyChanged?.()
    // What the run changes, kept as it happens: a turn that fails after three
    // writes still made those writes, and the next message must know.
    const effects: ToolEffect[] = []

    try {
      const handlers = {
        onContent: (chunk: string) => {
          turn.content += chunk
          turn.parts = appendPart(turn.parts, { kind: 'text', text: chunk })
          this.emit({ type: 'turn/delta', id: turn.id, channel: 'content', text: chunk })
        },
        onReasoning: (chunk: string) => {
          turn.reasoning = (turn.reasoning ?? '') + chunk
          turn.parts = appendPart(turn.parts, { kind: 'reasoning', text: chunk })
          this.emit({ type: 'turn/delta', id: turn.id, channel: 'reasoning', text: chunk })
        },
        onModel: (model: string) => {
          this.model = model
        },
        onTimings: (timings: StreamTimings) => {
          const used = contextTokens(timings)
          if (used !== undefined) this.contextUsed = used
        },
      }
      this.trimmed = 0

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
            toolContext: {
              ...(this.deps.toolContext?.() ?? { workspaceRoots: [] }),
              conversationId: this.deps.conversationId,
            },
            signal: controller.signal,
            approveChange: this.deps.approveChange,
            approveCommand: this.deps.approveCommand,
            ask: { user: (request, signal, call) => this.ask(request, call?.id, signal) },
            plan: {
              get: () => this.plan,
              save: (steps: PlanStep[]) => {
                this.plan = steps.map((step) => ({ ...step }))
                this.emitState()
                this.deps.onPersist?.()
                this.deps.onPlanChanged?.(this.plan)
              },
            },
            askContinue: (signal) => this.waitAtLimit(signal),
            context: this.deps.context?.() ?? undefined,
            diagnosticsAfterWrite: this.deps.diagnosticsAfterWrite,
            ...(this.deps.maxTurns ? { maxIterations: this.deps.maxTurns() } : {}),
            stagnation: this.deps.stagnation?.(),
            handlers: {
              ...handlers,
              // A stagnation recovery: a line in the timeline, an entry in the run log.
              onDrafting: (tool: string, chars: number) => {
                this.emit({ type: 'turn/drafting', id: turn.id, tool, chars })
              },
              onNotice: (text: string) => {
                turn.parts = appendPart(turn.parts, { kind: 'notice', text })
                this.emit({ type: 'turn/notice', id: turn.id, text })
                this.deps.onPersist?.()
              },
              onRecovery: (recovery: Recovery) => {
                const text = recoveryLine(recovery)
                turn.parts = appendPart(turn.parts, { kind: 'notice', text })
                effects.push({ kind: 'recovery', detector: recovery.detector, level: recovery.level, evidence: recovery.evidence })
                turn.run = [...effects]
                this.emit({ type: 'turn/notice', id: turn.id, text })
                this.deps.onPersist?.()
              },
              onContextTrimmed: (report: FitReport) => {
                this.trimmed++
                this.emitState()
                this.deps.onContextTrimmed?.(report)
              },
              // Each new request: the meter shows what the last one filled.
              onIteration: (iteration: number) => {
                if (iteration > 1) this.emitState()
              },
              onToolCall: (call, recovered) => {
                const card: ToolCardView = {
                  callId: call.id,
                  name: call.function.name,
                  arguments: call.function.arguments,
                  recovered,
                  status: 'running',
                }
                turn.tools = [...(turn.tools ?? []), card]
                turn.parts = appendPart(turn.parts, { kind: 'tool', callId: call.id })
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
                const effect = toolResult.effect
                const showsOutput = (effect?.kind === 'command' && effect.ran) || (!toolResult.isError && readsProcessOutput(call.function.name, call.function.arguments))
                const output = showsOutput ? outputTail(toolResult.content) : undefined
                if (effect) {
                  effects.push(effect)
                  turn.run = [...effects]
                  if (effect.kind === 'command' && effect.ran && effect.processId && effect.exitCode === null && effect.cwd) {
                    this.inFlight?.processes.push({ id: effect.processId, command: effect.command, cwd: effect.cwd })
                  } else if (effect.kind === 'stop' && this.inFlight) {
                    this.inFlight.processes = this.inFlight.processes.filter((p) => p.id !== effect.processId)
                  }
                  // Saved as it happens: a crash keeps the run log so far.
                  this.deps.onPersist?.()
                }
                turn.tools = (turn.tools ?? []).map((card) =>
                  card.callId === call.id
                    ? {
                        ...card,
                        status: toolResult.isError ? 'error' : 'done',
                        summary: toolResult.summary,
                        truncated: toolResult.truncated,
                        ...(output ? { output } : {}),
                      }
                    : card,
                )
                this.emit({
                  type: 'tool/result',
                  turnId: turn.id,
                  callId: call.id,
                  name: call.function.name,
                  summary: toolResult.summary,
                  isError: toolResult.isError,
                  truncated: toolResult.truncated,
                  ...(toolResult.effect ? { effect: toolResult.effect } : {}),
                  ...(output ? { output } : {}),
                })
              },
            },
          })
        : await client.streamChatCompletion(this.buildRequest(null), handlers, controller.signal)
      if (registry) this.deps.onAgentResult?.(result as AgentResult)

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

      this.emitState()
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
      if (this.controller === controller) {
        this.controller = null
        this.deps.onBusyChanged?.()
      }
      this.inFlight = null
      this.deps.onPersist?.()
    }
  }

  /**
   * The loop's ask port: show the questions, wait for the person.
   *
   * agent-core sends 1 to 4 questions per call. Several are one card with a
   * tab each, answered as `answers` (one reply per question, null where not
   * answered). A message typed instead of using the card is one reply to all
   * of them, as the core expects.
   */
  private ask(request: AskRequest, callId: string | undefined, signal?: AbortSignal): Promise<AskAnswer | null> {
    const questions = request.questions
    const id = callId ?? this.nextId()
    if (questions.length <= 1) return this.askOne(questions[0]!, id, signal)
    return this.askOne(questions[0]!, id, signal, questions.map((q) => ({
      ...(q.header ? { header: q.header } : {}),
      question: q.question,
      multiSelect: q.multiSelect,
      ...(q.options && q.options.length > 0 ? { options: [...q.options] } : {}),
    })))
  }

  /** Show one question on the card and wait for its answer (null: skipped). */
  private askOne(
    question: AskRequest['questions'][number],
    id: string,
    signal?: AbortSignal,
    questions?: QuestionItemView[],
  ): Promise<AskAnswer | null> {
    if (signal?.aborted) return Promise.resolve(null)
    // One card at a time: a second ask_user while one is open (a reply with
    // two calls) skips the first rather than stacking cards.
    if (this.question) this.answer(this.question.view.id, null)
    const view: QuestionView = {
      id,
      question: question.question,
      multiSelect: question.multiSelect,
      ...(question.options && question.options.length > 0 ? { options: [...question.options] } : {}),
      ...(questions ? { questions } : {}),
    }
    return new Promise((resolve) => {
      const onAbort = () => this.answer(view.id, null)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.question = {
        view,
        resolve: (answer) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(answer)
        },
      }
      this.emitState()
    })
  }

  /** The loop's limit port: wait for "keep going?" at the turn limit. */
  private waitAtLimit(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false)
    return new Promise((resolve) => {
      const onAbort = () => this.continueAtLimit(false)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.limitWait = (go) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(go)
      }
      this.emitState()
    })
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

    // What the model knows about the workspace before its first call. Only
    // with tools: without them there is nothing it could do with it.
    const workspace = registry ? (this.deps.workspaceContext?.() ?? null) : null
    if (workspace) messages.push({ role: 'system', content: workspace })

    // The newest assistant messages keep their full run log; older ones get
    // one line. Decided by position, so a message's log stays the same text
    // until FULL_LOGS_KEPT newer ones push it out, and the cache holds.
    const assistants = this.messages.filter((m) => m.role === 'assistant' && !m.streaming)
    // Images go as image parts only to a model that reads them.
    const vision = this.deps.context?.()?.vision === true
    const fullFrom = assistants.length - FULL_LOGS_KEPT
    let assistantIndex = -1
    /** Run logs owed to the next user message. */
    const logs: string[] = []

    for (const message of this.messages) {
      if (message.role === 'assistant') {
        assistantIndex++
        const log = message.run?.length
          ? assistantIndex >= fullFrom ? formatRunLog(message.run) : collapsedRunLog(message.run)
          : null
        // What the run did is real even when the turn failed. It rides on
        // the next user message, never in the assistant's own words: a model
        // that sees the log as something it said writes one itself, and did,
        // on replies that ran nothing (agent/phantom-call.ts).
        if (log) logs.push(log)
        // A failed turn's text stays out (replaying an error teaches the model
        // to imitate it).
        if (message.error) continue
        const content = replayText(message)
        const reasoning = INCLUDE_REASONING_IN_CONTEXT ? message.reasoning : undefined
        if (!content && !reasoning) continue
        const entry: ChatCompletionRequest['messages'][number] = { role: 'assistant', content }
        if (reasoning) entry.reasoning_content = reasoning
        messages.push(entry)
      } else {
        let content = userContent(message.content, message.attachments, vision)
        if (logs.length) content = prependText(content, runLogNote(logs.splice(0)))
        messages.push({ role: 'user', content })
      }
    }
    // A run log with no user message after it (not the usual send) still goes.
    if (logs.length) messages.push({ role: 'user', content: runLogNote(logs) })

    // Live state goes on the newest message, not in the system message: it
    // changes whenever a process starts or stops, and a change at the start
    // of the request would cost the whole prompt cache.
    const live = registry ? (this.deps.liveState?.() ?? null) : null
    const newest = messages.at(-1)
    if (live && newest?.role === 'user') newest.content = prependText(newest.content, `[${live}]`)

    // No `tools` in Phase 1. That is load-bearing, not an omission: the gateway
    // only claims Nest capabilities in its injected system prompt when the
    // request actually carries tools, so a toolless request correctly produces a
    // model that does not believe it can call anything.
    const projectId = this.deps.projectId?.() ?? null
    return projectId ? { messages, redstart_project: projectId } : { messages }
  }

  private nextId(): string {
    return this.deps.newId ? this.deps.newId() : `m${Date.now()}${Math.random().toString(36).slice(2, 8)}`
  }
}

type RequestContent = ChatCompletionRequest['messages'][number]['content']

/**
 * What an earlier assistant turn is replayed as: its answer, the text after
 * the run's last tool call (or a dropped reply's notice). The narration in
 * between ("Let me read Hero.svelte:") goes without the calls it announced,
 * so replayed it reads as announcing a call and going straight on, and the
 * model learned to do exactly that (agent/phantom-call.ts).
 *
 * `content` is the record and `parts` only what was painted, so the parts are
 * used only when their text is the content: a turn saved before `parts`
 * existed, or a reply the host set without painting it, is sent whole. A run
 * log or think tag the model wrote itself is cut off either way.
 */
export function replayText(message: Pick<ChatMessageView, 'content' | 'parts'>): string {
  let text = message.content
  const parts = message.parts ?? []
  const painted = parts.map((part) => (part.kind === 'text' ? part.text : '')).join('')
  // A reply dropped by the loop was painted but is not in the content.
  const kept = parts.some((part) => part.kind === 'notice') || sameText(painted, message.content)
  if (parts.length && kept) {
    let from = 0
    parts.forEach((part, i) => {
      if (part.kind === 'tool' || part.kind === 'notice') from = i + 1
    })
    text = parts
      .slice(from)
      .map((part) => (part.kind === 'text' ? part.text : ''))
      .join('')
  }
  return withoutCopiedTail(text).trim()
}

/** The same text but for whitespace (the loop joins replies with blank lines). */
function sameText(a: string, b: string): boolean {
  const squash = (s: string) => s.replace(/\s+/g, '')
  return squash(a) === squash(b)
}

/** The run logs owed to a user message, said to be Yellowscript's. */
function runLogNote(logs: readonly string[]): string {
  return `${RUN_LOG_NOTE}\n${logs.join('\n\n')}`
}

/** `text` and a blank line before a user message's content. */
function prependText(content: RequestContent, text: string): RequestContent {
  if (typeof content === 'string') return `${text}\n\n${content}`
  const first = content[0]
  if (first?.type === 'text') return [{ ...first, text: `${text}\n\n${first.text}` }, ...content.slice(1)]
  return [{ type: 'text', text }, ...content]
}

function buildStats(timings: StreamTimings | undefined, finishReason: string | undefined): TurnStats | undefined {
  const rate = tokensPerSecond(timings)
  if (rate === null && !timings && !finishReason) return undefined

  const stats: TurnStats = {}
  if (rate !== null) stats.tokensPerSecond = rate
  if (typeof timings?.prompt_n === 'number') stats.promptTokens = timings.prompt_n
  if (typeof timings?.predicted_n === 'number') stats.completionTokens = timings.predicted_n
  const used = timings ? contextTokens(timings) : undefined
  if (used !== undefined) stats.contextTokens = used
  if (finishReason) stats.finishReason = finishReason
  return Object.keys(stats).length > 0 ? stats : undefined
}

/** What a request filled of the window: its prompt, cached or not, and the reply. */
function contextTokens(timings: StreamTimings): number | undefined {
  if (typeof timings.prompt_n !== 'number') return undefined
  return timings.prompt_n + (timings.cache_n ?? 0) + (timings.predicted_n ?? 0)
}

/** The most a command card shows of its output: the end, where the result is. */
export const OUTPUT_TAIL_CHARS = 6_000

/** A command's output for its card: the first line (the exit code, how it
 *  ended) and the end of the rest, cut on a line break. */
export function outputTail(text: string, max = OUTPUT_TAIL_CHARS): string | undefined {
  const trimmed = text.replace(/\r\n/g, '\n').trimEnd()
  if (!trimmed) return undefined
  if (trimmed.length <= max) return trimmed
  const nl = trimmed.indexOf('\n')
  const head = nl === -1 ? '' : trimmed.slice(0, nl)
  const tail = trimmed.slice(-max)
  const cut = tail.indexOf('\n')
  return `${head ? `${head}\n` : ''}…\n${cut >= 0 && cut < 400 ? tail.slice(cut + 1) : tail}`
}

/** A process `output` read: shown on its card like a command's. */
function readsProcessOutput(name: string, args: string): boolean {
  return name === 'ys_process' && /"action"\s*:\s*"output"/.test(args)
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

/**
 * A stagnation recovery as one line of the turn's timeline. Levels 1 and 2
 * changed what the model does next; level 3 ended the run, and the answer
 * after it says what was tried.
 */
export function recoveryLine(recovery: Pick<Recovery, 'level' | 'evidence' | 'action'>): string {
  if (recovery.level === 3) return `Stopped: not making progress. ${recovery.evidence}`
  const paused = recovery.level === 2 && recovery.action ? ` Paused ${pausedLabel(recovery.action)} until there is new evidence.` : ''
  return `Changed approach: ${recovery.evidence}${paused}`
}

/** `kind:search` → "searches"; an action family → the command or target. */
function pausedLabel(action: string): string {
  if (action.startsWith('kind:')) return ({ search: 'searches', write: 'edits', command: 'commands', read: 'reads' } as Record<string, string>)[action.slice(5)] ?? 'that'
  const at = action.indexOf(':')
  return at === -1 ? action : `\`${action.slice(at + 1)}\``
}
