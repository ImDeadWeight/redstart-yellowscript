// =============================================================================
// Tests for the Nest approval exchange (nest/approval.ts).
// =============================================================================
// The property that matters most: an approval is only ever posted for a call
// the person approved in the prompt for that call. Everything else here is
// the gate's rules (none / prompt / always, standing grants) and what the
// model reads when the exchange does not complete.
// =============================================================================

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  APPROVAL_ID_META_KEY,
  APPROVAL_NEEDED_TEXT,
  DENIED_RESULT,
  approvalInfo,
  approvalRequired,
  callWithApproval,
  type ApprovalDecision,
  type ApprovalDeps,
  type ApprovalPromptRequest,
  type NestCallResult,
  type PendingApproval,
} from './approval.ts'

const PENDING: PendingApproval = { id: 'ap-1', tool: 'delete_file', summary: 'Delete notes.md', argsDigest: 'd', expiresAt: 1 }
const ok = (text = 'done'): NestCallResult => ({ text, isError: false, approval: null })
const refused = (approval = PENDING): NestCallResult => ({ text: 'Not done', isError: true, approval })

interface Recorder {
  deps: ApprovalDeps
  calls: Array<Record<string, unknown> | undefined>
  prompts: ApprovalPromptRequest[]
  decided: Array<[string, ApprovalDecision]>
  grantsAdded: string[]
  denied: string[]
}

/** A fake Nest. `server` answers each tools/call in order. */
function recorder(opts: {
  server: Array<NestCallResult | ((meta?: Record<string, unknown>) => NestCallResult)>
  answer?: ApprovalDecision
  grants?: string[]
  decideFails?: boolean
}): Recorder {
  const r: Recorder = { calls: [], prompts: [], decided: [], grantsAdded: [], denied: [], deps: undefined as never }
  let i = 0
  r.deps = {
    call: async (meta) => {
      r.calls.push(meta)
      const next = opts.server[i++]
      if (!next) throw new Error('unexpected extra call')
      return typeof next === 'function' ? next(meta) : next
    },
    prompt: async (req) => {
      r.prompts.push(req)
      return opts.answer ?? 'once'
    },
    decide: async (id, decision) => {
      if (opts.decideFails) throw new Error('503')
      r.decided.push([id, decision])
    },
    hasGrant: async (tool) => (opts.grants ?? []).includes(tool),
    addGrant: async (tool) => {
      r.grantsAdded.push(tool)
    },
    logDenied: async (tool) => {
      r.denied.push(tool)
    },
  }
  return r
}

const flush = () => new Promise((res) => setTimeout(res, 0))

describe('approvalInfo', () => {
  it('reads the rule and the enforced flag from _meta', () => {
    assert.deepEqual(
      approvalInfo({ 'redstart/approvalRule': 'always', 'redstart/approvalEnforced': true }),
      { rule: 'always', enforced: true },
    )
  })
  it('treats a tool with no rule (a Nest before approvals) as none', () => {
    assert.deepEqual(approvalInfo(undefined), { rule: 'none', enforced: false })
    assert.deepEqual(approvalInfo({ 'redstart/approvalRule': 'sometimes' }), { rule: 'none', enforced: false })
  })
})

describe('approvalRequired', () => {
  it('finds a pending approval on an error result', () => {
    const p = approvalRequired({ isError: true, _meta: { 'redstart/approval': { id: 'a', tool: 't' } } })
    assert.equal(p?.id, 'a')
    assert.equal(p?.summary, '')
  })
  it('is null for a success, a malformed approval, or garbage', () => {
    assert.equal(approvalRequired({ isError: false, _meta: { 'redstart/approval': { id: 'a', tool: 't' } } }), null)
    assert.equal(approvalRequired({ isError: true, _meta: { 'redstart/approval': { id: '' } } }), null)
    assert.equal(approvalRequired('nope'), null)
    assert.equal(approvalRequired(null), null)
  })
})

