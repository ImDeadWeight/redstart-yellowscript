// =============================================================================
// Nest tool approvals — the person's decision, carried to the server.
// =============================================================================
// Nest (agent-runtime Phase 2) gives every tool an approval rule and enforces
// it on some of them:
//
//   rule 'none'    reads and web fetches: run.
//   rule 'prompt'  writes: ask, unless the account holds a standing grant
//                  ("Always allow", kept on the server per account).
//   rule 'always'  destructive tools: ask on every call; never grantable.
//
// An ENFORCED tool (every 'always' one today) is refused by the server until
// the decision reaches it: tools/call answers isError with a pending approval
// in `result._meta['redstart/approval']`, the client POSTs the decision to
// /approvals/:id, and repeats the call with the approval's id in
// `params._meta['redstart/approvalId']`. That approval is for one exact call
// (account, tool, arguments), works once and expires after 60 seconds.
//
// THE RULE THIS FILE KEEPS: an approval is only ever posted for a call the
// person approved in the prompt for THAT call. A call that got past the gate on
// a standing grant, or without a prompt at all, is never approved on anyone's
// behalf — the model reads Nest's "nothing was done" instead. Same rule as
// chat-ui's executor (mcp-tool-ops.ts executeTool).
//
// The wire names and texts below are copied from redstart-project
// shared/agent-core/approval.mjs and tool-calls.mjs (branch feat/agent-core).
// They go when Yellowscript imports agent-core instead (IDE plan step 2).
//
// No `vscode` import: the prompt and the HTTP calls are injected.
// =============================================================================

export const APPROVAL_RULE_META_KEY = 'redstart/approvalRule'
export const APPROVAL_ENFORCED_META_KEY = 'redstart/approvalEnforced'
export const APPROVAL_META_KEY = 'redstart/approval'
export const APPROVAL_ID_META_KEY = 'redstart/approvalId'

/** What the model reads when it asked for something the person refused.
 *  Says what the refusal means for the rest of the task, not only that it
 *  happened (agent-core DENIED_RESULT). */
export const DENIED_RESULT =
  'The user refused this call, so it was not run. Do not try it again. Carry on with any other steps that do not depend on it, and say in your answer what was not done.'

/** What the model reads when Nest wanted an approval that never reached it
 *  (agent-core APPROVAL_NEEDED_TEXT). */
export const APPROVAL_NEEDED_TEXT =
  "Not done: this call needs the user's approval on the app's approval card, and it was not given. " +
  'Asking in the chat cannot approve it, so do not ask; tell the user it was not done.'

export type ApprovalRule = 'none' | 'prompt' | 'always'
export type ApprovalDecision = 'once' | 'always' | 'deny'

export interface PendingApproval {
  id: string
  tool: string
  summary: string
  argsDigest: string
  expiresAt: number
}

/** A tool's approval rule from its tools/list `_meta`. */
export interface ToolApprovalInfo {
  rule: ApprovalRule
  enforced: boolean
}

/**
 * Read a tool's rule from its `_meta`. A tool with no rule is from a Nest older
 * than Phase 2, where nothing was enforced: 'none', so the client behaves as
 * it did before rather than prompting for every read.
 */
export function approvalInfo(meta: Record<string, unknown> | undefined): ToolApprovalInfo {
  const raw = meta?.[APPROVAL_RULE_META_KEY]
  const rule: ApprovalRule = raw === 'prompt' || raw === 'always' ? raw : 'none'
  return { rule, enforced: meta?.[APPROVAL_ENFORCED_META_KEY] === true }
}

/**
 * The pending approval a tools/call result carries, or null when it is not an
 * approval refusal. Checks the shape: a result is the server's word, and a
 * malformed one must read as "not an approval", never throw.
 */
export function approvalRequired(result: unknown): PendingApproval | null {
  if (!result || typeof result !== 'object') return null
  const r = result as { isError?: unknown; _meta?: Record<string, unknown> }
  if (r.isError !== true) return null
  const p = r._meta?.[APPROVAL_META_KEY]
  if (!p || typeof p !== 'object') return null
  const a = p as Record<string, unknown>
  if (typeof a.id !== 'string' || !a.id || typeof a.tool !== 'string') return null
  return {
    id: a.id,
    tool: a.tool,
    summary: typeof a.summary === 'string' ? a.summary : '',
    argsDigest: typeof a.argsDigest === 'string' ? a.argsDigest : '',
    expiresAt: typeof a.expiresAt === 'number' ? a.expiresAt : 0,
  }
}

