import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendPart, splitAnswer, turnBlocks, type TurnPart } from './turn-parts.ts'

/** Feed a stream through appendPart, as both host and webview do. */
function stream(events: TurnPart[]): TurnPart[] {
  return events.reduce<TurnPart[]>((parts, e) => appendPart(parts, e), [])
}
const r = (text: string): TurnPart => ({ kind: 'reasoning', text })
const t = (text: string): TurnPart => ({ kind: 'text', text })
const call = (callId: string): TurnPart => ({ kind: 'tool', callId })

test('chunks of one kind join; a change of kind starts a part', () => {
  assert.deepEqual(stream([r('a'), r('b'), t('c'), t('d'), r('e')]), [r('ab'), t('cd'), r('e')])
})

test('a tool call always starts a part, and text after it is a new part', () => {
  assert.deepEqual(stream([t('x'), call('1'), call('2'), t('y')]), [t('x'), call('1'), call('2'), t('y')])
})

test('a repeated call id is not added twice; empty chunks add nothing', () => {
  assert.deepEqual(stream([call('1'), call('1'), t(''), r('')]), [call('1')])
})

test('appendPart never mutates its input', () => {
  const before = [t('a')]
  const after = appendPart(before, t('b'))
  assert.deepEqual(before, [t('a')])
  assert.deepEqual(after, [t('ab')])
})

test('blocks: consecutive calls group, whitespace-only text is dropped', () => {
  const blocks = turnBlocks(stream([r('think'), t('\n'), call('1'), call('2'), t('  '), r('more'), call('3'), t('done')]))
  assert.deepEqual(blocks.map((b) => b.kind), ['reasoning', 'tools', 'reasoning', 'tools', 'text'])
  assert.deepEqual(blocks[1], { kind: 'tools', callIds: ['1', '2'], key: 'p2' })
})

test('blocks: keys are stable as the stream grows (only the last block changes)', () => {
  const early = turnBlocks(stream([r('a'), call('1'), t('an')]))
  const late = turnBlocks(stream([r('a'), call('1'), t('answer')]))
  assert.deepEqual(early.map((b) => b.key), late.map((b) => b.key))
})

test('split: no tools, nothing folds', () => {
  const blocks = turnBlocks(stream([r('think'), t('hello')]))
  assert.deepEqual(splitAnswer(blocks), { work: [], answer: blocks })
})

test('split: the answer is the text after the last tool run; reasoning before it is work', () => {
  const blocks = turnBlocks(stream([t('let me look'), call('1'), r('ok'), t('Here is the fix.')]))
  const { work, answer } = splitAnswer(blocks)
  assert.deepEqual(work.map((b) => b.kind), ['text', 'tools', 'reasoning'])
  assert.deepEqual(answer.map((b) => b.kind), ['text'])
})

test('split: a turn that ended on a tool (aborted, cap) has no answer; everything is work', () => {
  const blocks = turnBlocks(stream([t('trying'), call('1')]))
  assert.deepEqual(splitAnswer(blocks), { work: blocks, answer: [] })
})

test('split: reasoning after the answer text stays with the answer', () => {
  const blocks = turnBlocks(stream([call('1'), t('done'), r('afterthought')]))
  assert.deepEqual(splitAnswer(blocks).answer.map((b) => b.kind), ['text', 'reasoning'])
})
