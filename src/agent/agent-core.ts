// =============================================================================
// agent-core — Yellowscript's door to the shared Redstart agent loop.
// =============================================================================
// The loop every Redstart host runs (chat-ui, the agent bench, Nest's task
// runner) lives in redstart-project shared/agent-core/. It is vendored, pinned
// and hash-checked under src/vendor/agent-core/ (scripts/sync-agent-core.mjs);
// nothing there is edited here.
//
// The vendored modules are plain ESM typed with JSDoc. Under this repo's
// `nodenext` resolution their `import('./types')` type references do not
// resolve, so TypeScript would read every export as `any`. This file is the one
// place that re-types them, against the core's own types.d.ts, so a signature
// change upstream is a compile error here rather than a runtime surprise.
// =============================================================================

import * as loop from '../vendor/agent-core/loop.mjs'
import * as toolCalls from '../vendor/agent-core/tool-calls.mjs'
import * as parser from '../vendor/agent-core/tool-call-parser.mjs'
import * as askUser from '../vendor/agent-core/ask-user.mjs'
import * as updatePlan from '../vendor/agent-core/update-plan.mjs'
import * as compaction from '../vendor/agent-core/compaction.mjs'
import * as approval from '../vendor/agent-core/approval.mjs'
import * as teaching from '../vendor/agent-core/teaching.mjs'
import * as stagnation from '../vendor/agent-core/stagnation.mjs'
import * as workingState from '../vendor/agent-core/working-state.mjs'
import * as lookup from '../vendor/agent-core/lookup.mjs'

import type {
  AgentLoopParams,
  AgentToolCall,
  AskAnswer,
  AskRequest,
  ParsedToolCall,
  PlanStep,
  RawToolCall,
  ToolCallParserConfig,
} from '../vendor/agent-core/types.d.ts'

export type {
  AgentLoopParams,
  AgentMessage,
  AgentPorts,
  AgentStoreCallbacks,
  AgentToolCall,
  AskAnswer,
  AskRequest,
  ParsedToolCall,
  PlanStep,
  RawToolCall,
  Timings,
  ToolCallParserConfig,
  ToolExecution,
  TurnAccumulator,
} from '../vendor/agent-core/types.d.ts'

/** Run a flow to its end (agent-core loop.mjs). */
export const runAgentLoop: <A = unknown>(params: AgentLoopParams<A>) => Promise<void> = loop.runAgentLoop

/** Earlier calls as they may be sent back: malformed arguments go as "{}"
 *  (llama-server fails the whole request on one that does not parse). */
export const wireSafeToolCalls: <T extends { function?: { name?: string; arguments?: string } }>(
  calls: T[] | undefined,
) => T[] | undefined = toolCalls.wireSafeToolCalls

export const normalizeToolCalls: (calls: RawToolCall[] | undefined) => AgentToolCall[] = toolCalls.normalizeToolCalls

export const DENIED_RESULT: string = toolCalls.DENIED_RESULT
export const INTERRUPTED_RESULT: string = toolCalls.INTERRUPTED_RESULT
export const MAX_TOOL_CALLS_PER_REPLY: number = toolCalls.MAX_TOOL_CALLS_PER_REPLY

export const parseToolCallsFromTurn: (
  content: string,
  reasoning: string | undefined,
  config: ToolCallParserConfig,
) => ParsedToolCall[] = parser.parseToolCallsFromTurn

export const parseToolCallsFromText: (text: string, config: ToolCallParserConfig) => ParsedToolCall[] =
  parser.parseToolCallsFromText

export const createApiToolCalls: (parsed: ParsedToolCall[]) => AgentToolCall[] = parser.createApiToolCalls

/** The id prefix agent-core gives a call it recovered from the model's text. */
export const FALLBACK_ID_PREFIX: string = parser.FALLBACK_ID_PREFIX

