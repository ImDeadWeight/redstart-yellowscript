// Shared helpers for the bench's check.mjs scripts.
//
// A check is run as `node check.mjs <workspace> <result.json>` and passes by
// exiting 0. What it prints is the reason, shown in the summary. The result
// file holds { answer, plan, stopReason, questions, calls: [{ name, args, isError }] }.

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

export const [, , workspace, resultFile] = process.argv
if (!workspace || !resultFile) {
  console.error('usage: node check.mjs <workspace> <result.json>')
  process.exit(2)
}

export const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))

export function pass(message = 'passed') {
  console.log(message)
  process.exit(0)
}

export function fail(message) {
  console.log(`FAIL: ${message}`)
  process.exit(1)
}

export function expect(condition, message) {
  if (!condition) fail(message)
}

export const file = (rel) => path.join(workspace, rel)
export const exists = (rel) => fs.existsSync(file(rel))
export const read = (rel) => fs.readFileSync(file(rel), 'utf8')

/** Run a program in the workspace; returns { status, stdout, stderr }. */
export function run(command, args, options = {}) {
  // Under a test runner, NODE_TEST_CONTEXT makes a child `node --test` report to
  // the parent and exit 0 whatever its tests did. A check must see the truth.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(command, args, { cwd: workspace, encoding: 'utf8', timeout: 60_000, windowsHide: true, env, ...options })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** How many calls of `name` the run made. */
export const callsOf = (name) => (result.calls ?? []).filter((c) => c.name === name)

/** A file's content as it is in the task's original workspace. */
export function original(taskDir, rel) {
  return fs.readFileSync(path.join(taskDir, 'workspace', rel), 'utf8')
}

/**
 * Load a page headless (the same code as ys_check_page) and return its events
 * and summary, or null when this machine has no browser.
 */
export async function checkPageHeadless(url) {
  const mod = await import(new URL('../../../src/tools/browser-check.ts', import.meta.url).href)
  const browser = mod.findBrowser()
  if (!browser) return null
  return mod.checkPage({ url, browser, waitMs: 1_500, screenshot: false })
}
