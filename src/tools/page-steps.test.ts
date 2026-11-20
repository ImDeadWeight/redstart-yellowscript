import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'

import { MAX_STEPS, describeStep, keyEvent, parseSteps, parseViewport } from './page-steps.ts'
import { createCheckPageTool, findBrowser } from './browser-check.ts'

describe('parseSteps', () => {
  test('each kind of step', () => {
    const parsed = parseSteps([
      { key: 'ArrowRight', hold_ms: 800 },
      { key: 'Space' },
      { wait_ms: 500 },
      { screenshot: 'after jump' },
      { click: '#start' },
      { click: [120, 80] },
      { type: 'hello', into: 'input[name=q]' },
      { wait_for: '.results li' },
      { inspect: 'header' },
    ])
    assert.ok('steps' in parsed)
    if ('steps' in parsed) {
      assert.deepEqual(parsed.steps.map(describeStep), [
        'key ArrowRight (800ms)', 'key Space', 'wait 500ms', 'screenshot "after-jump"', 'click "#start"', 'click [120, 80]',
        'type "hello" into "input[name=q]"', 'wait_for ".results li"', 'inspect "header"',
      ])
    }
  })

  test('caps waits, and refuses what it cannot run, saying why', () => {
    const capped = parseSteps([{ wait_ms: 60_000 }])
    assert.ok('steps' in capped && 'waitMs' in capped.steps[0]! && capped.steps[0].waitMs === 5_000)
    const bad: [unknown, RegExp][] = [
      ['press space', /must be an array/],
      [[{}], /exactly one of/],
      [[{ key: 'Space', click: '#a' }], /exactly one of .* it has key, click/],
      [[{ key: 'Hyperspace' }], /unknown key/],
      [[{ click: 5 }], /CSS selector or \[x, y\]/],
      [[{ type: 'x', into: 3 }], /"into" takes a CSS selector/],
      [Array.from({ length: MAX_STEPS + 1 }, () => ({ wait_ms: 1 })), /At most 20 steps/],
    ]
    for (const [raw, message] of bad) {
      const parsed = parseSteps(raw)
      assert.ok('error' in parsed, JSON.stringify(raw))
      if ('error' in parsed) assert.match(parsed.error, message)
    }
  })

  test('no steps is fine', () => {
    assert.deepEqual(parseSteps(undefined), { steps: [] })
  })
})

describe('parseViewport and keyEvent', () => {
  test('viewport', () => {
    assert.deepEqual(parseViewport('390x844'), { width: 390, height: 844, mobile: true })
    assert.deepEqual(parseViewport('1280x800'), { width: 1280, height: 800, mobile: false })
    assert.equal(parseViewport(undefined), null)
    assert.ok('error' in (parseViewport('big') as object))
    assert.ok('error' in (parseViewport('100x100') as object))
  })

  test('keys', () => {
    assert.deepEqual(keyEvent('Space'), { key: ' ', code: 'Space', keyCode: 32, text: ' ' })
    assert.deepEqual(keyEvent('ArrowLeft'), { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 })
    assert.deepEqual(keyEvent('a'), { key: 'a', code: 'KeyA', keyCode: 65, text: 'a' })
    assert.deepEqual(keyEvent('KeyW'), { key: 'w', code: 'KeyW', keyCode: 87, text: 'w' })
    assert.equal(keyEvent('Hyperspace'), null)
  })
})

const browser = findBrowser()

describe('steps in a real headless browser', { skip: browser ? false : 'no Chrome, Edge or Chromium on this machine' }, () => {
  const page = `<!doctype html><title>Steps</title>
<header style="position: sticky; top: 0; color: rgb(255, 0, 0)">Barrel Run</header>
<canvas width="200" height="100"></canvas>
<button id="boom">Boom</button>
<input name="q"><button id="go">Go</button><ul class="results"></ul>
<script>
  window.__game = { player: { x: 0, jumping: false }, score: 0 };
  addEventListener('keydown', (e) => {
    if (e.code === 'ArrowRight') window.__game.player.x += 1;
    if (e.code === 'Space') window.__game.player.jumping = true;
  });
  document.getElementById('boom').addEventListener('click', () => { throw new Error('boom handler broke') });
  document.getElementById('go').addEventListener('click', () => {
    const q = document.querySelector('input[name=q]').value;
    setTimeout(() => { document.querySelector('.results').innerHTML = '<li>' + q + '</li>' }, 200);
  });
</script>`
  const withServer = async (run: (url: string) => Promise<void>) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(page)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    try {
      await run(`http://127.0.0.1:${(server.address() as { port: number }).port}/`)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  }
  const tool = createCheckPageTool({ browser: () => browser, screenshotDir: () => null })
  const ctx = { workspaceRoots: [process.cwd()] }

  test('keys move the game, a click that throws is tied to its step, eval reads the state', async () => {
    await withServer(async (url) => {
      const result = await tool.execute({
        target: url,
        wait_s: 0,
        steps: [{ key: 'ArrowRight' }, { key: 'ArrowRight' }, { key: 'Space' }, { click: '#boom' }, { inspect: 'header' }],
        eval: 'window.__game.player',
        viewport: '390x844',
      }, ctx)
      assert.equal(result.isError, false, result.content)
      assert.match(result.content, /at 390x844 \(mobile\)/)
      assert.match(result.content, /--- steps ---\n1\. key ArrowRight — ok/)
      assert.match(result.content, /\[exception\] \(after step 4\) .*boom handler broke/)
      assert.match(result.content, /--- eval ---\n\{"x":2,"jumping":true\}/)
      assert.match(result.content, /--- inspect header ---\n.*visible · position sticky .*color rgb\(255, 0, 0\)/)
      assert.match(result.content, /text: Barrel Run/)
    })
  })

  test('a form: type, click, wait for the result', async () => {
    await withServer(async (url) => {
      const result = await tool.execute({
        target: url,
        wait_s: 0,
        steps: [{ type: 'barrels', into: 'input[name=q]' }, { click: '#go' }, { wait_for: '.results li' }],
        eval: "document.querySelector('.results').innerText",
      }, ctx)
      assert.match(result.content, /3\. wait_for "\.results li" — ok/)
      assert.match(result.content, /--- eval ---\n"barrels"/)
    })
  })

  test('a failed step says which, and stops the rest', async () => {
    await withServer(async (url) => {
      const result = await tool.execute({ target: url, wait_s: 0, steps: [{ click: '#missing' }, { key: 'Space' }] }, ctx)
      assert.match(result.content, /Step 1 \(click "#missing"\) failed: no element matches "#missing"\. The steps after it did not run\./)
      assert.doesNotMatch(result.content, /key Space/)
      assert.equal(result.summary, 'ys_check_page — a step failed')
      assert.equal(result.effect?.kind === 'check' && result.effect.first, 'step click "#missing" failed: no element matches "#missing"')
    })
  })

  test('an eval that throws says so', async () => {
    await withServer(async (url) => {
      const result = await tool.execute({ target: url, wait_s: 0, eval: 'window.__nothing.x' }, ctx)
      assert.match(result.content, /--- eval ---\nthrew: TypeError/)
    })
  })
})
