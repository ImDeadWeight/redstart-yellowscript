// =============================================================================
// Containment tests for workspace-path.ts.
// =============================================================================
// The hand-picked cases are transplanted from redstart-nest's
// scripts/test-path-scope.mjs (@ dde78ce) — HANDOFF.md section 6 says the cases
// carry over even though the implementation doesn't. Rewritten onto node:test,
// and extended with the multi-root cases that only exist here (Nest confines to
// one directory; VSCode workspaces can have several).
//
// Real fixtures on a real filesystem, deliberately: the escape this guard
// exists to stop — a symlink out of the workspace — cannot be reproduced
// against a mocked fs, because the whole point is that the lexical path looks
// contained and only the syscall disagrees.
// =============================================================================

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  resolveWithinWorkspace,
  tryResolveWithinWorkspace,
  describeWorkspacePath,
  PathScopeError,
  type PathRejection,
} from './workspace-path.ts'

// --- Fixture ---------------------------------------------------------------
// base/
//   work/            <- workspace folder #1
//     a.txt, sub/b.txt
//   other-folder/    <- workspace folder #2 (multi-root cases)
//     c.txt, only-in-other.txt
//   work-extra/      <- prefix sibling of "work", NOT in the workspace
//   outside/         <- never in the workspace
//     secret.txt

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-scope-')))
const work = path.join(base, 'work')
const other = path.join(base, 'other-folder')
const workExtra = path.join(base, 'work-extra')
const outside = path.join(base, 'outside')

fs.mkdirSync(path.join(work, 'sub'), { recursive: true })
fs.mkdirSync(other, { recursive: true })
fs.mkdirSync(workExtra, { recursive: true })
fs.mkdirSync(outside, { recursive: true })
fs.writeFileSync(path.join(work, 'a.txt'), 'a')
fs.writeFileSync(path.join(work, 'sub', 'b.txt'), 'b')
fs.writeFileSync(path.join(other, 'c.txt'), 'c')
fs.writeFileSync(path.join(other, 'only-in-other.txt'), 'o')
fs.writeFileSync(path.join(outside, 'secret.txt'), 's')

// A link inside the workspace pointing out of it — the hole a lexical check
// misses. Junctions need no elevation on Windows; POSIX takes a dir symlink.
const linkKind = process.platform === 'win32' ? 'junction' : 'dir'
let linkMade = false
let linkIn = false
try {
  fs.symlinkSync(outside, path.join(work, 'link-out'), linkKind)
  linkMade = true
} catch {
  // Some environments forbid link creation; those cases are skipped below.
}
try {
  // The reverse: an alias outside the workspace that points into it.
  fs.symlinkSync(work, path.join(outside, 'link-in'), linkKind)
  linkIn = true
} catch {
  // Skipped below.
}

after(() => fs.rmSync(base, { recursive: true, force: true }))

const SOLO = [work]
const MULTI = [work, other]

function assertRejected(fn: () => unknown, reason: PathRejection): void {
  assert.throws(fn, (err: unknown) => err instanceof PathScopeError && err.reason === reason)
}

// --- Containment: paths that must be allowed --------------------------------

describe('resolveWithinWorkspace — allowed', () => {
  test('a relative path inside the folder resolves to an existing file', () => {
    const resolved = resolveWithinWorkspace(SOLO, 'a.txt')
    assert.ok(fs.existsSync(resolved))
  })

  test('a nested relative path resolves', () => {
    assert.equal(resolveWithinWorkspace(SOLO, path.join('sub', 'b.txt')), path.join(work, 'sub', 'b.txt'))
  })

  test('forward slashes work regardless of platform', () => {
    // The model writes POSIX separators no matter what it is running on.
    assert.equal(resolveWithinWorkspace(SOLO, 'sub/b.txt'), path.join(work, 'sub', 'b.txt'))
  })

  test('a target that does not exist yet is allowed (the Phase 3 write case)', () => {
    const resolved = resolveWithinWorkspace(SOLO, 'sub/not-created-yet.ts')
    assert.equal(resolved, path.join(work, 'sub', 'not-created-yet.ts'))
    assert.ok(!fs.existsSync(resolved))
  })

  test('the folder itself resolves', () => {
    assert.equal(resolveWithinWorkspace(SOLO, '.'), work)
  })

  test('an absolute path inside the folder is accepted', () => {
    assert.equal(resolveWithinWorkspace(SOLO, path.join(work, 'a.txt')), path.join(work, 'a.txt'))
  })

  test('a traversal that stays inside is fine', () => {
    assert.equal(resolveWithinWorkspace(SOLO, 'sub/../a.txt'), path.join(work, 'a.txt'))
  })
})

// --- Containment: paths that must be refused --------------------------------

