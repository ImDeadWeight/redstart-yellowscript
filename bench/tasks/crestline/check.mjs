// Crestline (agent-runtime plan item 2): the hand-run SvelteKit prompt that
// stalled Ornith 1.5, as a repeatable task. Scored on what the person asked
// for: the check, the tests and the build all pass, the page renders the
// services the load provides (it read `data.items`, which the load never
// returned), and the estimator is there.
//
// Needs the prepared node_modules (`npm run bench:cache`): it runs the
// workspace's own svelte-check, vitest and vite.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import { checkPageHeadless, exists, expect, pass, read, run, workspace } from '../_lib/check.mjs'

/** A package's bin script in the workspace's node_modules. */
function bin(pkg, name = pkg.split('/').pop()) {
  const dir = path.join(workspace, 'node_modules', ...pkg.split('/'))
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[name]
  return path.join(dir, rel)
}
const node = (script, args, options = {}) => run(process.execPath, [script, ...args], { timeout: 300_000, ...options })
const tail = (r) => `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-12).join('\n')

expect(exists('node_modules/@sveltejs/kit'), 'node_modules is missing: run `npm run bench:cache` before this task')

for (const f of ['src/lib/quote.ts', 'src/lib/quote.test.ts', 'src/routes/+layout.svelte', 'src/routes/+page.svelte']) {
  expect(exists(f), `${f} was not written`)
}
const page = read('src/routes/+page.svelte')
expect(/\$state\b/.test(page) && /\$derived\b/.test(page), 'the page does not use $state and $derived')
const tests = read('src/lib/quote.test.ts')
expect((tests.match(/\b(it|test)\s*\(/g) ?? []).length >= 3, 'quote.test.ts has fewer than three tests')

const sync = node(bin('@sveltejs/kit', 'svelte-kit'), ['sync'])
expect(sync.status === 0, `svelte-kit sync failed:\n${tail(sync)}`)
const check = node(bin('svelte-check'), ['--tsconfig', './tsconfig.json', '--threshold', 'error'])
expect(check.status === 0, `svelte-check reports errors:\n${tail(check)}`)
const vitest = node(bin('vitest'), ['run'])
expect(vitest.status === 0, `vitest run fails:\n${tail(vitest)}`)
const build = node(bin('vite'), ['build'])
expect(build.status === 0, `vite build fails:\n${tail(build)}`)

// The built app, served: the services and the estimator are on the page.
const port = await new Promise((resolve) => {
  const server = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => resolve(port))
  })
})
const preview = spawn(process.execPath, [bin('vite'), 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: workspace, windowsHide: true, stdio: 'ignore' })
const stop = () => {
  if (process.platform === 'win32') run('taskkill', ['/pid', String(preview.pid), '/T', '/F'])
  else preview.kill()
}
try {
  const url = `http://127.0.0.1:${port}/`
  let html = ''
  for (let i = 0; i < 60 && !html; i++) {
    html = await fetch(url).then((r) => (r.ok ? r.text() : ''), () => '')
    if (!html) await new Promise((r) => setTimeout(r, 500))
  }
  expect(html, 'vite preview never served the page')
  for (const name of ['Office cleaning', 'Medical facility cleaning', 'Retail store cleaning', 'Warehouse cleaning']) {
    expect(html.includes(name), `the page does not list "${name}": the services still do not render`)
  }
  for (const preset of ['Small Office', 'Medical Clinic']) expect(html.includes(preset), `no "${preset}" preset on the page`)
  // In a browser too, when this machine has one: no errors once it hydrates.
  const browser = await checkPageHeadless(url).catch(() => null)
  if (browser) {
    const problems = browser.events.filter((e) => e.kind === 'exception' || e.kind === 'error')
    expect(problems.length === 0, `the page reports: ${problems.map((e) => e.text).join(' | ').slice(0, 300)}`)
  }
} finally {
  stop()
}
pass('check, tests and build pass; the page lists the services and the presets')
