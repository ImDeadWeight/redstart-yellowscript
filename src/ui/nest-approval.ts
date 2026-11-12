// =============================================================================
// Host-side approval for Nest's own tools — the prompt and the HTTP calls.
// =============================================================================
// The decision logic lives in nest/approval.ts (testable, no vscode). This file
// supplies its ports: a modal that asks the person, and the gateway routes
// that carry the decision to Nest (/approvals/*).
//
// Standing grants ("Always allow") are kept on the server per account, so they
// follow the person between Yellowscript, the chat app and Twig. We read them
// once per connection and keep the set; a grant added here is added to it.
// Revoking happens in the chat app's settings, so a revoke made there is seen
// on the next connection, never sooner — the safe direction would be the
// other way round, but the cost is one extra prompt, not one too few.
// =============================================================================

import * as vscode from 'vscode'

import type { NestClient } from '../nest/client.ts'
import type { ApprovalDecision, ApprovalDeps, ApprovalPromptRequest } from '../nest/approval.ts'

const ARGS_PREVIEW_CHARS = 600

interface ServerGrant {
  id: string
  tool: string
}

/** The arguments as the person reads them: pretty JSON, cut to a modal's size. */
export function argsPreview(args: unknown): string {
  let text: string
  try {
    text = JSON.stringify(args, null, 2) ?? ''
  } catch {
    text = String(args)
  }
  if (text === '{}' || text === '') return ''
  return text.length > ARGS_PREVIEW_CHARS ? `${text.slice(0, ARGS_PREVIEW_CHARS)}\n…` : text
}

async function promptPerson(request: ApprovalPromptRequest): Promise<ApprovalDecision> {
  const ONCE = 'Allow once'
  const ALWAYS = 'Always allow'
  const DENY = 'Deny'
  const kind = request.rule === 'always' ? 'a destructive tool' : 'a tool that changes things'
  const preview = argsPreview(request.args)
  const detail = [
    request.summary ? request.summary : null,
    preview ? `Arguments:\n${preview}` : null,
    request.rule === 'always'
      ? 'Nest asks for every call to this tool. It cannot be always allowed.'
      : 'Always allow is saved on Nest for your account, and applies in every Redstart app.',
  ]
    .filter(Boolean)
    .join('\n\n')

  const buttons = request.canAlwaysAllow ? [ONCE, ALWAYS, DENY] : [ONCE, DENY]
  const choice = await vscode.window.showWarningMessage(
    `Yellowscript wants to run ${kind} on Nest: ${request.tool}`,
    { modal: true, detail },
    ...buttons,
  )
  if (choice === ONCE) return 'once'
  if (choice === ALWAYS && request.canAlwaysAllow) return 'always'
  return 'deny'
}

/**
 * The approval ports for one connection. Build a new one on every reconnect:
 * the grant cache belongs to the account the client is signed in as.
 */
export function makeNestApprovalDeps(
  client: NestClient,
  log: (message: string) => void,
): Omit<ApprovalDeps, 'call'> {
  let grants: Promise<Set<string>> | null = null

  const loadGrants = (): Promise<Set<string>> => {
    grants ??= client
      .request<{ grants?: ServerGrant[] }>('/approvals/grants')
      .then((r) => new Set((r.grants ?? []).map((g) => g.tool)))
      .catch((err: unknown) => {
        // An older Nest has no /approvals routes, and enforces nothing either.
        log(`approvals: could not read standing grants — ${err instanceof Error ? err.message : String(err)}`)
        grants = null // try again next call
        return new Set<string>()
      })
    return grants
  }

  const post = (path: string, body: unknown) =>
    client.request<unknown>(path, { method: 'POST', body: JSON.stringify(body) }).then(() => undefined)

  return {
    prompt: promptPerson,
    hasGrant: async (tool) => (await loadGrants()).has(tool),
    decide: (id, decision) => post(`/approvals/${encodeURIComponent(id)}`, { decision }),
    addGrant: async (tool) => {
      await post('/approvals/grants', { tool })
      ;(await loadGrants()).add(tool)
    },
    logDenied: (tool) => post('/approvals/denied', { tool }),
    log,
  }
}