export const ASK_USER_TOOL: string = askUser.ASK_USER_TOOL
export const formatAskAnswer: (answer: AskAnswer | null, request?: AskRequest) => string = askUser.formatAskAnswer
export type { AskRequest as AskUserRequest }

export const UPDATE_PLAN_TOOL: string = updatePlan.UPDATE_PLAN_TOOL
export const openSteps: (steps: readonly PlanStep[] | null) => PlanStep[] = updatePlan.openSteps

/** n_ctx and the send budget for the messages: n_ctx minus reply headroom and overhead. */
export const compactionBudget: (
  nCtx: number | null | undefined,
  maxTokens: unknown,
  overheadTokens?: unknown,
) => { nCtx: number; usable: number } | null = compaction.compactionBudget

/** The tool a call_tool call names, and its arguments, or null (Nest's catalog dispatcher). */
export const callToolTarget: (name: string, args: unknown) => { name: string; args: Record<string, unknown> } | null =
  approval.callToolTarget

/** The tool definitions for the two host-answered tools (name, description, inputSchema). */
export interface HostToolDefinition {
  name: string
  description: string
  inputSchema: unknown
}
export const ASK_USER_DEFINITION: HostToolDefinition = askUser.ASK_USER_DEFINITION
export const UPDATE_PLAN_DEFINITION: HostToolDefinition = updatePlan.UPDATE_PLAN_DEFINITION

// --- teaching: refusals that say what to do instead ----------------------------

/** The error for a tool name that does not exist: what happened, and the caller's real tool for the job. */
export const unknownToolText: (name: string, available: readonly string[]) => string = teaching.unknownToolText
/** The caller's tools that do the job `name` names; `tools` empty when none does. */
export const suggestTools: (name: string, available: readonly string[]) => { kind: string; tools: string[] } = teaching.suggestTools

// --- stagnation: noticing a stuck run ---------------------------------------------

export type CallKind = 'read' | 'search' | 'write' | 'command' | 'diagnostics' | 'other'

export interface CallInfo {
  name: string
  args: string
  kind: CallKind
  /** What makes two calls "the same call" (default: name and arguments). */
  signature?: string
  /** What makes two calls "the same action" (default: actionFamily). */
  family?: string
}

export interface CallOutcome {
  ok: boolean
  rejected?: boolean
  /** check() refused it: an attempt, with no error of its own. */
  refused?: 'repeated' | 'blocked'
  text?: string
  reads?: string[]
  writes?: { path: string; before?: string; after: string; isNew?: boolean; isDeleted?: boolean }[]
  /** A decision the model wrote down (ys_note), for the working state. */
  note?: string
}

export type Detector = 'same-failure' | 'oscillation' | 'no-progress' | 'reasoning-loop' | 'theorizing' | 'argument-loop'

export interface Recovery {
  detector: Detector
  /** 1 a note, 2 the repeated action refused, 3 the run stops. */
  level: 1 | 2 | 3
  evidence: string
  /** What the model reads (levels 1 and 2), or the person (level 3). */
  note: string
  stop: boolean
  action?: string
}

export interface StagnationLimits {
  identicalCalls: number
  sameFailure: number
  failureRounds: number
  noProgressRounds: number
  sentenceWindow: number
  sentenceRepeats: number
  repeatedShare: number
  minSentences: number
  minSentenceWords: number
  theorizingChars: number
  reversals: number
  /** Reasoning characters reversals also need before they fire. */
  reversalChars: number
  /** How much of a call's arguments must repeat one stretch to fire. */
  argumentSpan: number
  /** The longest stretch that counts as repeating. */
  argumentPeriod: number
}

export interface StagnationMonitor {
  readonly limits: StagnationLimits
  startResponse(): void
  check(call: CallInfo): { refuse: string; reason: 'repeated' | 'blocked' } | null
  record(call: CallInfo, outcome: CallOutcome): void
  reasoning(chunk: string): Recovery | null
  /** As a tool call's arguments stream: `index` is its place in the response. */
  toolArguments(index: number, chunk: string, kind?: CallKind): Recovery | null
  endRound(): Recovery | null
  readonly firings: Recovery[]
  readonly level: number
}

