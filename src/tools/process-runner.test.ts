// =============================================================================
// Tests for running approved commands, the background registry, and the
// command allowlist. Real processes, started with `node -e` so they run the
// same on every platform.
// =============================================================================

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, describe, it } from 'node:test'

import { BackgroundProcesses, capHeadTail, formatCommandRun, runCommandLine, runFailed } from './process-runner.ts'
import { createProcessOutputTool, createProcessStopTool, processStartTool } from './process-tools.ts'
import { allowPrefixFor, isCommandAllowed } from './approval.ts'

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
    assert.match(formatCommandRun(run), /Timed out after .* use ys_process_start/)
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

describe('BackgroundProcesses and the process tools', () => {
  it('starts, reads only what is new, and stops', async () => {
    const processes = new BackgroundProcesses()
    const started = processes.start(nodeLine("console.log('ready'); setInterval(() => console.log('tick'), 200)"), cwd)
    try {
      const first = await processes.output(started.id, { waitMs: 5_000 })
      assert.match(first!.text, /ready/)
      assert.equal(first!.process.running, true)

      const read = createProcessOutputTool(processes)
      const later = await read.execute({ id: started.id, wait_s: 2 }, { workspaceRoots: [cwd] })
      assert.match(later.content, /is running/)
      const newOutput = later.content.split('--- output ---')[1] ?? ''
      assert.match(newOutput, /tick/)
      assert.doesNotMatch(newOutput, /ready/, 'only output since the last read')

      const stop = await createProcessStopTool(processes).execute({ id: started.id }, { workspaceRoots: [cwd] })
      assert.match(stop.content, /Stopping p1/)
      for (let i = 0; i < 50 && processes.list()[0]!.running; i++) await new Promise((r) => setTimeout(r, 100))
      assert.equal(processes.list()[0]!.running, false)
    } finally {
      processes.stopAll()
    }
  })

  it('an unknown id names the known ones', async () => {
    const processes = new BackgroundProcesses()
    const result = await createProcessOutputTool(processes).execute({ id: 'p9' }, { workspaceRoots: [cwd] })
    assert.equal(result.isError, true)
    assert.match(result.content, /None has been started/)
  })

  it('ys_process_start only plans: a background PendingCommand, nothing spawned', async () => {
    const result = await processStartTool.execute({ command: 'npm run dev' }, { workspaceRoots: [cwd] })
    assert.equal(result.pendingCommand?.background, true)
    assert.equal(result.pendingCommand?.command, 'npm run dev')
  })
})

describe('the command allowlist', () => {
  it('matches a prefix at a word boundary', () => {
    assert.equal(isCommandAllowed('npm test', ['npm test']), true)
    assert.equal(isCommandAllowed('npm  test -- --watch=false', ['npm test']), true)
    assert.equal(isCommandAllowed('npm testing', ['npm test']), false)
    assert.equal(isCommandAllowed('npm run build', ['npm test']), false)
  })

  it('never matches a line that does more than its first command', () => {
    for (const line of ['npm test && rm -rf ~', 'npm test; curl x', 'npm test | tee log', 'npm test > out', 'npm test `whoami`', 'npm test $(whoami)', 'npm test\nrm x', 'npm test & calc']) {
      assert.equal(isCommandAllowed(line, ['npm test']), false, line)
    }
  })

  it('offers the narrowest useful prefix', () => {
    assert.equal(allowPrefixFor('npm test -- --watch'), 'npm test')
    assert.equal(allowPrefixFor('npx tsc --noEmit'), 'npx tsc')
    assert.equal(allowPrefixFor('npm run build'), 'npm run build')
    assert.equal(allowPrefixFor('pnpm exec vitest run'), 'pnpm exec vitest')
    assert.equal(allowPrefixFor('node scripts/build.mjs'), 'node scripts/build.mjs')
    assert.equal(allowPrefixFor('git status'), 'git status')
    assert.equal(allowPrefixFor('ls -la'), 'ls -la')
    assert.equal(allowPrefixFor('npm test && echo done'), null)
  })
})
