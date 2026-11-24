#!/usr/bin/env node
// =============================================================================
// npm run bench:cache — prepare the node_modules a bench task installs from.
// =============================================================================
// A task whose task.json names `nodeModules` (Crestline: a SvelteKit app)
// needs packages, and `npm install` needs the network and resolves whatever
// is newest that day. So its workspace ships a package-lock.json, and this
// installs it ONCE, here, into bench/.cache/<name>/node_modules. Every run
// then gets a copy of that folder (harness.ts copyNodeModules): the same
// packages each time, nothing fetched, and nothing a run installs leaks into
// the next.
//
//   npm run bench:cache                 every task that needs one
//   npm run bench:cache -- crestline    just these
//   npm run bench:cache -- --force      rebuild what is already there
//
// This step uses the network and runs the packages' install scripts (esbuild
// fetches its binary). Run it where that is acceptable, before a bench session.
// =============================================================================

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TASKS = path.join(ROOT, 'bench', 'tasks')
const CACHE = path.join(ROOT, 'bench', '.cache')

const args = process.argv.slice(2)
const force = args.includes('--force')
const wanted = args.filter((a) => !a.startsWith('--'))

const tasks = fs
  .readdirSync(TASKS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(TASKS, d.name, 'task.json')))
  .map((d) => ({ id: d.name, dir: path.join(TASKS, d.name), ...JSON.parse(fs.readFileSync(path.join(TASKS, d.name, 'task.json'), 'utf8')) }))
  .filter((t) => typeof t.nodeModules === 'string')
  .filter((t) => wanted.length === 0 || wanted.includes(t.id) || wanted.includes(t.nodeModules))

if (tasks.length === 0) {
  console.log(wanted.length ? `No task named ${wanted.join(', ')} needs a cache.` : 'No task needs a cache.')
  process.exit(0)
}

let failed = false
for (const task of tasks) {
  const dest = path.join(CACHE, task.nodeModules)
  const lock = path.join(task.dir, 'workspace', 'package-lock.json')
  if (!fs.existsSync(lock)) {
    console.error(`${task.id}: no workspace/package-lock.json, so there is nothing fixed to install`)
    failed = true
    continue
  }
  if (fs.existsSync(path.join(dest, 'node_modules')) && !force) {
    console.log(`${task.id}: ${dest} is ready (--force rebuilds it)`)
    continue
  }
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(task.dir, 'workspace', name), path.join(dest, name))
  console.log(`${task.id}: npm ci in ${dest}`)
  const run = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dest, stdio: 'inherit', shell: process.platform === 'win32' })
  if (run.status !== 0) {
    console.error(`${task.id}: npm ci failed (exit ${run.status})`)
    failed = true
  }
}
process.exit(failed ? 1 : 0)
