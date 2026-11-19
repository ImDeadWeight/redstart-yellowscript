// =============================================================================
// Context budget — keep a long agent run inside the model's window.
// =============================================================================
// A coding task is one long flow: every tool result is appended to the run's
// messages and sent again on every later request. On a ~32k local model five
// file reads fill the window, and llama-server then refuses the whole request.
//
// Yellowscript does not replay earlier turns' tool results (ChatSession sends
// user and assistant text only), so the growth that matters is INSIDE a run,
// and that is where this works: right before each request.
//
// THE ORDER OF LEVERS, cheapest loss first:
//
// 1. Old tool results become a one-line stub that names the tool and says the
//    model can call it again. A file read is cheap to repeat; a summary of it
//    is not a file read. Oldest first, never the newest few messages.
// 2. Old write calls keep their path but lose the big string arguments
//    (a ys_write_file carries the whole file). Rewritten as valid JSON,
//    because llama-server parses every earlier call's arguments.
// 3. Any single message still larger than 40% of the window is cut to its
//    head and tail (agent-core's per-message cap, same ratio).
//
// Levers 1 and 2 start at TRIGGER_RATIO of the usable window and run until
// KEEP_RATIO, so a trim buys several turns of room rather than one. They edit
// the run's messages IN PLACE: later requests then share the same trimmed
// prefix, which keeps llama.cpp's prompt cache warm, and a stub is never
// recomputed differently. User messages are never touched.
//
// THE BUDGET is agent-core's (compactionBudget): n_ctx, minus headroom for the
// reply, minus the overhead the gateway adds (its system prompt and the tool
// list). The overhead is learned from each reply's timings: the prompt the
// server actually processed, minus this module's estimate of the messages.
//
// No `vscode` import.
// =============================================================================

import { compactionBudget } from './agent-core.ts'

/** Start trimming when the estimate passes this fraction of the usable window. */
export const TRIGGER_RATIO = 0.85
/** Trim down to this fraction, so one trim buys several turns. */
export const KEEP_RATIO = 0.5
/** A single message may take at most this fraction of the usable window. */
export const MAX_SINGLE_MESSAGE_RATIO = 0.4
/** The newest messages are never stubbed: the model is working on them. */
export const PROTECTED_TAIL = 4
/** String arguments longer than this are elided from old tool calls. */
export const MAX_KEPT_ARGUMENT_CHARS = 200
/** Per-message template overhead the character estimate does not see. */
const PER_MESSAGE_TOKENS = 6
/** Before the first reply has been measured: the gateway's prompt and tools. */
export const DEFAULT_OVERHEAD_TOKENS = 3_000

/** Marks a stubbed result, so a second pass leaves it alone. */
const STUB_MARK = '[Earlier result of '

/** The message shape the loop sends (OpenAI wire, as agent-core keeps it). */
export interface BudgetMessage {
  role: string
  content?: unknown
  reasoning_content?: string | undefined
  tool_call_id?: string | undefined
  tool_calls?: Array<{ id: string; type?: string; function: { name: string; arguments: string } }> | undefined
}

/** chars/3: conservative for code, so trimming starts slightly early. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3)
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('\n')
  }
  return ''
}

/** The estimated tokens one message costs on the wire. */
export function messageTokens(message: BudgetMessage): number {
  let chars = contentText(message.content).length
  if (message.reasoning_content) chars += message.reasoning_content.length
  if (message.tool_calls) chars += JSON.stringify(message.tool_calls).length
  return Math.ceil(chars / 3) + PER_MESSAGE_TOKENS + imageParts(message.content) * IMAGE_TOKENS
}

/** A vision model's cost for one image, roughly (a 1280×800 screenshot). */
export const IMAGE_TOKENS = 1_000

function imageParts(content: unknown): number {
  if (!Array.isArray(content)) return 0
  return content.filter((p) => p && typeof p === 'object' && (p as { type?: unknown }).type === 'image_url').length
}

