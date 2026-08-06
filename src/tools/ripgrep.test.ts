import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'

import { locateRipgrep, ripgrepCandidatePaths, interpretExitCode } from './ripgrep.ts'

// The layout observed on VSCode 1.129 (commit 8a7abeba6e) — the fact that
// motivated making this a search rather than a constant. It differs from the
// long-assumed node_modules/@vscode/ripgrep/bin/rg in four ways at once.
const OBSERVED = path.join(
  'node_modules.asar.unpacked',
  '@vscode',
  'ripgrep-universal',
  'bin',
  'win32-x64',
  'rg.exe',
)

describe('ripgrepCandidatePaths', () => {
  test('includes the layout actually shipped by VSCode 1.129', () => {
    const candidates = ripgrepCandidatePaths('/app', 'win32', 'x64')
    assert.ok(
      candidates.some((c) => c.endsWith(OBSERVED)),
      `observed layout missing from:\n${candidates.join('\n')}`,
    )
  })

  test('still includes the historical flat layout', () => {
    const candidates = ripgrepCandidatePaths('/app', 'linux', 'x64')
    assert.ok(candidates.some((c) => c.endsWith(path.join('node_modules', '@vscode', 'ripgrep', 'bin', 'rg'))))
  })

  test('prefers the asar-unpacked copy', () => {
    // On a packaged build the plain node_modules path can exist inside the
    // archive without being executable.
    const candidates = ripgrepCandidatePaths('/app', 'win32', 'x64')
    const firstUnpacked = candidates.findIndex((c) => c.includes('node_modules.asar.unpacked'))
    const firstPlain = candidates.findIndex((c) => !c.includes('asar.unpacked'))
    assert.ok(firstUnpacked < firstPlain)
  })

  test('uses the .exe suffix only on win32', () => {
    assert.ok(ripgrepCandidatePaths('/app', 'win32', 'x64').every((c) => c.endsWith('rg.exe')))
    assert.ok(ripgrepCandidatePaths('/app', 'darwin', 'arm64').every((c) => c.endsWith('rg')))
  })

  test('nests by platform-arch for the universal package', () => {
    const candidates = ripgrepCandidatePaths('/app', 'darwin', 'arm64')
    assert.ok(candidates.some((c) => c.includes(path.join('bin', 'darwin-arm64'))))
  })
})

describe('locateRipgrep', () => {
  test('finds the binary at the observed 1.129 location', () => {
    const wanted = path.join('/app', OBSERVED)
    const found = locateRipgrep('/app', {
      platform: 'win32',
      arch: 'x64',
      exists: (c) => c === wanted,
    })
    assert.equal(found, wanted)
  })

  test('finds the binary at the historical location', () => {
    const wanted = path.join('/app', 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg')
    const found = locateRipgrep('/app', {
      platform: 'linux',
      arch: 'x64',
      exists: (c) => c === wanted,
    })
    assert.equal(found, wanted)
  })

  test('returns null when nothing is there, rather than a path that does not work', () => {
    // The caller disables ws_grep on null. Returning a hopeful path would hand
    // the model a tool that fails on every call instead.
    assert.equal(locateRipgrep('/app', { exists: () => false }), null)
  })

  test('returns null for an empty appRoot', () => {
    assert.equal(locateRipgrep('', { exists: () => true }), null)
  })

  test('probes candidates in order and stops at the first hit', () => {
    const probed: string[] = []
    locateRipgrep('/app', {
      platform: 'win32',
      arch: 'x64',
      exists: (c) => {
        probed.push(c)
        return c.includes('ripgrep-universal')
      },
    })
    assert.ok(probed.length > 0)
    assert.ok(probed[probed.length - 1]?.includes('ripgrep-universal'))
  })
})

describe('interpretExitCode', () => {
  test('0 means matches were found', () => {
    assert.equal(interpretExitCode(0), 'matches')
  })

  test('1 means the search ran and found nothing — not an error', () => {
    // Conflating these would have the model conclude a search failed when it
    // simply had no hits, and retry it.
    assert.equal(interpretExitCode(1), 'no-matches')
  })

  test('anything else is an error', () => {
    assert.equal(interpretExitCode(2), 'error')
    assert.equal(interpretExitCode(null), 'error')
  })
})
