// =============================================================================
// Tests for ys_check_page: what it may load, and a real headless run.
// =============================================================================
// The headless test drives whatever Chrome/Edge/Chromium this machine has and
// is skipped when there is none (a CI image without a browser).

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, describe, test } from 'node:test'

import { createCheckPageTool, findBrowser, formatPageCheck, resolveTarget } from './browser-check.ts'

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

const browser = findBrowser()

describe('ys_check_page in a real headless browser', { skip: browser ? false : 'no Chrome, Edge or Chromium on this machine' }, () => {
  test('reports the exception, the console error, the 404 and the canvas', async () => {
    const page = `<!doctype html><title>Barrels</title>
<canvas id="c" width="320" height="240"></canvas>
<img src="/missing.png">
<script>
  console.error('sprite sheet failed');
  setTimeout(() => { undefinedFunction() }, 200);
</script>`
    const server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(page)
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const shots = path.join(root, 'shots')
    try {
      const tool = createCheckPageTool({ browser: () => browser, screenshotDir: () => shots })
      const result = await tool.execute({ target: `http://127.0.0.1:${port}/`, wait_s: 1 }, { workspaceRoots: [root] })
      assert.equal(result.isError, false, result.content)
      assert.match(result.content, /loaded, title "Barrels"/)
      assert.match(result.content, /\[exception\].*undefinedFunction/)
      assert.match(result.content, /\[error\] sprite sheet failed/)
      assert.match(result.content, /404|ERR_|Failed to load/)
      assert.match(result.content, /canvas 320x240/)
      assert.equal(result.summary, 'ys_check_page — problems found')
      assert.ok(result.images?.[0]?.startsWith('data:image/png;base64,'))
      assert.equal(fs.readdirSync(shots).length, 1, 'the screenshot is saved for the person')
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })

  test('a clean workspace file reports no errors', async () => {
    const tool = createCheckPageTool({ browser: () => browser, screenshotDir: () => null })
    const result = await tool.execute({ target: 'index.html', wait_s: 0 }, { workspaceRoots: [root] })
    assert.match(result.content, /No errors/)
    assert.match(result.content, /hello/)
  })
})
