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
import { noteSeen } from './read-ledger.ts'
import { createReadFileTool } from './read-file.ts'
import { nodeWriteFs } from './write-file.ts'

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

// The redstart-website chats (2026-11-25): 44 of 173 ys_replace calls failed,
// nearly all on indentation, most often the first line's, in tab-indented
// CRLF Svelte files.
describe('ys_replace when old_string is off', () => {
  const page = [
    '<script>',
    '\tconst projects = [',
    '\t\t{',
    "\t\t\tname: 'Dungeonbooks',",
    "\t\t\tdescription: 'Old',",
    '\t\t},',
    '\t];',
    '</script>',
    '',
  ].join('\r\n')
  const twice = '<div>\n\t<p>a</p>\n</div>\n<div>\n\t<p>a</p>\n</div>\n'
  const fs = memoryFs({ 'page.svelte': page, 'twice.svelte': twice })
  const tool = createReplaceTool(fs)
  const fresh = (): ToolContext => ({ workspaceRoots: [root] })

  it('a first line indented wrong is matched, and the file keeps its indentation', async () => {
    // (One indented short is a plain substring of the file's line, and
    // matches exactly already.)
    const result = await tool.execute({
      path: 'page.svelte',
      old_string: "\t\t\t\t{\n\t\t\tname: 'Dungeonbooks',\n\t\t\tdescription: 'Old',",
      new_string: "\t\t\t\t{\n\t\t\tname: 'Dungeonbooks',\n\t\t\tdescription: 'Android and Windows',",
    }, fresh())
    assert.equal(result.isError, false, result.content)
    assert.equal(result.pendingWrite!.changes[0]!.after, page.replace("'Old'", "'Android and Windows'"))
    assert.match(result.content, /line 3/)
    assert.match(result.content, /indentation set aside/)
  })

  it('a block shifted by one tab throughout is shifted back, new lines with it', async () => {
    const result = await tool.execute({
      path: 'page.svelte',
      old_string: "\t\tname: 'Dungeonbooks',\n\t\tdescription: 'Old',",
      new_string: "\t\tname: 'Dungeonbooks',\n\t\ticon: '/db.png',\n\t\tdescription: 'Old',",
    }, fresh())
    assert.equal(result.isError, false, result.content)
    assert.equal(result.pendingWrite!.changes[0]!.after, page.replace("\t\t\tdescription", "\t\t\ticon: '/db.png',\r\n\t\t\tdescription"))
  })

  it('indentation off by different amounts on different lines is not guessed at', async () => {
    const result = await tool.execute({
      path: 'page.svelte',
      old_string: "\t{\n\tname: 'Dungeonbooks',\n\t\t\t\t\tdescription: 'Old',",
      new_string: 'x',
    }, fresh())
    assert.equal(result.isError, true)
    assert.equal(result.pendingWrite, undefined)
    assert.match(result.content, /Closest: lines 3-5, where 3 of its 3 lines match with whitespace aside/)
    assert.match(result.content, /your line 1 is "\\t\{"; the file's line 3 is "\\t\\t\{"/)
    assert.match(result.content, /exactly as it has them:\n---\n\t\t\{\n\t\t\tname: 'Dungeonbooks',\n\t\t\tdescription: 'Old',\n---$/)
  })

  it('a loose match in two places is not made', async () => {
    const result = await tool.execute({ path: 'twice.svelte', old_string: '<p>a</p>', new_string: '<p>b</p>' }, fresh())
    // The exact text is in it twice: the usual ambiguity error.
    assert.match(result.content, /appears 2 times/)
    const loose = await tool.execute({ path: 'twice.svelte', old_string: '<div>\n<p>a</p>', new_string: '<div>\n<p>b</p>' }, fresh())
    assert.equal(loose.isError, true)
    assert.equal(loose.pendingWrite, undefined)
  })

  it('a wrong line is pointed at, with the file text to copy', async () => {
    const result = await tool.execute({
      path: 'page.svelte',
      old_string: "\t\t\tname: 'Dungeonbooks',\n\t\t\tdescription: 'A digital tool',",
      new_string: 'x',
    }, fresh())
    assert.equal(result.isError, true)
    assert.match(result.content, /Closest: lines 4-5, where 1 of its 2 lines match/)
    assert.match(result.content, /your line 2 is "\\t\\t\\tdescription: 'A digital tool',"; the file's line 5 is "\\t\\t\\tdescription: 'Old',"/)
  })

  it('says when the file changed since it was read, or was never read', async () => {
    const context = fresh()
    const absolute = path.join(root, 'page.svelte')
    const wrong = { path: 'page.svelte', old_string: "description: 'Older'", new_string: 'x' }
    assert.match((await tool.execute(wrong, context)).content, /You have not read this file in this run/)
    noteSeen(context, absolute, 'an earlier version\n')
    assert.match((await tool.execute(wrong, context)).content, /changed since you last read it/)
    noteSeen(context, absolute, page)
    const current = (await tool.execute(wrong, context)).content
    assert.doesNotMatch(current, /changed since|not read/)
  })

  it('ys_read_file is what makes a file read', async () => {
    const context = fresh()
    nodeFs.writeFileSync(path.join(root, 'real.svelte'), '<p>one</p>\r\n')
    const real = createReplaceTool(nodeWriteFs)
    const wrong = { path: 'real.svelte', old_string: '<p>two</p>', new_string: 'x' }
    assert.match((await real.execute(wrong, context)).content, /not read this file/)
    await createReadFileTool().execute({ path: 'real.svelte' }, context)
    assert.doesNotMatch((await real.execute(wrong, context)).content, /changed since|not read/)
    nodeFs.writeFileSync(path.join(root, 'real.svelte'), '<p>three</p>\r\n')
    assert.match((await real.execute(wrong, context)).content, /changed since you last read it/)
  })

  it('a planned edit counts as seen: the next edit to the same file is not called stale', async () => {
    const context = fresh()
    const first = await tool.execute({ path: 'page.svelte', old_string: "'Old'", new_string: "'New'" }, context)
    assert.equal(first.isError, false)
    // Approved: the file is now what the first edit planned.
    const after = createReplaceTool(memoryFs({ 'page.svelte': first.pendingWrite!.changes[0]!.after }))
    const second = await after.execute({ path: 'page.svelte', old_string: "'Gone'", new_string: 'x' }, context)
    assert.doesNotMatch(second.content, /changed since|not read/)
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

  it('never skips review for a protected path (settings, tasks, scripts)', () => {
    assert.equal(autoApplyReason({ toolName: 'ys_write_file', deletes: false, alwaysAsk: true }, store(['ys_write_file']), true), null)
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
