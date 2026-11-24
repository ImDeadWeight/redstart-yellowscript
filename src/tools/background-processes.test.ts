// =============================================================================
// Tests for the background registry, the process tools, and the command
// allowlist. Real processes, started with `node -e` so they run the same on
// every platform.
// =============================================================================

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, describe, it } from 'node:test'

import {
  BackgroundProcesses,
  describeKillTargets,
  describeRunning,
  detectServerUrl,
  formatProcessList,
  startInBackground,
} from './background-processes.ts'
import { LABEL_CHAT, LABEL_RUN, formatCommandRun, looksLikePrompt, runCommandLine, runFailed } from './command-run.ts'
import { createProcessTool, legacyProcessCall } from './process-tools.ts'
import { allowPrefixFor, isCommandAllowed } from './approval.ts'


const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-proc-')))
after(() => fs.rmSync(cwd, { recursive: true, force: true }))

/** A shell line that runs `code` in node (quoted for the platform's shell). */
const nodeLine = (code: string) => `node -e "${code.replace(/"/g, '\\"')}"`

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
      assert.match(started.text, /^p1 \(pid \d+\) is serving http:\/\/localhost:4321\//)
      assert.equal(started.isError, false)
      assert.equal(processes.list()[0]!.url, 'http://localhost:4321/')
      assert.match(describeRunning(processes.list(), processes.list()[0]!.startedAt + 12 * 60_000)!, /^Running now: p1 ".*" → http:\/\/localhost:4321\/ \(pid \d+, started 12 min ago\)$/)
    } finally {
      processes.stopAll()
    }
  })

  it('a start that exits says so, with its code and output', async () => {
    const processes = new BackgroundProcesses()
    const started = await startInBackground(processes, nodeLine("console.error('port in use'); process.exit(1)"), cwd, 5_000)
    assert.match(started.text, /^p1 \(pid \d+\) exited with code 1/)
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

describe('processes Yellowscript can name', () => {
  it('recognises a prompt waiting for an answer, and nothing else', () => {
    assert.equal(looksLikePrompt('Overwrite files? (y/N) '), 'Overwrite files? (y/N)')
    assert.equal(looksLikePrompt('┌  Welcome to the Svelte CLI!\n│\n◆  Directory not empty. Continue?\n│  ○ Yes / ● No\n└'), 'Directory not empty. Continue?')
    // What `npx sv create .` really prints in a folder with files in it.
    const sv = '┌  Welcome to the Svelte CLI! (v1.7.0)\n\u001b[?25l│\n◆  Directory not empty:\n│  C:\\tmp\\app\n│  \n│  Continue?\n│  ○ Yes / ● No\n└\n'
    assert.equal(looksLikePrompt(sv), 'Directory not empty: … Continue?')
    // An answered question above is not an open one.
    assert.equal(looksLikePrompt('◇  Which template?\n│  minimal\n│\nScaffolded the project.'), null)
    assert.equal(looksLikePrompt('? Project name › my-app'), 'Project name › my-app')
    assert.equal(looksLikePrompt('Enter password: '), 'Enter password:')
    assert.equal(looksLikePrompt('Press any key to continue . . .'), 'Press any key to continue . . .')
    assert.equal(looksLikePrompt('\u001b[1mbuilding\u001b[22m 412 modules'), null)
    assert.equal(looksLikePrompt('Compiled successfully.\n'), null)
    assert.equal(looksLikePrompt(''), null)
  })

  it('a clack run that finished is not a prompt (Crestline, 2026-11-24: a working `sv add` read as one)', () => {
    const done = '┌  Welcome to the Svelte CLI! (v1.7.1)\n│\n◆  Successfully setup add-ons: vitest\n│\n│  To skip prompts next time, run:\n●  npx sv@1.7.1 add vitest="usages:unit" --no-git-check --no-install\n│\n└  You\'re all set!\n'
    assert.equal(looksLikePrompt(done), null)
    // A ◆ line that asks nothing and offers no choices is a message, even without the outro.
    assert.equal(looksLikePrompt('┌  sv\n│\n◆  Successfully setup add-ons: vitest\n│\n●  npx sv add vitest'), null)
    // The two real questions from the same run are still caught.
    const multi = '┌  Welcome to the Svelte CLI! (v1.7.1)\n\u001b[?25l│\n◆  What do you want to use vitest for?\n│  ◼ unit testing\n│  ◼ component testing\n│  ↑/↓ to navigate • Space: select • Enter: confirm\n└'
    assert.equal(looksLikePrompt(multi), 'What do you want to use vitest for?')
    const verify = '┌  Welcome to the Svelte CLI! (v1.7.1)\n│\n◇  Verifications not met ─────╮\n│  - clean working directory (Uncommitted changes found)  │\n├──────╯\n\u001b[?25l│\n◆  Verifications failed. Do you wish to continue?\n│  ○ Yes / ● No\n└'
    assert.equal(looksLikePrompt(verify), 'Verifications failed. Do you wish to continue?')
  })

  it('stops a command that sits on a prompt, and says what it asked', async () => {
    const run = await runCommandLine({
      command: nodeLine("process.stdout.write('Continue? (y/N) '); setInterval(() => {}, 1000)"),
      cwd,
      inputWaitMs: 400,
      timeoutMs: 20_000,
    })
    assert.equal(run.waitingForInput, 'Continue? (y/N)')
    assert.ok(run.durationMs < 10_000, `took ${run.durationMs}ms`)
    assert.equal(runFailed(run), true)
    assert.match(formatCommandRun(run), /^Stopped after .*waiting for input.*it asked: "Continue\? \(y\/N\)".*--yes/)
  })

  it('a command that exits on an unanswered prompt failed, whatever its exit code', async () => {
    const run = await runCommandLine({
      command: nodeLine("console.log('◆  Directory not empty:'); console.log('│  Continue?'); console.log('│  ○ Yes / ● No'); console.log('└')"),
      cwd,
    })
    assert.equal(run.exitCode, 0)
    assert.equal(run.endedAtPrompt, 'Directory not empty: … Continue?')
    assert.equal(runFailed(run), true)
    assert.match(formatCommandRun(run), /most likely did NOT do the work/)
    const fine = await runCommandLine({ command: nodeLine("console.log('Done in 1.2s')"), cwd })
    assert.equal(fine.endedAtPrompt, undefined)
  })

  it('labels the process and its children, and sets CI only when asked', async () => {
    const show = nodeLine(`console.log(process.env.${LABEL_RUN} + ' ' + process.env.${LABEL_CHAT} + ' ' + (process.env.CI ?? 'none'))`)
    const processes = new BackgroundProcesses()
    const labelled = await processes.run({ command: show, cwd, chat: 'conv_1', nonInteractive: true })
    const expectedCi = process.env.CI ?? '1'
    assert.equal(labelled.stdout.trim(), `c1 conv_1 ${expectedCi}`)
    assert.match(formatCommandRun(labelled).split('\n')[0]!, /^Exit code 0 · \d+\.\ds · c1 \(pid \d+\)$/)
    const plain = await processes.run({ command: show, cwd })
    assert.equal(plain.stdout.trim(), `c2 undefined ${process.env.CI ?? 'none'}`)
  })

  it('lists commands and background processes with pids, and stops a running command by id', async () => {
    const processes = new BackgroundProcesses()
    await processes.run({ command: nodeLine("console.log('done')"), cwd })
    const running = processes.run({ command: nodeLine("console.log('working'); setInterval(() => {}, 1000)"), cwd, inputWaitMs: 0 })
    const started = processes.start(nodeLine('setInterval(() => {}, 1000)'), cwd, 'conv_2')
    try {
      // Wait for the command to start and print.
      for (let i = 0; i < 50 && !processes.records().find((r) => r.id === 'c2')?.lastLine; i++) await new Promise((r) => setTimeout(r, 100))
      const list = formatProcessList(processes.records())
      assert.match(list, /^Started by Yellowscript in this window \(2 running\)/)
      assert.match(list, /c1 {2}pid \d+ {2}command {2}exited 0/)
      assert.match(list, /c2 {2}pid \d+ {2}command {2}running/)
      assert.match(list, /last output: working/)
      assert.match(list, /p1 {2}pid \d+ {2}background {2}running/)
      assert.match(list, /not yours: do not end it/)
      assert.equal(processes.owns(started.pid!)?.id, 'p1')
      assert.equal(processes.owns(999_999_99), null)

      const stopped = processes.stop('c2')
      assert.equal(stopped?.running, true)
      const run = await running
      assert.equal(run.stopped, true)
      assert.match(formatCommandRun(run), /^Stopped after .*, with everything it started\./)
      assert.match(formatProcessList(processes.records()), /c2 {2}pid \d+ {2}command {2}stopped/)
    } finally {
      processes.stopAll()
    }
  })

  it('says which pids a kill line names are Yellowscript\'s', () => {
    const processes = new BackgroundProcesses()
    const started = processes.start(nodeLine('setInterval(() => {}, 1000)'), cwd)
    try {
      const text = describeKillTargets(`taskkill /pid ${started.pid} /pid 4242 /F`, processes)
      assert.match(text, new RegExp(`pid ${started.pid} is Yellowscript's p1`))
      assert.match(text, /pid 4242 was NOT started by Yellowscript/)
      assert.match(text, /running processes: p1 pid \d+/)
    } finally {
      processes.stopAll()
    }
  })

  it('ys_process list and stop work through the tool', async () => {
    const processes = new BackgroundProcesses()
    const tool = createProcessTool(processes)
    const empty = await tool.execute({ action: 'list' }, { workspaceRoots: [cwd], readRoots: [] } as never)
    assert.match(empty.content, /Nothing started yet/)
    const missing = await tool.execute({ action: 'stop', id: 'c9' }, { workspaceRoots: [cwd], readRoots: [] } as never)
    assert.equal(missing.isError, true)
    assert.match(missing.content, /no process "c9" started by Yellowscript/)
  })
})
