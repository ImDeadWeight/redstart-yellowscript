// =============================================================================
// Tests for the workspace system message: instructions and the file tree.
// =============================================================================

import assert from 'node:assert/strict'
import * as path from 'node:path'
import { describe, test } from 'node:test'

import { MAX_INSTRUCTION_CHARS, buildWorkspaceContext, workspaceTree, type ContextFs } from './workspace-context.ts'

const root = path.resolve('/game')

/** A fake tree: keys are workspace-relative, a trailing "/" makes a directory. */
function tree(entries: Record<string, string | null>): ContextFs {
  const files = new Map<string, string>()
  const dirs = new Map<string, Array<{ name: string; isDirectory: boolean }>>()
  const add = (dir: string, name: string, isDirectory: boolean) => {
    const list = dirs.get(dir) ?? []
    if (!list.some((e) => e.name === name)) list.push({ name, isDirectory })
    dirs.set(dir, list)
  }
  for (const [rel, content] of Object.entries(entries)) {
    const parts = rel.replace(/\/$/, '').split('/')
    let dir = root
    parts.forEach((part, i) => {
      const last = i === parts.length - 1
      const isDir = !last || rel.endsWith('/')
      add(dir, part, isDir)
      dir = path.join(dir, part)
    })
    if (content !== null) files.set(path.join(root, rel), content)
  }
  return { readFile: (p) => files.get(p) ?? null, readDir: (p) => dirs.get(p) ?? null }
}

describe('buildWorkspaceContext', () => {
  test('includes AGENTS.md, and prefers it over CLAUDE.md', () => {
    const text = buildWorkspaceContext(root, tree({ 'AGENTS.md': 'Use tabs.', 'CLAUDE.md': 'Use spaces.', 'index.html': '' }))!
    assert.match(text, /from AGENTS\.md\. Follow them:\n\nUse tabs\./)
    assert.doesNotMatch(text, /Use spaces/)
  })

  test('falls back to CLAUDE.md, and caps a long file', () => {
    const text = buildWorkspaceContext(root, tree({ 'CLAUDE.md': 'x'.repeat(MAX_INSTRUCTION_CHARS + 500) }))!
    assert.match(text, /from CLAUDE\.md/)
    assert.match(text, /the rest of CLAUDE\.md is not shown/)
  })

  test('without instructions it still names the workspace and its files', () => {
    const text = buildWorkspaceContext(root, tree({ 'src/game.ts': '', 'package.json': '' }))!
    assert.match(text, /The workspace is game/)
    assert.match(text, /Files \(top two levels\):\nsrc\/\n {2}game\.ts\npackage\.json/)
  })
})

describe('workspaceTree', () => {
  test('lists directories first, two levels, and skips what search skips', () => {
    const lines = workspaceTree(root, tree({ 'node_modules/x/': null, '.git/HEAD': '', '.yellowscript/PLAN.md': '', 'src/deep/a.ts': '', 'src/b.ts': '', 'README.md': '' }))
    assert.deepEqual(lines, ['src/', '  deep/', '  b.ts', 'README.md'])
  })

  test('caps a large tree and says how to see the rest', () => {
    const entries = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${String(i).padStart(2, '0')}.ts`, '']))
    const lines = workspaceTree(root, tree(entries), 10)
    assert.equal(lines.length, 11)
    assert.match(lines.at(-1)!, /and 20 more \(use ys_list_directory or ys_glob\)/)
  })
})
