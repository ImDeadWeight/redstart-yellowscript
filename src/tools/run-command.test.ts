// =============================================================================
// Tests for the Phase 4.1 ys_run_command tool.
// =============================================================================
// The tool must NEVER run a process — it only plans a command and returns it as a
// `pendingCommand` for the always-ask gate. These tests prove that, plus that the
// cwd is resolved and contained inside the workspace. They use a REAL temp dir so
// the workspace guard resolves real paths (like the read-file tests do).

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { isNoOpCommand, runCommandTool } from './run-command.ts'

let work: string
let ctx: { workspaceRoots: string[] }

before(() => {
  work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-run-')))
  fs.mkdirSync(path.join(work, 'src'))
  ctx = { workspaceRoots: [work] }
})

after(() => {
  fs.rmSync(work, { recursive: true, force: true })
})

describe('ys_run_command', () => {
  it('returns a pending command, never spawns a process', async () => {
    const result = await runCommandTool.execute({ command: 'npm test' }, ctx)
    assert.equal(result.isError, false)
    assert.ok(result.pendingCommand, 'expected a pendingCommand')
    assert.equal(result.pendingCommand!.command, 'npm test')
    assert.equal(result.pendingCommand!.cwd, work)
  })

  it('resolves a relative cwd inside the workspace', async () => {
    const result = await runCommandTool.execute({ command: 'git status', cwd: 'src' }, ctx)
    assert.equal(result.isError, false)
    assert.equal(result.pendingCommand!.cwd, path.join(work, 'src'))
  })

  it('refuses a cwd outside the workspace', async () => {
    const result = await runCommandTool.execute({ command: 'ls', cwd: '../../etc' }, ctx)
    assert.equal(result.isError, true)
    assert.equal(result.pendingCommand, undefined)
  })

  it('refuses an empty command', async () => {
    const result = await runCommandTool.execute({ command: '   ' }, ctx)
    assert.equal(result.isError, true)
    assert.equal(result.pendingCommand, undefined)
  })

  it('refuses when no workspace is open', async () => {
    const result = await runCommandTool.execute({ command: 'ls' }, { workspaceRoots: [] })
    assert.equal(result.isError, true)
    assert.equal(result.pendingCommand, undefined)
  })

  it('declares the ys_ prefix', () => {
    assert.equal(runCommandTool.definition.name, 'ys_run_command')
  })
})

describe('ys_run_command refuses commands that do nothing (2026-11-19)', () => {
  it('refuses the no-ops a stuck model ran, and says what to do instead', async () => {
    for (const line of ['echo "placeholder"', 'echo hi', 'echo break7', 'exit', 'exit 0', 'true', 'printf done', 'Write-Host bye']) {
      const result = await runCommandTool.execute({ command: line }, ctx)
      assert.equal(result.isError, true, line)
      assert.equal(result.pendingCommand, undefined, `${line} must not reach the approval prompt`)
      assert.match(result.content, /reply to the user without calling a tool.*ask_user/s)
    }
  })

  it('still runs commands that do something', () => {
    for (const line of ['echo $PATH', 'echo %PATH%', 'echo hi > out.txt', 'echo a | sort', 'npm test', 'echoserver --port 1', 'git status']) {
      assert.equal(isNoOpCommand(line), false, line)
    }
  })
})

describe('a package manager that would leave the workspace (2026-11-24)', () => {
  // outer/ has a package.json; the workspace outer/ws has none at its root,
  // and one project folder, outer/ws/app.
  let outer: string
  let ws: string
  let wsCtx: { workspaceRoots: string[] }
  before(() => {
    outer = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-escape-')))
    fs.writeFileSync(path.join(outer, 'package.json'), '{"scripts":{"build":"esbuild"}}')
    ws = path.join(outer, 'ws')
    fs.mkdirSync(path.join(ws, 'app'), { recursive: true })
    fs.mkdirSync(path.join(ws, 'empty'))
    fs.writeFileSync(path.join(ws, 'app', 'package.json'), '{}')
    wsCtx = { workspaceRoots: [ws] }
  })
  after(() => fs.rmSync(outer, { recursive: true, force: true }))

  it('refuses npm run build where the nearest package.json is outside, and names the project', async () => {
    const result = await runCommandTool.execute({ command: 'npm run build 2>&1' }, wsCtx)
    assert.equal(result.isError, true)
    assert.equal(result.pendingCommand, undefined)
    assert.match(result.content, /outside the workspace/)
    assert.match(result.content, /"app"/)
  })

  it('refuses npm install in a folder with no package.json of its own', async () => {
    const result = await runCommandTool.execute({ command: 'npm install', cwd: 'empty' }, wsCtx)
    assert.equal(result.isError, true)
  })

  it('plans it in the project folder, by cwd or by a leading cd', async () => {
    for (const args of [{ command: 'npm run build', cwd: 'app' }, { command: 'cd app && npm test' }]) {
      const result = await runCommandTool.execute(args, wsCtx)
      assert.equal(result.isError, false, JSON.stringify(args))
      assert.ok(result.pendingCommand)
    }
  })

  it('leaves npx, create and init alone: a new folder has no package.json yet', async () => {
    for (const command of ['npx sv create . --template minimal', 'npm create vite@latest app', 'npm init -y', 'npm --version', 'git status']) {
      const result = await runCommandTool.execute({ command, cwd: 'empty' }, wsCtx)
      assert.equal(result.isError, false, command)
    }
  })
})
