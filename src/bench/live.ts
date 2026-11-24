// =============================================================================
// npm run live — the quick checks against a live Nest, before the bench.
// =============================================================================
//
//   YELLOWSCRIPT_TEST_LIVE_NEST=http://127.0.0.1:19080 \
//   YELLOWSCRIPT_TEST_TOKEN=rst_... \
//   npm run live
//
// What the unit tests cannot show, because it depends on the real Nest and
// the real machine:
//
// 1. /props reaches llama-server through the gateway and reports n_ctx.
// 2. An oversized request comes back as exceed_context_size_error with n_ctx,
//    so the loop's trim-and-retry has the numbers it needs.
// 3. One real tool round trip: the model reads a file and reports a word in it.
// 4. A real dev server starts in the background, ys_check_page loads it (and
//    runs steps and an eval on it), and
//    stopping it ends the whole process tree (the port is free again).
//
// Exits 0 when every check passed. Without the two variables it says so and
// exits 0, like `npm run smoke`, so it is safe in CI.
// =============================================================================

import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { NestClient } from '../nest/client.ts'
import { NestHttpError } from '../nest/types.ts'
import { runAgentLoop } from '../agent/loop.ts'
import { ContextTracker } from '../agent/context-budget.ts'
import { createToolRegistry } from '../tools/registry.ts'
import { BackgroundProcesses } from '../tools/background-processes.ts'
import { createCheckPageTool, findBrowser } from '../tools/browser-check.ts'

const baseUrl = process.env.YELLOWSCRIPT_TEST_LIVE_NEST
const token = process.env.YELLOWSCRIPT_TEST_TOKEN
if (!baseUrl || !token) {
  console.log('YELLOWSCRIPT_TEST_LIVE_NEST and YELLOWSCRIPT_TEST_TOKEN are not both set — skipping the live checks.')
  process.exit(0)
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const client = new NestClient(baseUrl, { timeoutMs: 300_000 })
client.setCredential({ kind: 'apiKey', key: token })

const results: Array<{ name: string; pass: boolean }> = []
async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  const started = Date.now()
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}  ${((Date.now() - started) / 1000).toFixed(1)}s`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err instanceof Error ? err.message : String(err)}`)
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

console.log(`\nlive checks against ${baseUrl}\n`)
let nCtx: number | null = null

await check('/props reports the context window', async () => {
  const props = await client.props()
  assert(props.nCtx, 'no n_ctx in /props (default_generation_settings.n_ctx)')
  nCtx = props.nCtx
  return `n_ctx ${props.nCtx}, vision ${props.vision}`
})

await check('an oversized request is refused with the window size', async () => {
  const size = (nCtx ?? 32_768) * 5
  try {
    await client.streamChatCompletion({ messages: [{ role: 'user', content: 'word '.repeat(Math.ceil(size / 5)) }], max_tokens: 1 } as never, {})
  } catch (err) {
    assert(err instanceof NestHttpError, `failed with ${String(err)}`)
    assert(err.contextExceeded, `HTTP ${err.status} without exceed_context_size_error numbers: ${err.message}`)
    return `HTTP ${err.status}, n_ctx ${err.contextExceeded.nCtx}, prompt ${err.contextExceeded.promptTokens ?? '?'}`
  }
  throw new Error('a prompt five times the window was accepted')
})

await check('a real tool round trip', async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ys-live-')))
  try {
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'The password is GIRDER-7.\n')
    const tools = createToolRegistry({
      ripgrepPath: null,
      diagnostics: () => [],
      editorState: () => ({ activeFile: null, languageId: null, isDirty: false, cursor: null, selection: null, openFiles: [] }),
    })
    const result = await runAgentLoop({
      client,
      request: { messages: [{ role: 'user', content: 'Read secret.txt with ys_read_file and tell me the password, nothing else.' }] },
      tools,
      toolContext: { workspaceRoots: [dir] },
      maxIterations: 6,
      context: new ContextTracker(client),
    })
    const read = result.toolRuns.some((r) => r.call.function.name === 'ys_read_file' && !r.result.isError)
    assert(read, `no successful ys_read_file (calls: ${result.toolRuns.map((r) => r.call.function.name).join(', ') || 'none'})`)
    assert(/GIRDER-7/.test(result.content), `the answer does not have the password: ${result.content.slice(0, 200)}`)
    const recovered = result.toolRuns.filter((r) => r.recovered).length
    return `${result.iterations} turns, model ${result.model ?? '?'}${recovered ? `, ${recovered} call(s) recovered from text` : ''}`
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** True when nothing is listening on the port. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(true))
  })
}

await check('a background dev server: start, check the page, stop the tree', async () => {
  const site = path.join(ROOT, 'bench', 'tasks', 'dev-server-fix', 'workspace')
  const port = 4317
  assert(await portFree(port), `port ${port} is already in use`)
  const processes = new BackgroundProcesses()
  const started = processes.start('node server.js', site)
  try {
    const first = await processes.output(started.id, { waitMs: 5_000 })
    assert(first?.text.includes('serving on'), `the server did not come up: ${first?.text ?? ''}`)
    const browser = findBrowser()
    assert(browser, 'no Chrome, Edge or Chromium found')
    const page = await createCheckPageTool({ browser: () => browser, screenshotDir: () => null }).execute(
      { target: `http://localhost:${port}/`, wait_s: 1 },
      { workspaceRoots: [site] },
    )
    // The fixture page has a bug on purpose: the check must see it.
    assert(/title "Barrel Club"/.test(page.content), `page not loaded: ${page.content.slice(0, 200)}`)
    assert(/\[exception\].*renderScore/.test(page.content), 'the page error was not reported')
    // Steps and eval on the real browser: the heading is there, the list the
    // bug leaves empty is empty.
    const stepped = await createCheckPageTool({ browser: () => browser, screenshotDir: () => null }).execute(
      { target: `http://localhost:${port}/`, wait_s: 0, steps: [{ inspect: 'h1' }, { click: 'h1' }], eval: "document.querySelectorAll('#scores li').length" },
      { workspaceRoots: [site] },
    )
    assert(/--- inspect h1 ---\n.*visible/.test(stepped.content), `inspect did not run: ${stepped.content.slice(0, 300)}`)
    assert(/--- eval ---\n0\b/.test(stepped.content), `eval did not read the empty list: ${stepped.content.slice(0, 300)}`)
  } finally {
    processes.stop(started.id)
  }
  for (let i = 0; i < 50 && !(await portFree(port)); i++) await new Promise((r) => setTimeout(r, 100))
  assert(await portFree(port), `port ${port} still answers after stop: the process tree was not ended`)
  return 'served, page error seen, port free after stop'
})

const failed = results.filter((r) => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} passed\n`)
process.exit(failed ? 1 : 0)