describe('resolveWithinWorkspace — refused', () => {
  test('"../" traversal out of the workspace is rejected', () => {
    assertRejected(
      () => resolveWithinWorkspace(SOLO, path.join('..', 'outside', 'secret.txt')),
      'escapes-workspace',
    )
  })

  test('deep "../.." traversal is rejected', () => {
    assertRejected(() => resolveWithinWorkspace(SOLO, 'sub/../../outside/secret.txt'), 'escapes-workspace')
  })

  test('an absolute path outside the workspace is rejected', () => {
    assertRejected(
      () => resolveWithinWorkspace(SOLO, path.join(outside, 'secret.txt')),
      'escapes-workspace',
    )
  })

  test('a prefix-sibling folder is rejected (work vs work-extra)', () => {
    // Guards the naive startsWith(root) bug: "…/work-extra" starts with
    // "…/work" as a string while being a different directory entirely.
    assertRejected(() => resolveWithinWorkspace(SOLO, workExtra), 'escapes-workspace')
    assertRejected(() => resolveWithinWorkspace(SOLO, '../work-extra/anything.txt'), 'escapes-workspace')
  })

  test('a NUL byte in the path is rejected', () => {
    assertRejected(() => resolveWithinWorkspace(SOLO, 'a\0.txt'), 'invalid-character')
  })

  test('a non-string path is rejected', () => {
    assertRejected(() => resolveWithinWorkspace(SOLO, 42 as unknown as string), 'not-a-string')
  })

  test('no workspace folders is a configuration error, not an escape', () => {
    // The distinction matters: with nothing open there is no path the model
    // could have supplied that would have worked.
    assertRejected(() => resolveWithinWorkspace([], 'a.txt'), 'no-workspace')
  })

  test('folders that no longer exist are treated as no workspace', () => {
    assertRejected(() => resolveWithinWorkspace([path.join(base, 'deleted')], 'a.txt'), 'no-workspace')
  })
})

// --- Symlink escape ---------------------------------------------------------

describe('resolveWithinWorkspace — symlink escape', () => {
  test('a path through an inside→outside link is rejected', { skip: !linkMade }, () => {
    // Lexically this is "inside the workspace"; only the resolved path reveals
    // otherwise. This is the case a startsWith check gets wrong.
    assertRejected(
      () => resolveWithinWorkspace(SOLO, path.join('link-out', 'secret.txt')),
      'escapes-workspace',
    )
  })

  test('a not-yet-existing file under an escaping link is still rejected', { skip: !linkMade }, () => {
    assertRejected(
      () => resolveWithinWorkspace(SOLO, path.join('link-out', 'new.txt')),
      'escapes-workspace',
    )
  })

  test('the link itself is rejected', { skip: !linkMade }, () => {
    assertRejected(() => resolveWithinWorkspace(SOLO, 'link-out'), 'escapes-workspace')
  })

  test('a link from OUTSIDE pointing in is refused — fail-closed by design', { skip: !linkIn }, () => {
    // The reverse direction: outside/link-in -> work/. This really does resolve
    // to a workspace file, but it is refused because the lexical check rejects
    // it before any realpath happens. Pinned because it is a deliberate
    // trade-off (see the header), not an oversight — the same early rejection
    // is what keeps the guard cheap on the common `..` case.
    assertRejected(
      () => resolveWithinWorkspace(SOLO, path.join(outside, 'link-in', 'a.txt')),
      'escapes-workspace',
    )
  })
})

// --- win32 specifics --------------------------------------------------------

describe('resolveWithinWorkspace — win32', { skip: process.platform !== 'win32' }, () => {
  test('a path on another drive is rejected', () => {
    const drive = work[0]?.toLowerCase() === 'c' ? 'D:' : 'C:'
    assertRejected(() => resolveWithinWorkspace(SOLO, `${drive}\\Windows\\system.ini`), 'escapes-workspace')
  })

  test('a case-differing path inside the folder is accepted', () => {
    // NTFS is case-insensitive; refusing this would be a false positive.
    assert.ok(resolveWithinWorkspace(SOLO, 'A.TXT'))
  })

  test('backslash traversal is rejected', () => {
    assertRejected(() => resolveWithinWorkspace(SOLO, '..\\outside\\secret.txt'), 'escapes-workspace')
  })
})

// --- Multi-root: new here, no equivalent in Nest ----------------------------

describe('resolveWithinWorkspace — multi-root workspaces', () => {
  test('a relative path resolves in the folder where it actually exists', () => {
    // Not folder #1 — resolving there and reporting "not found" would be the
    // obvious wrong answer in a multi-root workspace.
    assert.equal(
      resolveWithinWorkspace(MULTI, 'only-in-other.txt'),
      path.join(other, 'only-in-other.txt'),
    )
  })

  test('a relative path that exists in the first folder still prefers it', () => {
    assert.equal(resolveWithinWorkspace(MULTI, 'a.txt'), path.join(work, 'a.txt'))
  })

  test('an absolute path in the second folder is accepted', () => {
    assert.equal(resolveWithinWorkspace(MULTI, path.join(other, 'c.txt')), path.join(other, 'c.txt'))
  })

  test('traversal from one folder into another is allowed — both are the workspace', () => {
    assert.equal(resolveWithinWorkspace(MULTI, '../other-folder/c.txt'), path.join(other, 'c.txt'))
  })

  test('a path outside every folder is still rejected', () => {
    assertRejected(() => resolveWithinWorkspace(MULTI, path.join(outside, 'secret.txt')), 'escapes-workspace')
  })

  test('a nonexistent target falls back to the first folder', () => {
    assert.equal(resolveWithinWorkspace(MULTI, 'brand-new.txt'), path.join(work, 'brand-new.txt'))
  })

  test('a vanished folder is skipped without taking the others down', () => {
    const withGhost = [path.join(base, 'deleted'), other]
    assert.equal(resolveWithinWorkspace(withGhost, 'c.txt'), path.join(other, 'c.txt'))
  })
})