export const STAGNATION_LIMITS: Readonly<StagnationLimits> = stagnation.STAGNATION_LIMITS as Readonly<StagnationLimits>
export const DEBUGGING_PROCEDURE: string = stagnation.DEBUGGING_PROCEDURE
// The core's JSDoc reads its limits as literal types (Object.freeze); the
// overrides are any numbers.
export const createStagnationMonitor = stagnation.createStagnationMonitor as unknown as (
  overrides?: Partial<StagnationLimits>,
  /** lookupTools: the web tools the model has; the notes name the first,
   *  and a lookup is never paused. */
  options?: { lookupTools?: readonly string[] },
) => StagnationMonitor
export const repeatedCallResult: (name: string, times: number) => string = stagnation.repeatedCallResult
/** The line of a failure worth quoting, without terminal codes and frames; empty when there is none. */
export const failureLine: (text: string) => string = stagnation.failureLine
export const errorSignature: (text: string) => string = stagnation.errorSignature
export const actionFamily: (name: string, args: string, kind: CallKind) => string = stagnation.actionFamily

// --- lookup: when a library is newer than the model ------------------------------

/** The web tools, in the order a note names them. */
export const LOOKUP_TOOLS: readonly string[] = lookup.LOOKUP_TOOLS
/** The system prompt line on when to look things up; '' without a web tool. */
export const lookupGuidance: (tools: readonly string[]) => string = lookup.lookupGuidance
/** The note for a package.json's text: dependencies newer than the model knows; '' for none. */
export const manifestNote: (text: string, tools: readonly string[]) => string = lookup.manifestNote

// --- working state: what a run learned, kept past trimming --------------------------

export interface WorkingState {
  observe(call: CallInfo, outcome: CallOutcome): void
  setPlan(steps: readonly PlanStep[] | null | undefined): void
  readonly empty: boolean
  render(): string
}

export const WORKING_STATE_HEADER: string = workingState.WORKING_STATE_HEADER
export const createWorkingState: (options?: { maxChars?: number }) => WorkingState = workingState.createWorkingState

// --- compaction's thresholds, shared with context-budget.ts ----------------------

export const TRIGGER_RATIO: number = compaction.TRIGGER_RATIO
export const KEEP_RATIO: number = compaction.KEEP_RATIO
export const MAX_SINGLE_MESSAGE_TOKENS_RATIO: number = compaction.MAX_SINGLE_MESSAGE_TOKENS_RATIO
export const PER_MESSAGE_OVERHEAD_TOKENS: number = compaction.PER_MESSAGE_OVERHEAD_TOKENS

// --- the old/new-string matcher, shared with Nest's artifact_edit (artifacts plan D3) ---

import * as replaceMatch from '../vendor/agent-core/replace-match.mjs'
import * as artifactLines from '../vendor/agent-core/artifact-lines.mjs'

export interface ClosestText {
  startLine: number
  endLine: number
  matched: number
  total: number
  firstDiff: { wantedLine: number; wanted: string; fileLine: number; actual: string } | null
  text: string
}

export const looseReplace: (file: string, oldString: string, newString: string) => { after: string; line: number } | null =
  replaceMatch.looseReplace
export const closestText: (file: string, oldString: string) => ClosestText | null = replaceMatch.closestText
export const showLine: (line: string) => string = replaceMatch.showLine

// --- the [artifact: <id> r<n>|draft] line an artifacts tool result ends with ---

export interface ArtifactRef {
  id: string
  revision: number | 'draft'
}
export const parseArtifactLines: (text: string) => ArtifactRef[] = artifactLines.parseArtifactLines
export const stripArtifactLines: (text: string) => string = artifactLines.stripArtifactLines