export function totalTokens(messages: readonly BudgetMessage[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0)
}

/** The stub that replaces an old tool result. */
export function resultStub(toolName: string, originalChars: number): string {
  return (
    `${STUB_MARK}${toolName} (${originalChars.toLocaleString('en-US')} characters) removed to fit the context window. ` +
    'Call the tool again if you still need it.]'
  )
}

/**
 * A tool call's arguments with every long string replaced by a note, still
 * valid JSON. Arguments that are not a JSON object come back unchanged
 * (the wire-safety pass turns those into "{}" anyway).
 */
export function shrinkArguments(args: string, keepChars = MAX_KEPT_ARGUMENT_CHARS): string {
  if (args.length <= keepChars) return args
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return args
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return args
  let changed = false
  const shrink = (value: unknown): unknown => {
    if (typeof value === 'string' && value.length > keepChars) {
      changed = true
      return `[${value.length.toLocaleString('en-US')} characters removed to fit the context window]`
    }
    if (Array.isArray(value)) return value.map(shrink)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v)]))
    }
    return value
  }
  const next = shrink(parsed)
  return changed ? JSON.stringify(next) : args
}

/** Head and tail of an oversized text, with a marker between. */
export function capText(text: string, limitTokens: number): string {
  const keepChars = Math.max(200, Math.floor(limitTokens * 3 * 0.45))
  if (text.length <= keepChars * 2) return text
  return (
    text.slice(0, keepChars) +
    '\n…[middle removed — this message exceeded the context budget]…\n' +
    text.slice(-keepChars)
  )
}

export interface BudgetLimits {
  /** The model's context window, in tokens. */
  nCtx: number
  /** Headroom for the reply. */
  replyTokens: number
  /** The gateway's system prompt and the tool list, in tokens. */
  overheadTokens: number
}

export interface FitReport {
  /** The usable window for messages; null when the limits leave none. */
  usable: number | null
  before: number
  after: number
  /** Tool results replaced by a stub in this pass. */
  stubbed: number
  /** Tool calls whose long arguments were elided in this pass. */
  shrunk: number
  /** Messages cut to head and tail in this pass. */
  capped: number
  /** Still over the usable window after every lever. */
  overLimit: boolean
}

/**
 * Fit a run's messages to the budget, editing them in place.
 *
 * `force` trims whatever the estimate says, to half the run as well as to
 * KEEP_RATIO: the server has just refused the request, so the estimate was low.
 */
export function fitMessages(messages: BudgetMessage[], limits: BudgetLimits, force = false): FitReport {
  const budget = compactionBudget(limits.nCtx, limits.replyTokens, limits.overheadTokens)
  const before = totalTokens(messages)
  const report: FitReport = { usable: budget?.usable ?? null, before, after: before, stubbed: 0, shrunk: 0, capped: 0, overLimit: false }
  if (!budget) {
    report.overLimit = true
    return report
  }
  const usable = budget.usable
  let total = before
  // After a refusal the estimate is known to be low, so the line it says is
  // safe is not: halve the run itself too.
  const target = force ? Math.min(usable * KEEP_RATIO, before * KEEP_RATIO) : usable * KEEP_RATIO

  if (force || total > usable * TRIGGER_RATIO) {
    // Which tool each result belongs to, for the stub's wording.
    const nameById = new Map<string, string>()
    for (const m of messages) for (const call of m.tool_calls ?? []) nameById.set(call.id, call.function.name)

    const lastTrimmable = messages.length - PROTECTED_TAIL
    for (let i = 0; i < lastTrimmable && total > target; i++) {
      const m = messages[i]!
      if (m.role === 'tool') {
        const text = contentText(m.content)
        if (text.startsWith(STUB_MARK)) continue
        const stub = resultStub(nameById.get(m.tool_call_id ?? '') ?? 'a tool', text.length)
        if (stub.length >= text.length) continue
        const was = messageTokens(m)
        m.content = stub
        total += messageTokens(m) - was
        report.stubbed++
      } else if (m.role === 'assistant' && m.tool_calls?.length) {
        const was = messageTokens(m)
        let changed = false
        // New call objects, not edits: the same objects are the run's record
        // (toolRuns, the cards), which must keep what the model really sent.
        m.tool_calls = m.tool_calls.map((call) => {
          const next = shrinkArguments(call.function.arguments)
          if (next === call.function.arguments) return call
          changed = true
          return { ...call, function: { ...call.function, arguments: next } }
        })
        // Old thinking is not sent back by default; drop it here too if present.
        if (m.reasoning_content) {
          m.reasoning_content = undefined
          changed = true
        }
        if (changed) {
          total += messageTokens(m) - was
          report.shrunk++
        }
      }
    }
  }

  // The last lever: one message that alone is too big, anywhere but a user's.
  const limit = usable * MAX_SINGLE_MESSAGE_RATIO
  if (total > target) {
    for (const m of messages) {
      if (m.role === 'user' || m.role === 'system') continue
      const was = messageTokens(m)
      if (was <= limit || typeof m.content !== 'string') continue
      m.content = capText(m.content, limit)
      total += messageTokens(m) - was
      report.capped++
    }
  }

  report.after = total
  report.overLimit = total > usable
  return report
}

