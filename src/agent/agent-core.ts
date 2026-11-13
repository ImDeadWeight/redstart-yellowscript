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
export const formatAskAnswer: (answer: AskAnswer | null) => string = askUser.formatAskAnswer
export type { AskRequest as AskUserRequest }

export const UPDATE_PLAN_TOOL: string = updatePlan.UPDATE_PLAN_TOOL
export const openSteps: (steps: readonly PlanStep[] | null) => PlanStep[] = updatePlan.openSteps
