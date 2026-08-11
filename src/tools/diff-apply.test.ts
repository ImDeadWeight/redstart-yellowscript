// =============================================================================
// Tests for the unified-diff applier.
// =============================================================================
// This engine is the spine of Phase 3 write tools: it turns a model-supplied
// diff into concrete, containment-checked file changes WITHOUT touching disk.
// A bug here either rejects valid edits (annoying) or applies wrong bytes
// (destructive) — so every branch is exercised, including the dangerous ones:
// context mismatch, escape attempts, and renames we refuse to honour.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PathScopeError } from './workspace-path.ts'
import { applyHunks, parseUnifiedDiff, planFileChanges, type DiffFile } from './diff-apply.ts'

const ROOT = '/workspace'
const ROOT_A = '/workspace/a'

function resolveInside(rel: string): string {
  if (rel.includes('..') || rel.startsWith('/')) throw new PathScopeError('escapes-workspace', 'no')
  return `${ROOT}/${rel}`
}

function makeWorkspace(files: Record<string, string>): {
  resolve: (rel: string) => string
  exists: (abs: string) => boolean
  readFile: (abs: string) => string
} {
  const store = new Map<string, string>(
    Object.entries(files).map(([k, v]) => [`${ROOT}/${k}`, v]),
  )
  return {
    resolve: resolveInside,
    exists: (abs) => store.has(abs),
    readFile: (abs) => {
      const found = store.get(abs)
      if (found === undefined) throw new Error('ENOENT')
      return found
    },
  }
}

function diffOf(...files: DiffFile[]): { files: DiffFile[] } {
  return { files }
}

// --- parseUnifiedDiff -------------------------------------------------------

describe('parseUnifiedDiff', () => {
  it('parses a single-file add', () => {
    const parsed = parseUnifiedDiff(
      ['--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,2 @@', '+line one', '+line two'].join('\n'),
    )
    assert.equal(parsed.files.length, 1)
    const file = parsed.files[0]!
    assert.equal(file.path, 'src/new.ts')
    assert.equal(file.isNew, true)
    assert.equal(file.hunks.length, 1)
    assert.deepEqual(file.hunks[0]!.body, ['+line one', '+line two'])
  })

  it('parses a single-file edit with context', () => {
    const parsed = parseUnifiedDiff(
      [
        '--- a/src/foo.ts',
        '+++ b/src/foo.ts',
        '@@ -1,3 +1,3 @@',
        ' context',
        '-old',
        '+new',
        ' context',
      ].join('\n'),
    )
    assert.equal(parsed.files.length, 1)
    const file = parsed.files[0]!
    assert.equal(file.path, 'src/foo.ts')
    assert.equal(file.isNew, false)
    assert.equal(file.hunks[0]!.oldStart, 1)
    assert.equal(file.hunks[0]!.oldLines, 3)
    assert.equal(file.hunks[0]!.newStart, 1)
    assert.equal(file.hunks[0]!.newLines, 3)
  })

  it('strips the a/ and b/ tree prefixes', () => {
    const parsed = parseUnifiedDiff(
      ['--- a/deep/path.ts', '+++ b/deep/path.ts', '@@ -1,1 +1,1 @@', ' line'].join('\n'),
    )
    assert.equal(parsed.files[0]!.path, 'deep/path.ts')
  })

  it('parses a multi-file diff separated by diff --git', () => {
    const parsed = parseUnifiedDiff(
      [
        'diff --git a/one.ts b/one.ts',
        '--- a/one.ts',
        '+++ b/one.ts',
        '@@ -1,1 +1,1 @@',
        '-a',
        '+A',
        'diff --git a/two.ts b/two.ts',
        '--- a/two.ts',
        '+++ b/two.ts',
        '@@ -1,1 +1,1 @@',
        '-b',
        '+B',
      ].join('\n'),
    )
    assert.equal(parsed.files.length, 2)
    assert.deepEqual(
      parsed.files.map((f) => f.path),
      ['one.ts', 'two.ts'],
    )
  })

  it('flags a rename as unsupported', () => {
    const parsed = parseUnifiedDiff(
      ['--- a/old.ts', '+++ b/new.ts', '@@ -1,1 +1,1 @@', ' line'].join('\n'),
    )
    assert.ok(parsed.files[0]!.path.startsWith('UNSUPPORTED_RENAME:') || parsed.files.length === 0)
  })

  it('rejects a malformed hunk header', () => {
    const parsed = parseUnifiedDiff(
      ['--- a/x.ts', '+++ b/x.ts', '@@ not a header @@', '+x'].join('\n'),
    )
    // The hunk header is dropped, so the file has no usable hunks and is skipped.
    assert.equal(parsed.files.length, 0)
  })
})

// --- applyHunks (the context-matching core) ---------------------------------

