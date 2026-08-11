// =============================================================================
// Tests for the shadow-git checkpoint manager.
// =============================================================================
// This is the safety net for every Phase 3 write. The tests use a fully faked
// filesystem AND a fully faked git (an in-memory blob store behind the same
// `git` CLI surface), so we can prove the revert restores exactly the pre-write
// bytes and nothing else — the "bug destroys user work" case HANDOFF calls out.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CheckpointManager, type GitBackend, type StagedFile } from './checkpoint.ts'

// A tiny in-memory git: a map of committed trees keyed by revision, each tree a
// map of relativePath -> content. Commits are sequential hashes.
class FakeGit implements GitBackend {
  shadowRoot = '/shadow'
  private trees: Record<string, Record<string, string>> = {}
  private head = 'init'
  private counter = 0

  constructor() {
    this.trees['init'] = {}
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(args: readonly string[], _cwd: string): Promise<string> {
    const [cmd, ...rest] = args
    if (cmd === 'init' || cmd === 'commit') {
      if (cmd === 'commit') {
        // Snapshot the staging area described by the parent tree plus whatever
        // was staged via `git add` (we model staging by mutating `staging`).
        const rev = `r${this.counter++}`
        this.trees[rev] = { ...this.trees[this.head], ...this.staging }
        this.head = rev
        return ''
      }
      return ''
    }
    if (cmd === 'add') {
      for (const rel of rest) {
        if (rel === '--') continue
        this.staging[rel] = this.workspaceMirror[rel] ?? ''
      }
      return ''
    }
    if (cmd === 'rev-parse') {
      return this.head + '\n'
    }
    if (cmd === 'show') {
      // `show <rev>:<rel>`
      const m = /^([^:]+):(.+)$/.exec(rest[0] ?? '')
      if (!m) throw new Error('bad show')
      const rev = m[1]!
      const rel = m[2]!
      const content = this.trees[rev]?.[rel]
      if (content === undefined) throw new Error('not in tree')
      return content
    }
    throw new Error(`unexpected git ${cmd}`)
  }

  private staging: Record<string, string> = {}
  /** The content the test "wrote" into the staged mirror before commit. */
  workspaceMirror: Record<string, string> = {}

  existsSync(_dir: string): boolean {
    return true
  }
  async mkdirp(_dir: string): Promise<void> {}
  async readFile(abs: string): Promise<string> {
    return this.onDisk[abs] ?? ''
  }
  async writeFile(abs: string, content: string): Promise<void> {
    this.onDisk[abs] = content
  }
  onDisk: Record<string, string> = {}
}

function staged(rel: string, content: string, abs: string): StagedFile {
  return { relativePath: rel, content, workspaceAbsolute: abs }
}

describe('CheckpointManager', () => {
  it('initialises a shadow repo lazily', async () => {
    const git = new FakeGit()
    const mgr = new CheckpointManager(git)
    await mgr.ensure()
    assert.ok(git.shadowRoot.length > 0)
  })

  it('checkpoints pre-write content and revert restores it', async () => {
    const git = new FakeGit()
    const mgr = new CheckpointManager(git)

    // Simulate the real workspace on disk before the write.
    git.onDisk['/ws/src/foo.ts'] = 'original\n'
    git.workspaceMirror['src/foo.ts'] = 'original\n'

    const cp = await mgr.checkpoint([staged('src/foo.ts', 'original\n', '/ws/src/foo.ts')], 'before edit')

    // The model "applies" a change to disk (outside the shadow).
    git.onDisk['/ws/src/foo.ts'] = 'CORRUPTED\n'

    // Revert restores the pre-write bytes via the shadow's blob.
    await mgr.revert(cp, [staged('src/foo.ts', 'original\n', '/ws/src/foo.ts')])
    assert.equal(git.onDisk['/ws/src/foo.ts'], 'original\n')
  })

  it('a partial revert touches only the named files', async () => {
    const git = new FakeGit()
    const mgr = new CheckpointManager(git)

    git.onDisk['/ws/a.ts'] = 'a-orig'
    git.onDisk['/ws/b.ts'] = 'b-orig'
    git.workspaceMirror['a.ts'] = 'a-orig'
    git.workspaceMirror['b.ts'] = 'b-orig'

    const cp = await mgr.checkpoint(
      [staged('a.ts', 'a-orig', '/ws/a.ts'), staged('b.ts', 'b-orig', '/ws/b.ts')],
      'before batch',
    )

    git.onDisk['/ws/a.ts'] = 'a-changed'
    git.onDisk['/ws/b.ts'] = 'b-changed'

    // Revert only a.ts.
    await mgr.revert(cp, [staged('a.ts', 'a-orig', '/ws/a.ts')])
    assert.equal(git.onDisk['/ws/a.ts'], 'a-orig')
    assert.equal(git.onDisk['/ws/b.ts'], 'b-changed')
  })

  it('distinct checkpoints hold distinct content', async () => {
    const git = new FakeGit()
    const mgr = new CheckpointManager(git)

    git.onDisk['/ws/f.ts'] = 'v1'
    git.workspaceMirror['f.ts'] = 'v1'
    const cp1 = await mgr.checkpoint([staged('f.ts', 'v1', '/ws/f.ts')], 'v1')

    git.onDisk['/ws/f.ts'] = 'v2'
    git.workspaceMirror['f.ts'] = 'v2'
    const cp2 = await mgr.checkpoint([staged('f.ts', 'v2', '/ws/f.ts')], 'v2')

    assert.notEqual(cp1.revision, cp2.revision)

    git.onDisk['/ws/f.ts'] = 'broken'
    await mgr.revert(cp1, [staged('f.ts', 'v1', '/ws/f.ts')])
    assert.equal(git.onDisk['/ws/f.ts'], 'v1')
  })
})
