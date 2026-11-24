// =============================================================================
// Tests for one-shot runs of approved commands. Real processes, started with
// `node -e` so they run the same on every platform.
// =============================================================================

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, describe, it } from 'node:test'

import { capHeadTail, formatCommandRun, runCommandLine, runFailed } from './command-run.ts'


const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-proc-')))
after(() => fs.rmSync(cwd, { recursive: true, force: true }))

/** A shell line that runs `code` in node (quoted for the platform's shell). */
const nodeLine = (code: string) => `node -e "${code.replace(/"/g, '\\"')}"`


describe('runCommandLine', () => {
  it('puts the exit code first and keeps both streams', async () => {
    const run = await runCommandLine({ command: nodeLine("console.log('out'); console.error('err'); process.exit(3)"), cwd })
    assert.equal(run.exitCode, 3)
    assert.equal(runFailed(run), true)
    const text = formatCommandRun(run)
    assert.match(text.split('\n')[0]!, /^Exit code 3 · \d+\.\ds$/)
    assert.match(text, /--- stdout ---\nout/)
    assert.match(text, /--- stderr ---\nerr/)
  })

  it('a clean exit is not a failure', async () => {
    const run = await runCommandLine({ command: nodeLine("console.log('ok')"), cwd })
    assert.equal(run.exitCode, 0)
    assert.equal(runFailed(run), false)
  })

  it('stops a command at its timeout and says to use a background process', async () => {
    const run = await runCommandLine({ command: nodeLine('setInterval(() => {}, 1000)'), cwd, timeoutMs: 1_000 })
    assert.equal(run.timedOut, true)
    assert.equal(runFailed(run), true)
    assert.match(formatCommandRun(run), /Timed out after .* use ys_process \(action "start"\)/)
  })

  it('streams output as it arrives', async () => {
    const chunks: string[] = []
    await runCommandLine({ command: nodeLine("console.log('live')"), cwd, onOutput: (c) => chunks.push(c) })
    assert.match(chunks.join(''), /live/)
  })
})

describe('capHeadTail', () => {
  it('keeps the start and the end of a long output', () => {
    const text = 'A'.repeat(5_000) + 'MIDDLE' + 'Z'.repeat(5_000)
    const capped = capHeadTail(text, 1_000)
    assert.ok(capped.startsWith('A'.repeat(500)))
    assert.ok(capped.endsWith('Z'.repeat(500)))
    assert.match(capped, /9,006 characters omitted/)
  })
})

describe('a command that ended on a prompt', () => {
  it('says that the person cannot answer it either (Crestline: the model asked them to, 2026-11-24)', () => {
    const base = { exitCode: 0, signal: null, stdout: 'Do you wish to continue?', stderr: '', durationMs: 700, timedOut: false }
    for (const run of [{ ...base, endedAtPrompt: 'Do you wish to continue?' }, { ...base, exitCode: null, waitingForInput: 'Do you wish to continue?' }]) {
      assert.match(formatCommandRun(run), /The person cannot answer it either: ask_user does not reach a running program\./)
    }
  })
})