describe('applyHunks', () => {
  it('applies a matching edit', () => {
    const file: DiffFile = {
      path: 'f.ts',
      isNew: false,
      isDeleted: false,
      hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, body: [' context', '-old', '+new', ' context'] }],
    }
    const result = applyHunks('context\nold\ncontext', file)
    assert.equal(result, 'context\nnew\ncontext')
  })

  it('returns null when context does not match', () => {
    const file: DiffFile = {
      path: 'f.ts',
      isNew: false,
      isDeleted: false,
      hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, body: ['-old', '+new'] }],
    }
    // The file actually has "context" where the diff expects "old".
    const result = applyHunks('context\ncontext', file)
    assert.equal(result, null)
  })

  it('applies multiple hunks independently', () => {
    const file: DiffFile = {
      path: 'f.ts',
      isNew: false,
      isDeleted: false,
      hunks: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, body: ['+inserted', ' first'] },
        { oldStart: 3, oldLines: 1, newStart: 4, newLines: 1, body: [' third'] },
      ],
    }
    const result = applyHunks('first\nsecond\nthird', file)
    assert.equal(result, 'inserted\nfirst\nsecond\nthird')
  })

  it('respects the hunk line offset', () => {
    const file: DiffFile = {
      path: 'f.ts',
      isNew: false,
      isDeleted: false,
      hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, body: ['-second', '+SECOND'] }],
    }
    const result = applyHunks('first\nsecond\nthird', file)
    assert.equal(result, 'first\nSECOND\nthird')
  })

  it('handles a new file (empty before)', () => {
    const file: DiffFile = {
      path: 'f.ts',
      isNew: true,
      isDeleted: false,
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, body: ['+hello'] }],
    }
    const result = applyHunks('', file)
    assert.equal(result, 'hello')
  })
})

// --- planFileChanges (containment + existence + assembly) -------------------

describe('planFileChanges', () => {
  it('plans an edit of an existing file', () => {
    const ws = makeWorkspace({ 'src/foo.ts': 'a\nb\nc' })
    const diff = parseUnifiedDiff(
      [
        '--- a/src/foo.ts',
        '+++ b/src/foo.ts',
        '@@ -2,1 +2,2 @@',
        ' b',
        '+new',
        ' c',
      ].join('\n'),
    )
    const result = planFileChanges(diff, ws.resolve, ws.exists, ws.readFile)
    assert.equal(result.errors.length, 0)
    assert.equal(result.changes.length, 1)
    const change = result.changes[0]!
    assert.equal(change.absolutePath, `${ROOT}/src/foo.ts`)
    assert.equal(change.before, 'a\nb\nc')
    assert.equal(change.after, 'a\nb\nnew\nc')
  })

  it('rejects an edit to a missing file', () => {
    const ws = makeWorkspace({})
    const diff = parseUnifiedDiff(
      ['--- a/missing.ts', '+++ b/missing.ts', '@@ -1,1 +1,1 @@', '-x', '+y'].join('\n'),
    )
    const result = planFileChanges(diff, ws.resolve, ws.exists, ws.readFile)
    assert.equal(result.changes.length, 0)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0]!.reason, /does not exist/)
  })

  it('rejects a path that escapes the workspace', () => {
    const ws = makeWorkspace({ 'src/foo.ts': 'x' })
    const diff = parseUnifiedDiff(
      ['--- a/../../../etc/passwd', '+++ b/../../../etc/passwd', '@@ -1,1 +1,1 @@', '-x', '+y'].join('\n'),
    )
    const result = planFileChanges(diff, ws.resolve, ws.exists, ws.readFile)
    assert.equal(result.changes.length, 0)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0]!.reason, /outside the workspace/)
  })

  it('rejects a file whose context drifted from disk', () => {
    const ws = makeWorkspace({ 'src/foo.ts': 'actual content here' })
    const diff = parseUnifiedDiff(
      ['--- a/src/foo.ts', '+++ b/src/foo.ts', '@@ -1,1 +1,1 @@', '-expected', '+changed'].join('\n'),
    )
    const result = planFileChanges(diff, ws.resolve, ws.exists, ws.readFile)
    assert.equal(result.changes.length, 0)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0]!.reason, /context did not match/)
  })

  it('separates a good file from a bad one in a batch', () => {
    const ws = makeWorkspace({ 'good.ts': 'a\nb' })
    const diff = diffOf(
      {
        path: 'good.ts',
        isNew: false,
        isDeleted: false,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, body: ['-a', '+A'] }],
      },
      {
        path: 'bad.ts',
        isNew: false,
        isDeleted: false,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, body: ['-nope', '+yep'] }],
      },
    )
    const result = planFileChanges(diff, ws.resolve, ws.exists, ws.readFile)
    assert.equal(result.changes.length, 1)
    assert.equal(result.changes[0]!.relativePath, 'good.ts')
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0]!.path, 'bad.ts')
  })
})

void ROOT_A
