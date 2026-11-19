// =============================================================================
// Tests for ys_replace, ys_delete_file and ys_move_file (plans only, no writes).
// =============================================================================

import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, describe, it } from 'node:test'

import { createDeleteFileTool, createMoveFileTool, createReplaceTool } from './file-ops.ts'
import { autoApplyReason, type ApprovalStore } from './approval.ts'
import { CheckpointManager, type GitBackend } from './checkpoint.ts'
import type { WriteFs } from './write-file.ts'
import type { ToolContext } from './types.ts'

// Containment resolves real paths, so the workspace root must exist; the files
// themselves live in memory.
const root = nodeFs.realpathSync.native(nodeFs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-fileops-')))
after(() => nodeFs.rmSync(root, { recursive: true, force: true }))
const ctx: ToolContext = { workspaceRoots: [root] }

/** An in-memory workspace. */
function memoryFs(files: Record<string, string>): WriteFs {
  const abs = new Map(Object.entries(files).map(([k, v]) => [path.join(root, k), v]))
  return { exists: (p) => abs.has(p), read: (p) => abs.get(p)! }
}

describe('ys_replace', () => {
  const fs = memoryFs({
    'a.ts': 'const a = 1\nconst b = 2\nconst a2 = 1\n',
    'crlf.ts': 'one\r\ntwo\r\nthree\r\n',
  })
  const tool = createReplaceTool(fs)

  it('plans an edit of the one occurrence', async () => {
    const result = await tool.execute({ path: 'a.ts', old_string: 'const b = 2', new_string: 'const b = 3' }, ctx)
    assert.equal(result.isError, false)
    assert.equal(result.pendingWrite?.changes[0]?.after, 'const a = 1\nconst b = 3\nconst a2 = 1\n')
    assert.match(result.content, /line 2/)
  })

  it('refuses an ambiguous match and names the lines', async () => {
    const result = await tool.execute({ path: 'a.ts', old_string: '= 1', new_string: '= 9' }, ctx)
    assert.equal(result.isError, true)
    assert.match(result.content, /appears 2 times .*lines 1, 3/)
    assert.equal(result.pendingWrite, undefined)
  })

  it('replaces every occurrence when asked', async () => {
    const result = await tool.execute({ path: 'a.ts', old_string: '= 1', new_string: '= 9', replace_all: true }, ctx)
    assert.equal(result.pendingWrite?.changes[0]?.after, 'const a = 9\nconst b = 2\nconst a2 = 9\n')
  })

  it('says how to recover from a text that is not there', async () => {
    const result = await tool.execute({ path: 'a.ts', old_string: 'const c', new_string: 'x' }, ctx)
    assert.equal(result.isError, true)
    assert.match(result.content, /not found .*Read the file again/s)
  })

  it('matches a \\n old_string against a \\r\\n file, and keeps \\r\\n', async () => {
    const result = await tool.execute({ path: 'crlf.ts', old_string: 'one\ntwo', new_string: 'uno\ndos' }, ctx)
    assert.equal(result.isError, false)
    assert.equal(result.pendingWrite?.changes[0]?.after, 'uno\r\ndos\r\nthree\r\n')
  })

  it('a missing file points to ys_write_file; a path outside is refused', async () => {
    assert.match((await tool.execute({ path: 'nope.ts', old_string: 'a', new_string: 'b' }, ctx)).content, /ys_write_file/)
    assert.match((await tool.execute({ path: '../x.ts', old_string: 'a', new_string: 'b' }, ctx)).content, /outside the workspace/)
  })

  it('a "$" in new_string is literal, not a replacement pattern', async () => {
    const result = await tool.execute({ path: 'a.ts', old_string: 'const b = 2', new_string: "const b = '$&$1'" }, ctx)
    assert.match(result.pendingWrite!.changes[0]!.after, /const b = '\$&\$1'/)
  })
})

describe('ys_delete_file and ys_move_file', () => {
  const fs = memoryFs({ 'src/a.ts': 'A', 'src/b.ts': 'B' })

  it('plans a deletion with the old content kept for review', async () => {
    const result = await createDeleteFileTool(fs).execute({ path: 'src/a.ts' }, ctx)
    const change = result.pendingWrite!.changes[0]!
    assert.equal(change.isDeleted, true)
    assert.equal(change.before, 'A')
  })

  it('plans a move as a create plus a delete', async () => {
    const result = await createMoveFileTool(fs).execute({ from: 'src/a.ts', to: 'lib/a.ts' }, ctx)
    const [created, deleted] = result.pendingWrite!.changes
    assert.equal(created!.isNew, true)
    assert.equal(created!.after, 'A')
    assert.equal(deleted!.isDeleted, true)
  })

  it('refuses to move onto an existing file', async () => {
    const result = await createMoveFileTool(fs).execute({ from: 'src/a.ts', to: 'src/b.ts' }, ctx)
    assert.equal(result.isError, true)
    assert.match(result.content, /already exists/)
  })
})

describe('autoApplyReason', () => {
  const store = (allowed: string[]): ApprovalStore => ({ getAllowedTools: () => allowed, setAllowedTools: () => {} })

  it('never skips review for a deletion, whatever was granted', () => {
    assert.equal(autoApplyReason({ toolName: 'ys_edit_file', deletes: true }, store(['ys_edit_file']), true), null)
  })

  it('honours task trust, then the remembered grant', () => {
    assert.equal(autoApplyReason({ toolName: 'ys_edit_file', deletes: false }, store([]), true), 'task')
    assert.equal(autoApplyReason({ toolName: 'ys_edit_file', deletes: false }, store(['ys_edit_file']), false), 'always')
    assert.equal(autoApplyReason({ toolName: 'ys_edit_file', deletes: false }, store([]), false), null)
  })
})

describe('checkpoint revert of a file the write created', () => {
  it('deletes it rather than leaving it empty', async () => {
    const removed: string[] = []
    const written: string[] = []
    const git: GitBackend = {
      shadowRoot: '/shadow',
      run: async () => 'old',
      existsSync: () => true,
      mkdirp: async () => {},
      readFile: async () => '',
      writeFile: async (p) => void written.push(p),
      removeFile: async (p) => void removed.push(p),
    }
    const manager = new CheckpointManager(git)
    await manager.revert({ revision: 'r', label: 'x' }, [
      { workspaceAbsolute: '/ws/new.ts', relativePath: 'new', content: '', wasAbsent: true },
      { workspaceAbsolute: '/ws/old.ts', relativePath: 'old', content: 'old' },
    ])
    assert.deepEqual(removed, ['/ws/new.ts'])
    assert.deepEqual(written, ['/ws/old.ts'])
  })
})