// ---------------------------------------------------------------------------
// The tracker: what is known about one connection's window.
// ---------------------------------------------------------------------------

/** What a NestClient can tell the tracker. */
export interface ContextSource {
  /** n_ctx from llama-server's /props, or null when it cannot be read. */
  props(signal?: AbortSignal): Promise<{ nCtx: number | null; vision?: boolean }>
}

/**
 * One connection's context window, and the overhead the gateway adds to each
 * request. Created per connection; n_ctx is read once, and corrected by the
 * server's own "context exceeded" refusal when it is wrong or unreadable.
 */
export class ContextTracker {
  private nCtx: number | null = null
  private canSee = false
  private overhead = DEFAULT_OVERHEAD_TOKENS
  private loading: Promise<void> | null = null
  private readonly source: ContextSource

  constructor(source: ContextSource) {
    this.source = source
  }

  /** Read n_ctx once. Never throws: unknown just means no trimming yet. */
  ready(signal?: AbortSignal): Promise<void> {
    if (this.nCtx !== null) return Promise.resolve()
    this.loading ??= this.source
      .props(signal)
      .then((p) => {
        if (p.nCtx && p.nCtx > 0) this.nCtx = p.nCtx
        this.canSee = p.vision === true
      })
      .catch(() => {})
      .finally(() => {
        this.loading = null
      })
    return this.loading
  }

  get contextSize(): number | null {
    return this.nCtx
  }

  /** The model reads images (llama-server's modalities.vision). */
  get vision(): boolean {
    return this.canSee
  }

  get overheadTokens(): number {
    return this.overhead
  }

  /** The limits to fit against, or null while n_ctx is unknown. */
  limits(): BudgetLimits | null {
    if (!this.nCtx) return null
    // Room for a reply that writes a whole file, without starving a small window.
    const replyTokens = Math.min(4_096, Math.floor(this.nCtx * 0.15))
    return { nCtx: this.nCtx, replyTokens, overheadTokens: this.overhead }
  }

  /**
   * After a reply: the server says how big the prompt really was
   * (prompt_n + cache_n). The difference from the estimate is the overhead.
   */
  recordPrompt(actualPromptTokens: number, estimatedMessageTokens: number): void {
    if (!(actualPromptTokens > 0)) return
    this.overhead = Math.max(0, actualPromptTokens - estimatedMessageTokens)
  }

  /** The server refused a request as too large: believe its numbers. */
  recordExceeded(nCtx: number, promptTokens: number | undefined, estimatedMessageTokens: number): void {
    if (nCtx > 0) this.nCtx = nCtx
    if (promptTokens && promptTokens > 0) this.recordPrompt(promptTokens, estimatedMessageTokens)
  }
}
