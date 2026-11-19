// =============================================================================
// Tests for the context budget: what is trimmed, in what order, and what never is.
// =============================================================================

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  ContextTracker,
  DEFAULT_OVERHEAD_TOKENS,
  KEEP_RATIO,
  PROTECTED_TAIL,
  fitMessages,
  resultStub,
  shrinkArguments,
  totalTokens,
  type BudgetLimits,
  type BudgetMessage,
} from './context-budget.ts'

/** A run: the user's request, then `reads` rounds of a call and its big result. */
function run(reads: number, resultChars = 9_000): BudgetMessage[] {
  const messages: BudgetMessage[] = [{ role: 'user', content: 'build the game' }]
  for (let i = 0; i < reads; i++) {
    const id = `call_${i}`
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id, type: 'function', function: { name: 'ys_read_file', arguments: `{"path":"src/f${i}.ts"}` } }],
    })
    messages.push({ role: 'tool', tool_call_id: id, content: `file ${i} `.padEnd(resultChars, 'x') })
  }
  return messages
}

/** ~32k window, a small overhead, the usual reply headroom. */
const limits: BudgetLimits = { nCtx: 32_768, replyTokens: 4_096, overheadTokens: 3_000 }
const usable = 32_768 - 4_096 - 3_000

describe('fitMessages', () => {
  test('leaves a run that fits untouched', () => {
    const messages = run(2)
    const before = structuredClone(messages)
    const report = fitMessages(messages, limits)
    assert.deepEqual(messages, before)
    assert.equal(report.stubbed, 0)
    assert.equal(report.overLimit, false)
  })

  test('stubs the oldest results first, down to the keep ratio', () => {
    const messages = run(12) // ~36k tokens of results: over the window
    const report = fitMessages(messages, limits)

    assert.ok(report.stubbed > 0)
    assert.ok(report.after <= usable * KEEP_RATIO, `after ${report.after} > ${usable * KEEP_RATIO}`)
    assert.equal(report.overLimit, false)
    // Oldest first: the first result is a stub, and the stubs are contiguous.
    const results = messages.filter((m) => m.role === 'tool').map((m) => String(m.content))
    assert.match(results[0]!, /^\[Earlier result of ys_read_file \(9,000 characters\) removed/)
    const firstKept = results.findIndex((r) => !r.startsWith('[Earlier result'))
    assert.ok(results.slice(firstKept).every((r) => !r.startsWith('[Earlier result')))
  })

  test('never touches the user or the newest messages', () => {
    const messages = run(30)
    const tail = structuredClone(messages.slice(-PROTECTED_TAIL))
    fitMessages(messages, limits, true)
    assert.equal(messages[0]!.content, 'build the game')
    // The newest results may still be capped as oversized, never stubbed.
    for (const [i, m] of messages.slice(-PROTECTED_TAIL).entries()) {
      assert.ok(!String(m.content).startsWith('[Earlier result'), `tail message ${i} was stubbed`)
      assert.equal(m.role, tail[i]!.role)
    }
  })

  test('a second pass is stable: stubs are not re-stubbed, the prefix does not move', () => {
    const messages = run(12)
    fitMessages(messages, limits)
    const once = structuredClone(messages)
    const again = fitMessages(messages, limits)
    assert.equal(again.stubbed, 0)
    assert.deepEqual(messages, once)
  })

  test('force trims even when the estimate says it fits', () => {
    const messages = run(4)
    assert.ok(totalTokens(messages) < usable * 0.85)
    const report = fitMessages(messages, limits, true)
    assert.ok(report.stubbed > 0)
  })

  test('shrinks old write calls but replaces the call objects instead of editing them', () => {
    const file = 'const a = 1\n'.repeat(3_000)
    const call = { id: 'w', type: 'function', function: { name: 'ys_write_file', arguments: JSON.stringify({ path: 'a.ts', content: file }) } }
    const messages: BudgetMessage[] = [
      { role: 'user', content: 'write it' },
      { role: 'assistant', content: '', tool_calls: [call] },
      { role: 'tool', tool_call_id: 'w', content: 'ok' },
      ...run(10).slice(1),
    ]
    const original = call.function.arguments
    fitMessages(messages, limits, true)

    assert.equal(call.function.arguments, original, 'the run record must keep what the model sent')
    const sent = messages[1]!.tool_calls![0]!.function.arguments
    assert.deepEqual(JSON.parse(sent).path, 'a.ts')
    assert.match(JSON.parse(sent).content, /characters removed to fit the context window/)
  })

  test('caps one message that alone is too big', () => {
    const messages: BudgetMessage[] = [
      { role: 'user', content: 'read the bundle' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'b', function: { name: 'ys_read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'b', content: 'x'.repeat(80_000) },
    ]
    const report = fitMessages(messages, limits)
    assert.equal(report.capped, 1)
    assert.match(String(messages[2]!.content), /middle removed/)
    assert.equal(report.overLimit, false)
  })
})

describe('shrinkArguments', () => {
  test('keeps short arguments and non-JSON as they are', () => {
    assert.equal(shrinkArguments('{"path":"a.ts"}'), '{"path":"a.ts"}')
    const notJson = '<parameter=code>' + 'x'.repeat(500)
    assert.equal(shrinkArguments(notJson), notJson)
  })

  test('elides long strings, nested too, and stays valid JSON', () => {
    const args = JSON.stringify({ path: 'a.ts', edits: [{ old: 'y'.repeat(400), new: 'short' }] })
    const parsed = JSON.parse(shrinkArguments(args))
    assert.equal(parsed.path, 'a.ts')
    assert.equal(parsed.edits[0].new, 'short')
    assert.match(parsed.edits[0].old, /^\[400 characters removed/)
  })
})

describe('resultStub', () => {
  test('names the tool and says it can be called again', () => {
    assert.match(resultStub('ys_grep', 12_345), /ys_grep \(12,345 characters\).*Call the tool again/)
  })
})

describe('ContextTracker', () => {
  test('reads n_ctx once, and has no limits until it knows it', async () => {
    let calls = 0
    const tracker = new ContextTracker({ props: async () => (calls++, { nCtx: 16_384 }) })
    assert.equal(tracker.limits(), null)
    await Promise.all([tracker.ready(), tracker.ready()])
    await tracker.ready()
    assert.equal(calls, 1)
    assert.equal(tracker.limits()?.nCtx, 16_384)
    assert.equal(tracker.limits()?.overheadTokens, DEFAULT_OVERHEAD_TOKENS)
  })

  test('an unreadable /props is not an error: it waits for the server to say', async () => {
    const tracker = new ContextTracker({ props: async () => { throw new Error('404') } })
    await tracker.ready()
    assert.equal(tracker.limits(), null)
    tracker.recordExceeded(8_192, 9_000, 5_000)
    assert.equal(tracker.limits()?.nCtx, 8_192)
    assert.equal(tracker.overheadTokens, 4_000)
  })

  test('learns the overhead from the prompt the server processed', async () => {
    const tracker = new ContextTracker({ props: async () => ({ nCtx: 32_768 }) })
    await tracker.ready()
    tracker.recordPrompt(7_500, 2_000)
    assert.equal(tracker.overheadTokens, 5_500)
    // Reply headroom: a whole file, but never most of a small window.
    assert.equal(tracker.limits()?.replyTokens, 4_096)
  })
})