describe('callWithApproval', () => {
  it('runs a none-rule tool without asking', async () => {
    const r = recorder({ server: [ok('rows')] })
    const out = await callWithApproval('read_file', {}, { rule: 'none', enforced: false }, r.deps)
    assert.equal(out.text, 'rows')
    assert.equal(r.prompts.length, 0)
  })

  it('asks before a prompt-rule tool, and skips the prompt with a standing grant', async () => {
    const asked = recorder({ server: [ok()] })
    await callWithApproval('write_file', { path: 'a' }, { rule: 'prompt', enforced: false }, asked.deps)
    assert.equal(asked.prompts.length, 1)
    assert.equal(asked.prompts[0]?.canAlwaysAllow, true)

    const granted = recorder({ server: [ok()], grants: ['write_file'] })
    await callWithApproval('write_file', { path: 'a' }, { rule: 'prompt', enforced: false }, granted.deps)
    assert.equal(granted.prompts.length, 0)
  })

  it('saves "Always allow" on Nest for a tool Nest does not enforce', async () => {
    const r = recorder({ server: [ok()], answer: 'always' })
    await callWithApproval('write_file', {}, { rule: 'prompt', enforced: false }, r.deps)
    await flush()
    assert.deepEqual(r.grantsAdded, ['write_file'])
  })

  it('a deny never reaches tools/call, and is logged for an enforced tool', async () => {
    const r = recorder({ server: [], answer: 'deny' })
    const out = await callWithApproval('delete_file', {}, { rule: 'always', enforced: true }, r.deps)
    await flush()
    assert.equal(out.text, DENIED_RESULT)
    assert.equal(r.calls.length, 0)
    assert.deepEqual(r.denied, ['delete_file'])
  })

  it('completes the handshake for a destructive call the person approved', async () => {
    const r = recorder({
      server: [refused(), (meta) => (meta?.[APPROVAL_ID_META_KEY] === 'ap-1' ? ok('Deleted') : refused())],
    })
    const out = await callWithApproval('delete_file', { path: 'notes.md' }, { rule: 'always', enforced: true }, r.deps)
    assert.equal(out.text, 'Deleted')
    assert.equal(r.prompts.length, 1, 'asked once, before the call — not again on the refusal')
    assert.equal(r.prompts[0]?.canAlwaysAllow, false, 'a destructive tool is never always-allowed')
    assert.deepEqual(r.decided, [['ap-1', 'once']])
    assert.deepEqual(r.calls, [undefined, { [APPROVAL_ID_META_KEY]: 'ap-1' }])
  })

  it('asks with Nest\'s summary when Nest refuses a tool its listing called none', async () => {
    const r = recorder({ server: [refused(), ok('Deleted')] })
    const out = await callWithApproval('delete_file', {}, { rule: 'none', enforced: false }, r.deps)
    assert.equal(out.text, 'Deleted')
    assert.equal(r.prompts.length, 1)
    assert.equal(r.prompts[0]?.summary, 'Delete notes.md')
  })

  it('a deny on that late prompt is posted as a deny and nothing is repeated', async () => {
    const r = recorder({ server: [refused()], answer: 'deny' })
    const out = await callWithApproval('delete_file', {}, { rule: 'none', enforced: false }, r.deps)
    assert.equal(out.text, DENIED_RESULT)
    assert.deepEqual(r.decided, [['ap-1', 'deny']])
    assert.equal(r.calls.length, 1)
  })

  it('a refusal for a call that passed on a standing grant is answered with the prompt, not on the person\'s behalf', async () => {
    // A 'prompt' tool Nest enforces, with a grant the client still has cached
    // but Nest has since revoked. Nest refuses; the client must ask, not post.
    const r = recorder({ server: [refused(), ok('Written')], grants: ['write_file'], answer: 'once' })
    const out = await callWithApproval('write_file', {}, { rule: 'prompt', enforced: true }, r.deps)
    assert.equal(r.prompts.length, 1)
    assert.deepEqual(r.decided, [['ap-1', 'once']])
    assert.equal(out.text, 'Written')
  })

  it('tells the model nothing ran when the decision cannot be posted', async () => {
    const r = recorder({ server: [refused()], decideFails: true })
    const out = await callWithApproval('delete_file', {}, { rule: 'always', enforced: true }, r.deps)
    assert.equal(out.text, APPROVAL_NEEDED_TEXT)
    assert.equal(r.calls.length, 1)
  })

  it('does not loop when Nest refuses the repeated call too', async () => {
    const r = recorder({ server: [refused(), refused()] })
    const out = await callWithApproval('delete_file', {}, { rule: 'always', enforced: true }, r.deps)
    assert.equal(out.text, APPROVAL_NEEDED_TEXT)
    assert.equal(r.calls.length, 2)
  })
})
