// =============================================================================
// Tests for the Phase 3 write tools.
// =============================================================================
// The tools must NEVER write to disk — they only plan a change and return it as
// a `pendingWrite` for approval. These tests prove that, and that the planned
// change matches what Apply would later write. They use a REAL temp directory
// (like the read-file tests) so the workspace guard resolves real paths, plus a
// separate in-memory fs to assert the on-disk content is untouched.

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createEditFileTool, createWriteFileTool, nodeWriteFs } from './write-file.ts'
import type { WriteFs } from './write-file.ts'
import type { ToolContext } from './types.ts'

// A memory mirror used only to assert the disk is untouched by the planning.
function mirror(): { fs: WriteFs; root: string } {
  const store = new Map<string, string>()
  return {
    root: '',
    fs: {
      exists: (p) => store.has(p),
      read: (p) => {
        const found = store.get(p)
        if (found === undefined) throw new Error('ENOENT')
        return found
      },
    },
  }
}

let work: string
let ctx: ToolContext

before(() => {
  work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-write-')))
  ctx = { workspaceRoots: [work] }
})

after(() => {
  fs.rmSync(work, { recursive: true, force: true })
})

describe('ws_edit_file', () => {
  it('returns a pending change, not a disk write', async () => {
    const file = path.join(work, 'foo.ts')
    fs.writeFileSync(file, 'a\nb\nc')
    const tool = createEditFileTool(nodeWriteFs)
    const result = await tool.execute(
      {
        diff: [
          '--- a/foo.ts',
          '+++ b/foo.ts',
          '@@ -2,1 +2,1 @@',
          ' b',
          '-c',
          '+C',
        ].join('\n'),
      },
      ctx,
    )

    assert.equal(result.isError, false)
    assert.ok(result.pendingWrite, 'expected a pendingWrite')
    assert.equal(result.pendingWrite!.changes.length, 1)
    const change = result.pendingWrite!.changes[0]!
    assert.equal(change.absolutePath, file)
    assert.equal(change.before, 'a\nb\nc')
    assert.equal(change.after, 'a\nb\nC')
    // The on-disk content is untouched — the tool never wrote.
    assert.equal(fs.readFileSync(file, 'utf8'), 'a\nb\nc')
  })

  it('rejects a diff whose context drifted from disk', async () => {
    const file = path.join(work, 'drift.ts')
    fs.writeFileSync(file, 'totally different')
    const tool = createEditFileTool(nodeWriteFs)
    const result = await tool.execute(
      {
        diff: ['--- a/drift.ts', '+++ b/drift.ts', '@@ -1,1 +1,1 @@', '-a', '+A'].join('\n'),
      },
      ctx,
    )
    assert.equal(result.isError, true)
    assert.equal(result.pendingWrite, undefined)
  })

  it('refuses an escape path', async () => {
    const tool = createEditFileTool(nodeWriteFs)
    const result = await tool.execute(
      {
        diff: [
          '--- a/../../etc/passwd',
          '+++ b/../../etc/passwd',
          '@@ -1,1 +1,1 @@',
          '-x',
          '+y',
        ].join('\n'),
      },
      ctx,
    )
    assert.equal(result.isError, true)
    assert.equal(result.pendingWrite, undefined)
  })

  it('returns the good file when one of a batch is bad', async () => {
    fs.writeFileSync(path.join(work, 'good.ts'), 'a\nb')
    fs.writeFileSync(path.join(work, 'bad.ts'), 'real')
    const tool = createEditFileTool(nodeWriteFs)
    const result = await tool.execute(
      {
        diff: [
          'diff --git a/good.ts b/good.ts',
          '--- a/good.ts',
          '+++ b/good.ts',
          '@@ -1,1 +1,1 @@',
          '-a',
          '+A',
          'diff --git a/bad.ts b/bad.ts',
          '--- a/bad.ts',
          '+++ b/bad.ts',
          '@@ -1,1 +1,1 @@',
          '-nope',
          '+yep',
        ].join('\n'),
      },
      ctx,
    )
    assert.equal(result.isError, false)
    assert.equal(result.pendingWrite!.changes.length, 1)
    assert.equal(path.basename(result.pendingWrite!.changes[0]!.absolutePath), 'good.ts')
    assert.match(result.content, /rejected/i)
  })
})

describe('ws_write_file', () => {
  it('proposes a new file', async () => {
    const tool = createWriteFileTool(nodeWriteFs)
    const result = await tool.execute({ path: 'new.ts', content: 'hello' }, ctx)
    assert.equal(result.isError, false)
    const change = result.pendingWrite!.changes[0]!
    assert.equal(change.isNew, true)
    assert.equal(change.before, '')
    assert.equal(change.after, 'hello')
    assert.equal(fs.existsSync(path.join(work, 'new.ts')), false)
  })

  it('proposes a replacement of an existing file', async () => {
    const file = path.join(work, 'old.ts')
    fs.writeFileSync(file, 'old content')
    const tool = createWriteFileTool(nodeWriteFs)
    const result = await tool.execute({ path: 'old.ts', content: 'new content' }, ctx)
    assert.equal(result.isError, false)
    const change = result.pendingWrite!.changes[0]!
    assert.equal(change.isNew, false)
    assert.equal(change.before, 'old content')
    assert.equal(change.after, 'new content')
    assert.equal(fs.readFileSync(file, 'utf8'), 'old content')
  })

  it('refuses an escape path', async () => {
    const tool = createWriteFileTool(nodeWriteFs)
    const result = await tool.execute({ path: '../../etc/passwd', content: 'x' }, ctx)
    assert.equal(result.isError, true)
    assert.equal(result.pendingWrite, undefined)
  })
})

void mirror