// --- tryResolveWithinWorkspace ----------------------------------------------

describe('tryResolveWithinWorkspace', () => {
  test('returns the path on success', () => {
    assert.equal(tryResolveWithinWorkspace(SOLO, 'a.txt'), path.join(work, 'a.txt'))
  })

  test('returns null on an escape instead of throwing', () => {
    assert.equal(tryResolveWithinWorkspace(SOLO, '../outside/secret.txt'), null)
  })

  test('returns null for a malformed path', () => {
    assert.equal(tryResolveWithinWorkspace(SOLO, 'a\0.txt'), null)
  })

  test('still throws when there is no workspace — that is not a denial', () => {
    assertRejected(() => tryResolveWithinWorkspace([], 'a.txt'), 'no-workspace')
  })
})

// --- describeWorkspacePath --------------------------------------------------

describe('describeWorkspacePath', () => {
  test('a single-folder workspace gets a bare relative path', () => {
    assert.equal(describeWorkspacePath(SOLO, path.join(work, 'sub', 'b.txt')), 'sub/b.txt')
  })

  test('separators are POSIX regardless of platform', () => {
    assert.ok(!describeWorkspacePath(SOLO, path.join(work, 'sub', 'b.txt')).includes('\\'))
  })

  test('a multi-folder workspace names the folder', () => {
    // "src/index.ts" is ambiguous when two folders both have one.
    assert.equal(describeWorkspacePath(MULTI, path.join(other, 'c.txt')), 'other-folder/c.txt')
  })

  test('the folder root itself renders as "."', () => {
    assert.equal(describeWorkspacePath(SOLO, work), '.')
  })

  test('a path outside the workspace is returned unchanged', () => {
    const secret = path.join(outside, 'secret.txt')
    assert.equal(describeWorkspacePath(SOLO, secret), secret)
  })
})

// --- Property fuzz ----------------------------------------------------------
// The invariant, stated once and checked against inputs nobody enumerated: for
// ANY string, resolution either lands inside a workspace folder or is refused.
// It must never return a path outside. Deterministic seed so a breach is
// reproducible from the failure message.

describe('resolveWithinWorkspace — property fuzz', () => {
  test('no random input ever resolves outside the workspace', () => {
    const TOKENS = [
      '..', '.', 'sub', 'outside', 'a.txt', 'secret.txt', '/', '\\', 'C:', 'C:\\', '~',
      '%2e%2e', '%2f', '....//', ' ', 'café', '日本', '..%2f', 'sub/..', 'link-out',
      'work-extra', 'other-folder', 'foo.txt', '',
    ]
    const SEPS = ['/', '\\', '', path.sep]

    const SEED = 0x9e3779b9
    let state = SEED
    const rnd = (): number => (state = (state * 1664525 + 1013904223) >>> 0) / 0x100000000
    const pick = (arr: readonly string[]): string => arr[Math.floor(rnd() * arr.length)] ?? ''

    const realRoots = MULTI.map((r) => fs.realpathSync.native(r))
    const fold = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)

    // Matches the Nest suite's count. Affordable because a lexically-escaping
    // input — most of what this generates — is now settled without touching the
    // filesystem; at one realpath walk per input this took 25x longer.
    const N = 3000
    let contained = 0
    let rejected = 0

    for (let i = 0; i < N; i++) {
      const segments = 1 + Math.floor(rnd() * 8)
      let input = ''
      for (let j = 0; j < segments; j++) {
        input += pick(TOKENS) + (j < segments - 1 ? pick(SEPS) : '')
      }

      let resolved: string | null
      try {
        resolved = tryResolveWithinWorkspace(MULTI, input)
      } catch (err) {
        // The workspace is valid, so a configuration error here is a bug.
        const why = err instanceof Error ? err.message : String(err)
        throw new Error(`unexpected throw for ${JSON.stringify(input)}: ${why}`)
      }

      if (resolved === null) {
        rejected++
        continue
      }

      // Mirror the guard's own comparison rather than using path.relative:
      // an input containing a literal "C:" segment makes relative()/isAbsolute()
      // mis-parse a perfectly contained path as drive-absolute.
      const target = fold(resolved)
      const inside = realRoots.some((root) => {
        const r = fold(root)
        return target === r || target.startsWith(r + path.sep)
      })
      if (!inside) {
        throw new Error(
          `CONTAINMENT BREACH (seed ${SEED}, iteration ${i}): ${JSON.stringify(input)} -> ${resolved}`,
        )
      }
      contained++
    }

    assert.equal(contained + rejected, N)
    assert.ok(rejected > 0, 'fuzz never exercised the rejection path — check the token set')
    assert.ok(contained > 0, 'fuzz never exercised the success path — check the token set')
  })
})
