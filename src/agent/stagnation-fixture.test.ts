// =============================================================================
// The Crestline transcript against the stagnation checks (agent-runtime plan
// item 3, "Thresholds from the fixture").
// =============================================================================
// bench/fixtures/crestline-ornith.json.gz is the hand-run Crestline chat with
// Ornith 1.5 (2026-11-23): both assistant turns, stopped by hand. Turn 1
// theorised and retried `npx sv add vitest` with new flags; turn 2 looped
// inside one response, the same few sentences about 59 times. Tool outputs
// were not stored, so a command's failure text is its run-log last line.
// =============================================================================

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { gunzipSync } from 'node:zlib'

import { createStagnationMonitor, type Recovery } from './agent-core.ts'
import { callInfo } from './loop.ts'

interface FixtureTool {
  name: string
  arguments: string
  status: 'done' | 'error'
  summary: string
  lastLine?: string
}
interface Fixture {
  turns: { prompt: string; reasoning: string; content: string; tools: FixtureTool[] }[]
}

const fixture = JSON.parse(
  gunzipSync(readFileSync(new URL('../../bench/fixtures/crestline-ornith.json.gz', import.meta.url))).toString('utf8'),
) as Fixture

/** Stream a turn's reasoning in small chunks; the first reasoning-loop firing and where. */
function streamReasoning(text: string): { recovery: Recovery | null; at: number } {
  const monitor = createStagnationMonitor()
  monitor.startResponse()
  for (let i = 0; i < text.length; i += 40) {
    const recovery = monitor.reasoning(text.slice(i, i + 40))
    if (recovery?.detector === 'reasoning-loop') return { recovery, at: i }
  }
  return { recovery: null, at: -1 }
}

/** Replay a turn's calls, one per round; each firing and the call it followed. */
function replayCalls(tools: FixtureTool[]): { index: number; recovery: Recovery }[] {
  const monitor = createStagnationMonitor()
  const fired: { index: number; recovery: Recovery }[] = []
  tools.forEach((tool, index) => {
    const info = callInfo(tool.name, tool.arguments)
    const refused = monitor.check(info)
    const ok = !refused && tool.status === 'done'
    let path: string | undefined
    try {
      path = (JSON.parse(tool.arguments) as { path?: string }).path
    } catch {
      path = undefined
    }
    monitor.record(info, {
      ok,
      ...(refused ? { refused: refused.reason } : {}),
      text: refused?.refuse ?? tool.lastLine ?? tool.summary,
      ...(ok && info.kind === 'read' && path ? { reads: [path] } : {}),
      ...(ok && info.kind === 'write' ? { writes: [{ path: path ?? '?', after: tool.arguments }] } : {}),
    })
    const recovery = monitor.endRound()
    if (recovery) fired.push({ index, recovery })
  })
  return fired
}

describe('the Crestline transcript', () => {
  test('the fixture is the two turns the plan describes', () => {
    assert.equal(fixture.turns.length, 2)
    assert.equal(fixture.turns[0]!.tools.length, 57)
    assert.equal(fixture.turns[1]!.tools.length, 25)
    assert.match(fixture.turns[1]!.prompt, /Stop theorizing/)
  })

  test('turn 2: the reasoning loop fires well before its 59th cycle', () => {
    const turn = fixture.turns[1]!.reasoning
    const cycle = 'The JSON output failed due to Windows path issues'
    assert.equal(turn.split(cycle).length - 1, 59, 'the loop, as recorded')
    const { recovery, at } = streamReasoning(turn)
    assert.ok(recovery, 'never fired')
    const cyclesBefore = turn.slice(0, at).split(cycle).length - 1
    assert.ok(cyclesBefore <= 10, `fired after ${cyclesBefore} cycles`)
  })

  test('turn 1: 2.5% repeated sentences does not read as a reasoning loop', () => {
    assert.equal(streamReasoning(fixture.turns[0]!.reasoning).recovery, null)
  })

  test('turn 1: the same failure fires on the 3rd failed `npx sv add`', () => {
    const tools = fixture.turns[0]!.tools
    const failedSvAdd = tools
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.status === 'error' && /npx sv add/.test(t.arguments))
      .map(({ i }) => i)
    const first = replayCalls(tools)[0]
    assert.ok(first, 'nothing fired')
    assert.equal(first.recovery.detector, 'same-failure')
    assert.equal(first.index, failedSvAdd[2], `fired after call ${first.index}; the sv add failures were ${failedSvAdd.join(', ')}`)
  })

  test("turn 1: the search chain at its end (how svelte-check resolves runes) reads as no progress", () => {
    const fired = replayCalls(fixture.turns[0]!.tools)
    const noProgress = fired.find((f) => f.recovery.detector === 'no-progress')
    assert.ok(noProgress, JSON.stringify(fired.map((f) => f.recovery.detector)))
    assert.ok(noProgress.index > 40, `at call ${noProgress.index}`)
  })
})
