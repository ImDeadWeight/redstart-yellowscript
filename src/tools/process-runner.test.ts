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

import { BackgroundProcesses, capHeadTail, describeRunning, detectServerUrl, formatCommandRun, runCommandLine, runFailed, startInBackground } from './process-runner.ts'
import { createProcessTool, legacyProcessCall } from './process-tools.ts'
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

describe('BackgroundProcesses and the process tools', () => {
  it('starts, reads only what is new, and stops', async () => {
    const processes = new BackgroundProcesses()
    const started = processes.start(nodeLine("console.log('ready'); setInterval(() => console.log('tick'), 200)"), cwd)
    try {
      const first = await processes.output(started.id, { waitMs: 5_000 })
      assert.match(first!.text, /ready/)
      assert.equal(first!.process.running, true)

      const tool = createProcessTool(processes)
      const later = await tool.execute({ action: 'output', id: started.id, wait_s: 2 }, { workspaceRoots: [cwd] })
      assert.match(later.content, /is running/)
      const newOutput = later.content.split('--- output ---')[1] ?? ''
      assert.match(newOutput, /tick/)
      assert.doesNotMatch(newOutput, /ready/, 'only output since the last read')

      const stop = await tool.execute({ action: 'stop', id: started.id }, { workspaceRoots: [cwd] })
      assert.match(stop.content, /Stopping p1/)
      for (let i = 0; i < 50 && processes.list()[0]!.running; i++) await new Promise((r) => setTimeout(r, 100))
      assert.equal(processes.list()[0]!.running, false)
    } finally {
      processes.stopAll()
    }
  })

  it('an unknown id names the known ones', async () => {
    const processes = new BackgroundProcesses()
    const result = await createProcessTool(processes).execute({ action: 'output', id: 'p9' }, { workspaceRoots: [cwd] })
    assert.equal(result.isError, true)
    assert.match(result.content, /None has been started/)
  })

  it('start only plans: a background PendingCommand, nothing spawned', async () => {
    const processes = new BackgroundProcesses()
    const result = await createProcessTool(processes).execute({ action: 'start', command: 'npm run dev' }, { workspaceRoots: [cwd] })
    assert.equal(result.pendingCommand?.background, true)
    assert.equal(result.pendingCommand?.command, 'npm run dev')
    assert.equal(processes.list().length, 0)
  })

  it('a missing or unknown action names the three', async () => {
    const result = await createProcessTool(new BackgroundProcesses()).execute({ id: 'p1' }, { workspaceRoots: [cwd] })
    assert.equal(result.isError, true)
    assert.match(result.content, /"start", "output", "stop"/)
  })

  it('maps the three old tools onto an action', () => {
    assert.deepEqual(legacyProcessCall('ys_process_start', { command: 'npm run dev' }), { name: 'ys_process', args: { command: 'npm run dev', action: 'start' } })
    assert.deepEqual(legacyProcessCall('ys_process_output', { id: 'p1' }), { name: 'ys_process', args: { id: 'p1', action: 'output' } })
    assert.deepEqual(legacyProcessCall('ws_process_stop', { id: 'p1' }), { name: 'ys_process', args: { id: 'p1', action: 'stop' } })
    assert.equal(legacyProcessCall('ys_process', {}), null)
    assert.equal(legacyProcessCall('ys_read_file', {}), null)
  })
})

describe('dev-server address detection', () => {
  // The banners as these servers print them, colour codes included.
  const banners: [string, string, string][] = [
    ['Vite', '\n  \u001b[32m\u001b[1mVITE\u001b[22m v5.4.0\u001b[39m  \u001b[2mready in \u001b[0m\u001b[1m312\u001b[22m\u001b[2m\u001b[0m ms\u001b[22m\n\n  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m\n  \u001b[32m➜\u001b[39m  \u001b[1mNetwork\u001b[22m\u001b[2m: use \u001b[22m\u001b[1m--host\u001b[22m\u001b[2m to expose\u001b[22m\n', 'http://localhost:5173/'],
    ['Next', '  ▲ Next.js 14.2.3\n  - Local:        http://localhost:3000\n  - Environments: .env\n\n ✓ Starting...\n ✓ Ready in 1830ms\n', 'http://localhost:3000'],
    ['http-server', 'Starting up http-server, serving ./\n\nhttp-server version: 14.1.1\n\nAvailable on:\n  http://127.0.0.1:8080\n  http://192.168.1.20:8080\nHit CTRL-C to stop the server\n', 'http://127.0.0.1:8080'],
    ['python -m http.server', 'Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...\n', 'http://localhost:8000/'],
    ['python -m http.server, IPv6', 'Serving HTTP on :: port 8000 (http://[::]:8000/) ...\n', 'http://localhost:8000/'],
  ]
  for (const [name, banner, url] of banners) {
    it(`finds ${name}'s address`, () => assert.equal(detectServerUrl(banner), url))
  }

  it('ignores addresses on other machines, and text with none', () => {
    assert.equal(detectServerUrl('Available on http://192.168.1.20:8080'), null)
    assert.equal(detectServerUrl('compiled successfully'), null)
  })

  it('a start waits for the address and says it is serving', async () => {
    const processes = new BackgroundProcesses()
    try {
      const code = "setTimeout(() => console.log('Local: http://localhost:4321/'), 300); setInterval(() => {}, 1000)"
      const started = await startInBackground(processes, nodeLine(code), cwd, 5_000)
      assert.equal(started.url, 'http://localhost:4321/')
      assert.match(started.text, /^p1 is serving http:\/\/localhost:4321\//)
      assert.equal(started.isError, false)
      assert.equal(processes.list()[0]!.url, 'http://localhost:4321/')
      assert.match(describeRunning(processes.list(), processes.list()[0]!.startedAt + 12 * 60_000)!, /^Running now: p1 ".*" → http:\/\/localhost:4321\/ \(started 12 min ago\)$/)
    } finally {
      processes.stopAll()
    }
  })

  it('a start that exits says so, with its code and output', async () => {
    const processes = new BackgroundProcesses()
    const started = await startInBackground(processes, nodeLine("console.error('port in use'); process.exit(1)"), cwd, 5_000)
    assert.match(started.text, /^p1 exited with code 1/)
    assert.match(started.text, /port in use/)
    assert.equal(started.isError, true)
    assert.equal(started.exitCode, 1)
    assert.equal(describeRunning(processes.list()), null, 'a process that died is not listed as running')
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
