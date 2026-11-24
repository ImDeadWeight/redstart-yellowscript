// =============================================================================
// Tests for the page check: what it may load, and the text the model reads.
// =============================================================================

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, describe, test } from 'node:test'

import { formatPageCheck, resolveTarget } from './page-check.ts'

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-page-')))
after(() => fs.rmSync(root, { recursive: true, force: true }))
fs.writeFileSync(path.join(root, 'index.html'), '<title>Local</title><p>hello</p>')

describe('resolveTarget', () => {
  test('loopback URLs and workspace files only', () => {
    assert.deepEqual(resolveTarget('http://localhost:5173/', [root]), { url: 'http://localhost:5173/' })
    assert.deepEqual(resolveTarget('http://127.0.0.1:8080/game', [root]), { url: 'http://127.0.0.1:8080/game' })
    assert.ok('url' in resolveTarget('http://[::1]:3000/', [root]))
    assert.match((resolveTarget('index.html', [root]) as { url: string }).url, /^file:\/\/.*index\.html$/)
    assert.match((resolveTarget('https://example.com', [root]) as { error: string }).error, /Only pages on this machine/)
    assert.match((resolveTarget('http://192.168.1.20/', [root]) as { error: string }).error, /Only pages on this machine/)
    assert.match((resolveTarget('javascript:alert(1)', [root]) as { error: string }).error, /localhost URL or a workspace-relative/)
    assert.match((resolveTarget('../outside.html', [root]) as { error: string }).error, /outside the workspace/)
    assert.match((resolveTarget('missing.html', [root]) as { error: string }).error, /does not exist/)
    // A game's test mode: the query stays on the file URL.
    assert.match((resolveTarget('index.html?test', [root]) as { url: string }).url, /^file:\/\/.*index\.html\?test$/)
    assert.match((resolveTarget('index.html#level-2', [root]) as { url: string }).url, /index\.html#level-2$/)
  })
})

describe('formatPageCheck', () => {
  test('counts problems and lists exceptions first', () => {
    const text = formatPageCheck(
      {
        url: 'http://localhost/',
        loaded: true,
        title: 'Game',
        events: [
          { kind: 'log', text: 'started' },
          { kind: 'exception', text: 'TypeError: x is undefined (game.js:12)' },
          { kind: 'request-failed', text: 'net::ERR_FILE_NOT_FOUND' },
        ],
        summary: '12 elements; canvas 640x480\nNo visible text.',
        durationMs: 2400,
      },
      '/ws/.yellowscript/screenshots/page.png',
    )
    assert.match(text, /loaded, title "Game"/)
    assert.match(text, /1 uncaught exception\(s\), 0 console error\(s\), 1 failed request\(s\)/)
    const consoleLines = text.split('--- console ---\n')[1]!.split('\n')
    assert.match(consoleLines[0]!, /^\[exception\] TypeError/)
    assert.match(text, /canvas 640x480/)
    assert.match(text, /Screenshot saved to/)
  })
})
