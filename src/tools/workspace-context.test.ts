// =============================================================================
// Tests for the workspace system message: instructions and the file tree.
// =============================================================================

import assert from 'node:assert/strict'
import * as path from 'node:path'
import { describe, test } from 'node:test'

import {
  MAX_INSTRUCTION_CHARS,
  buildWorkspaceContext,
  keepingGuide,
  keptFiles,
  shellNote,
  workspaceTree,
  type ContextFs,
} from './workspace-context.ts'

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

  test('says when to look things up only when the run has a web tool', () => {
    const fs = tree({ 'package.json': '' })
    const web = buildWorkspaceContext(root, fs, { tools: ['ys_read_file', 'web_search', 'web_fetch'] })!
    assert.match(web, /may use newer\s+versions/)
    assert.match(web, /with web_search and read the page with web_fetch/)
    assert.doesNotMatch(buildWorkspaceContext(root, fs, { tools: ['ys_read_file'] })!, /web_search/)
    assert.doesNotMatch(buildWorkspaceContext(root, fs)!, /web_search/, 'tools unknown: the ys_ tools only')
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

describe('shellNote', () => {
  test('on Windows it names cmd.exe and the commands to use instead of bash', () => {
    const note = shellNote('win32', { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' })
    assert.match(note, /Windows cmd\.exe, not bash/)
    assert.match(note, /no ls, cat, rm, pwd/)
  })
  test('elsewhere it is /bin/sh', () => {
    assert.match(shellNote('linux', {}), /\/bin\/sh/)
  })
  test('the workspace note includes it', () => {
    assert.match(buildWorkspaceContext(root, tree({ 'a.txt': '' }))!, /Commands \(ys_run_command/)
  })
})

describe('where to keep things', () => {
  const all = ['ys_note', 'ys_write_file', 'update_plan', 'ask_user', 'memory_save', 'ys_read_file']

  test('one line per kind, each naming its tool and its file', () => {
    const guide = keepingGuide({ tools: all, project: 'Crestline' })!
    assert.match(guide, /^Where to keep things\. Each kind has one place/)
    assert.match(guide, /update_plan.*\.yellowscript\/PLAN\.md.*Do not edit PLAN\.md yourself/)
    assert.match(guide, /ask_user/)
    assert.match(guide, /ys_note\. It keeps \.yellowscript\/NOTES\.md/)
    assert.match(guide, /\.yellowscript\/docs\/auth-design\.md, written with ys_write_file/)
    assert.match(guide, /memory_save with scope "project".*"Crestline"|"Crestline".*memory_save with scope "project"/)
    assert.match(guide, /\.yellowscript\/shadow\/ .*never read or write it/)
  })

  test('says nothing about a tool this run does not have', () => {
    const guide = keepingGuide({ tools: ['ys_note', 'ys_read_file'] })!
    assert.doesNotMatch(guide, /update_plan|ask_user|memory_save|ys_write_file/)
    assert.equal(keepingGuide({ tools: ['ys_read_file'] }), null)
    // Unknown tools (the bench): the local ones only.
    assert.doesNotMatch(keepingGuide()!, /update_plan|memory_save/)
  })

  test('project memory without a linked project says so, rather than inviting a failing save', () => {
    const guide = keepingGuide({ tools: all, project: null })!
    assert.match(guide, /needs this workspace linked to a Nest project, and it is not/)
    assert.match(guide, /Choose Project/)
  })

  test('the model is told the files it already keeps, not Yellowscript\'s own', () => {
    const fs = tree({
      '.yellowscript/NOTES.md': '', '.yellowscript/PLAN.md': '', '.yellowscript/shadow/x.md': '',
      '.yellowscript/screenshots/a.md': '', '.yellowscript/docs/design.md': '', '.yellowscript/research.md': '',
      '.yellowscript/data.json': '',
    })
    assert.deepEqual(keptFiles(root, fs), ['.yellowscript/docs/design.md', '.yellowscript/research.md'])
    const text = buildWorkspaceContext(root, fs, { tools: all, project: 'Crestline' })!
    assert.match(text, /Yours so far: \.yellowscript\/docs\/design\.md, \.yellowscript\/research\.md\./)
  })
})
