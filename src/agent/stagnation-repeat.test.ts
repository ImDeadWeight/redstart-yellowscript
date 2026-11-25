// =============================================================================
// The exact-repeat guard and the failure signature, against what the steered
// Crestline run (2026-11-24) tripped on: `npm run check` after a fix refused
// as a repeat, and three different Svelte errors read as one.
// =============================================================================

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createStagnationMonitor, errorSignature } from './agent-core.ts'
import { callInfo } from './loop.ts'

const check = callInfo('ys_run_command', JSON.stringify({ command: 'npm run check', cwd: 'Crestline' }))
const edit = callInfo('ys_replace', JSON.stringify({ path: 'Crestline/src/routes/+page.svelte', old_string: 'a', new_string: 'b' }))

describe('the exact-repeat guard', () => {
  test('a check run again after an applied write is not a repeat', () => {
    const monitor = createStagnationMonitor()
    for (let i = 0; i < 6; i++) {
      assert.equal(monitor.check(check), null, `check ${i + 1}`)
      monitor.record(check, { ok: false, text: `Error: problem number ${i}` })
      monitor.check(edit)
      monitor.record(edit, { ok: true, writes: [{ path: 'p', before: `v${i}`, after: `v${i + 1}` }] })
      monitor.endRound()
    }
  })

  test('with nothing written in between, the fourth is refused', () => {
    const monitor = createStagnationMonitor()
    const results = [1, 2, 3, 4].map(() => {
      const refused = monitor.check(check)
      monitor.record(check, refused ? { ok: false, refused: refused.reason } : { ok: false, text: 'Error: x' })
      return refused?.reason ?? null
    })
    assert.deepEqual(results, [null, null, null, 'repeated'])
  })

  test('the same write over and over is still a repeat', () => {
    const monitor = createStagnationMonitor()
    const results = [1, 2, 3, 4].map(() => {
      const refused = monitor.check(edit)
      if (!refused) monitor.record(edit, { ok: true, writes: [{ path: 'p', after: 'b' }] })
      return refused?.reason ?? null
    })
    assert.equal(results.at(-1), 'repeated')
  })
})

describe('a build tool\'s summary line is not the error', () => {
  const vite = (detail: string) =>
    `--- stderr ---\n✗ Build failed in 65ms\nerror during build:\nBuild failed with 1 error:\n\n[plugin vite-plugin-svelte:compile] src/routes/+page.svelte:24:3\n${detail}`
  test('three different Svelte errors have three signatures', () => {
    const sigs = new Set(
      [
        'RolldownError: src/routes/+page.svelte:24:3 Unexpected token',
        'RolldownError: src/routes/+page.svelte:136:42 Mixing old (on:click) and new syntaxes for event handling is not allowed',
        'SvelteKit error: module_removed_lib',
      ].map((d) => errorSignature(vite(d))),
    )
    assert.equal(sigs.size, 3)
    assert.ok(![...sigs].some((s) => s.includes('build failed in')), [...sigs].join(' | '))
  })
  test('the summary is still quoted when it is all there is', () => {
    assert.match(errorSignature('✗ Build failed in 65ms'), /build failed in/)
  })
})
