// =============================================================================
// Tests for the bench's headless diagnostics (agent-runtime plan item 1).
// =============================================================================

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, describe, test } from 'node:test'

import { createHeadlessDiagnostics, parseSvelteCheckMachine, svelteCheckBin } from './headless-diagnostics.ts'

const made: string[] = []
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})
function workspace(files: Record<string, string>): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ys-diag-')))
  made.push(root)
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), text)
  }
  return root
}

describe('headless diagnostics: TypeScript', () => {
  test('a type error in a .ts file is reported with its place, and goes when it is fixed', async () => {
    const root = workspace({
      'src/total.ts': 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0)\n}\n',
      'src/main.ts': "import { total } from './total'\nconst label: string = total([1, 2])\nconsole.log(label)\n",
    })
    const d = createHeadlessDiagnostics(root)
    assert.equal(d.checker, 'typescript')
    const records = d.records()
    assert.equal(records.length, 1, JSON.stringify(records))
    assert.deepEqual([path.basename(records[0]!.file), records[0]!.line, records[0]!.severity, records[0]!.code], ['main.ts', 2, 'error', '2322'])
    const report = await d.afterWrite([path.join(root, 'src', 'main.ts')])
    assert.match(report ?? '', /1 error.*src[\\/]main\.ts:2:7 \(ts 2322\): Type 'number' is not assignable to type 'string'/s)
    // Fixed: the next check sees the change.
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), "import { total } from './total'\nconst label: string = String(total([1, 2]))\nconsole.log(label)\n")
    const later = new Date(Date.now() + 5_000)
    fs.utimesSync(path.join(root, 'src', 'main.ts'), later, later)
    assert.deepEqual(d.records(), [])
  })

  test('plain JavaScript is only checked for syntax, as in the editor', () => {
    const root = workspace({ 'a.js': 'const n = 1\nn.toUpperCase()\n', 'b.js': 'function (\n' })
    const records = createHeadlessDiagnostics(root).records()
    assert.deepEqual([...new Set(records.map((r) => path.basename(r.file)))], ['b.js'])
  })

  test('the workspace tsconfig decides the options (here: noImplicitAny off)', () => {
    const root = workspace({ 'tsconfig.json': '{ "compilerOptions": { "strict": false }, "include": ["src"] }', 'src/a.ts': 'export function f(x) { return x }\n' })
    assert.deepEqual(createHeadlessDiagnostics(root).records(), [])
  })
})

describe('headless diagnostics: svelte-check', () => {
  test('its machine output becomes records with 1-based places', () => {
    const out = [
      '1795548587900 START "E:\\\\work\\\\app"',
      '1795548587901 ERROR "src\\\\routes\\\\+page.svelte" 12:5 "Cannot assign to constant\\nhttps://svelte.dev/e/constant_assignment"',
      '1795548587901 WARNING "src/lib/Card.svelte" 3:1 "Unused CSS selector \\".x\\""',
      '1795548587902 COMPLETED 10 FILES 1 ERRORS 1 WARNINGS 2 FILES_WITH_PROBLEMS',
    ].join('\n')
    const root = path.resolve('/work/app')
    const records = parseSvelteCheckMachine(out, root)
    assert.equal(records.length, 2)
    assert.deepEqual([records[0]!.severity, records[0]!.line, records[0]!.column, records[0]!.source], ['error', 12, 5, 'svelte-check'])
    assert.equal(records[0]!.file, path.resolve(root, 'src\\routes\\+page.svelte'))
    assert.match(records[0]!.message, /^Cannot assign to constant\n/)
    assert.equal(records[1]!.message, 'Unused CSS selector ".x"')
  })

  test('used only when the workspace depends on Svelte and has svelte-check installed', () => {
    const plain = workspace({ 'package.json': '{ "devDependencies": { "typescript": "5" } }' })
    assert.equal(svelteCheckBin(plain), null)
    const notInstalled = workspace({ 'package.json': '{ "devDependencies": { "svelte": "5" } }' })
    assert.equal(svelteCheckBin(notInstalled), null)
    const installed = workspace({
      'package.json': '{ "devDependencies": { "svelte": "5", "svelte-check": "4" } }',
      'node_modules/svelte-check/package.json': '{ "bin": { "svelte-check": "bin/svelte-check" } }',
    })
    assert.equal(svelteCheckBin(installed), path.join(installed, 'node_modules', 'svelte-check', 'bin', 'svelte-check'))
  })
})