/** One tools/call as the gate sees it. */
export interface NestCallResult {
  text: string
  isError: boolean
  approval: PendingApproval | null
}

export interface ApprovalPromptRequest {
  tool: string
  args: unknown
  rule: Exclude<ApprovalRule, 'none'>
  /** Nest's own one-line description of the call, when it already sent one. */
  summary?: string
  /** True when "Always allow" may be offered (a 'prompt' tool only). */
  canAlwaysAllow: boolean
}

export interface ApprovalDeps {
  /** One tools/call. `meta` becomes `params._meta`. */
  call(meta?: Record<string, unknown>): Promise<NestCallResult>
  /** Ask the person. Resolve 'deny' on dismissal. */
  prompt(request: ApprovalPromptRequest): Promise<ApprovalDecision>
  /** POST /approvals/:id { decision } */
  decide(approvalId: string, decision: ApprovalDecision): Promise<void>
  /** Does the account hold a standing grant for this tool? Cached by the host. */
  hasGrant(tool: string): Promise<boolean>
  /** POST /approvals/grants { tool } — "Always allow" on a tool Nest does not enforce. */
  addGrant(tool: string): Promise<void>
  /** POST /approvals/denied { tool } — a Deny decided here, for Nest's decision log. */
  logDenied(tool: string): Promise<void>
  log?(message: string): void
}

/**
 * Run one Nest tool call through its approval rule. Returns the text the model
 * reads. Never throws for a server or network fault on the approval side: those
 * fall back to the server's own refusal text, which says nothing was done.
 */
export async function callWithApproval(
  tool: string,
  args: unknown,
  info: ToolApprovalInfo,
  deps: ApprovalDeps,
): Promise<NestCallResult> {
  const log = deps.log ?? (() => {})
  const fireAndForget = (p: Promise<void>, what: string) => {
    p.catch((err: unknown) => log(`approvals: ${what} failed — ${err instanceof Error ? err.message : String(err)}`))
  }

  // 1. The gate, before anything reaches the server.
  let decision: ApprovalDecision | null = null
  if (info.rule !== 'none') {
    const granted = info.rule === 'prompt' && (await deps.hasGrant(tool).catch(() => false))
    if (!granted) {
      decision = await deps.prompt({
        tool,
        args,
        rule: info.rule,
        canAlwaysAllow: info.rule === 'prompt',
      })
      if (decision === 'deny') {
        if (info.enforced) fireAndForget(deps.logDenied(tool), 'logging a deny')
        return { text: DENIED_RESULT, isError: true, approval: null }
      }
      if (decision === 'always' && info.rule === 'prompt' && !info.enforced) {
        // Nest will not ask for this one, so the grant has to be saved here.
        // An enforced tool's grant is saved by the server when the decision is posted.
        fireAndForget(deps.addGrant(tool), 'saving a standing grant')
      }
    }
  }

  // 2. The call.
  const first = await deps.call()
  if (!first.approval) return first

  // 3. Nest wants an approval. Only for a call the person approved just now —
  //    or, when Nest enforces a tool its tools/list did not say it would (an
  //    old cache, a rule changed under us), ask now, with Nest's own summary.
  if (decision === null) {
    decision = await deps.prompt({
      tool,
      args,
      rule: 'always',
      summary: first.approval.summary,
      canAlwaysAllow: false,
    })
  }
  try {
    await deps.decide(first.approval.id, decision)
  } catch (err) {
    log(`approvals: could not record the decision for "${tool}" — ${err instanceof Error ? err.message : String(err)}`)
    return { ...first, text: APPROVAL_NEEDED_TEXT }
  }
  if (decision === 'deny') return { text: DENIED_RESULT, isError: true, approval: null }
  if (decision === 'always' && info.rule === 'prompt') {
    // Nest saved the grant when it took the decision. Adding it again is a
    // no-op there, and keeps the host's grant cache in step with the server.
    fireAndForget(deps.addGrant(tool), 'saving a standing grant')
  }

  const second = await deps.call({ [APPROVAL_ID_META_KEY]: first.approval.id })
  if (second.approval) {
    // Refused again (expired between decision and call, or a server bug). Do
    // not loop: one approval per call, and the model is told nothing ran.
    log(`approvals: "${tool}" refused again after an approval`)
    return { ...second, text: APPROVAL_NEEDED_TEXT }
  }
  return second
}
