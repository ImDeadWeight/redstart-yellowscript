// =============================================================================
// Tests for the "newer than you know" note on package.json reads and installs.
// =============================================================================

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, test } from 'node:test'

import { createVersionNotes } from './version-note.ts'

/** The Crestline scaffold's dependencies (SvelteKit 3, 2026-11-24). */
const CRESTLINE = JSON.stringify({
  imports: { '#lib/*': './src/lib/*' },
  devDependencies: { '@sveltejs/kit': '^3.2.0', svelte: '^5.57.3', typescript: '^6.0.3', vite: '^8.3.8' },
})

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ys-version-note-'))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  return root
}

const WEB = ['ys_read_file', 'ys_run_command', 'web_search', 'web_fetch']
const args = (o: Record<string, unknown>) => JSON.stringify(o)

describe('version note', () => {
  test('reading a package.json newer than the model knows says so, once', () => {
    const root = workspace({ 'Crestline/package.json': CRESTLINE })
    const note = createVersionNotes(WEB, [root])
    const first = note('ys_read_file', args({ path: 'Crestline/package.json' }), true)
    assert.ok(first && /@sveltejs\/kit \^3\.2\.0/.test(first) && /web_search/.test(first), String(first))
    assert.ok(!/svelte \^5/.test(first), 'a version it knows is not named')
    assert.equal(note('ys_read_file', args({ path: 'Crestline/package.json' }), true), null, 'not twice in a run')
  })

  test('an install or scaffold reads the package.json in its cwd', () => {
    const root = workspace({ 'Crestline/package.json': CRESTLINE })
    for (const command of ['npm install', 'npx sv create . --template minimal', 'npx sv add vitest --no-install', 'pnpm add zod']) {
      const note = createVersionNotes(WEB, [root])
      assert.ok(note('ys_run_command', args({ command, cwd: 'Crestline' }), true), command)
    }
  })

  test('other commands, failures, other files and runs without a web tool say nothing', () => {
    const root = workspace({ 'Crestline/package.json': CRESTLINE, 'package.json': CRESTLINE })
    const note = createVersionNotes(WEB, [root])
    assert.equal(note('ys_run_command', args({ command: 'npm run build', cwd: 'Crestline' }), true), null, 'a build')
    assert.equal(note('ys_run_command', args({ command: 'git diff -i', cwd: 'Crestline' }), true), null, 'a bare -i')
    assert.equal(note('ys_run_command', args({ command: 'npm install', cwd: 'Crestline' }), false), null, 'a failed install')
    assert.equal(note('ys_read_file', args({ path: 'Crestline/tsconfig.json' }), true), null, 'not a manifest')
    assert.equal(note('ys_read_file', args({ path: '../outside/package.json' }), true), null, 'outside the workspace')
    const noWeb = createVersionNotes(['ys_read_file'], [root])
    assert.equal(noWeb('ys_read_file', args({ path: 'package.json' }), true), null, 'no web tool')
  })

  test('a project on versions the model knows gets no note', () => {
    const root = workspace({ 'package.json': JSON.stringify({ dependencies: { svelte: '^5.0.0', vite: '^6.0.0' } }) })
    assert.equal(createVersionNotes(WEB, [root])('ys_read_file', args({ path: 'package.json' }), true), null)
  })
})
