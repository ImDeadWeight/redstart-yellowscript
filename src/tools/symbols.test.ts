import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createFindSymbolTool, createOutlineTool, createReferencesTool, formatOutline, regexOutline, type SymbolProvider } from './symbols.ts'
import { createReadFileTool, OUTLINE_HEAD_LINES } from './read-file.ts'
import { createTsSymbolProvider } from '../bench/ts-symbols.ts'

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-symbols-')))
after(() => fs.rmSync(root, { recursive: true, force: true }))
const at = (rel: string) => path.join(root, ...rel.split('/'))
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true })
  fs.writeFileSync(at(rel), text)
}

write('src/player.js', [
  'import { clamp } from "./util.js"',
  '',
  'export class Player {',
  '  constructor(x) {',
  '    this.x = x',
  '  }',
  '  jump() {',
  '    this.y = clamp(this.y - 10, 0, 100)',
  '  }',
  '}',
  '',
  'export function spawn() {',
  '  return new Player(0)',
  '}',
  '',
].join('\n'))
write('src/util.js', 'export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))\n')
write('src/game.js', 'import { spawn } from "./player.js"\nimport { clamp } from "./util.js"\nconst p = spawn()\np.jump()\nclamp(1, 0, 2)\n')
const ctx = { workspaceRoots: [root] }

describe('regexOutline', () => {
  test('JavaScript: functions, classes, arrow constants and methods', () => {
    const symbols = regexOutline(fs.readFileSync(at('src/player.js'), 'utf8'), 'player.js')
    assert.deepEqual(symbols.map((s) => `${s.line} ${s.kind} ${s.name}`), ['3 class Player', '4 method constructor', '7 method jump', '12 function spawn'])
    assert.deepEqual(regexOutline('export const clamp = (v) => v\nif (x) {\n  if (y) {\n', 'u.js').map((s) => s.name), ['clamp'])
  })

  test('HTML: headings and ids', () => {
    const html = '<h1>Barrel <em>Run</em></h1>\n<canvas id="game"></canvas>\n<script src="game.js"></script>\n'
    assert.deepEqual(regexOutline(html, 'index.html').map((s) => `${s.kind} ${s.name}`), ['h1 Barrel Run', 'canvas #game', 'script <script>'])
  })

  test('CSS: selectors and at-rules', () => {
    const css = 'body {\n  margin: 0;\n}\n@media (max-width: 600px) {\n  .hud, #score { display: none }\n}\n'
    assert.deepEqual(regexOutline(css, 'site.css').map((s) => `${s.line} ${s.name}`), ['1 body', '4 @media (max-width: 600px)', '5 .hud, #score'])
  })

  test('Markdown and Python', () => {
    assert.deepEqual(regexOutline('# Title\ntext\n## Part\n', 'a.md').map((s) => s.kind), ['h1', 'h2'])
    assert.deepEqual(regexOutline('class A:\n    def f(self):\n        pass\ndef g():\n', 'a.py').map((s) => `${s.kind} ${s.name}`), ['class A', 'method f', 'function g'])
  })
})

describe('formatOutline', () => {
  test('nested, with ranges, and a count past the cap', () => {
    const { text } = formatOutline([{ name: 'A', kind: 'class', line: 1, endLine: 9, children: [{ name: 'f', kind: 'method', line: 2, endLine: 4 }] }, { name: 'g', kind: 'function', line: 10 }], 2)
    assert.equal(text, '1-9 class A\n  2-4 method f\n[1 more symbols not shown]')
  })
})

/** A provider whose answers are given, for the tools' own logic. */
const fake = (over: Partial<SymbolProvider> = {}): SymbolProvider => ({
  outline: async () => [],
  workspaceSymbols: async () => [],
  references: async () => [],
  ...over,
})

describe('the symbol tools', () => {
  test('ys_outline falls back to the text when the language server has nothing', async () => {
    const result = await createOutlineTool(fake()).execute({ path: 'src/player.js' }, ctx)
    assert.match(result.content, /from the text/)
    assert.match(result.content, /12 function spawn/)
  })

  test('ys_find_symbol prefers exact names and stays in the workspace', async () => {
    const tool = createFindSymbolTool(fake({
      workspaceSymbols: async () => [
        { name: 'jumpHeight', kind: 'variable', file: at('src/player.js'), line: 1 },
        { name: 'jump', kind: 'method', file: at('src/player.js'), line: 7, container: 'Player' },
        { name: 'jump', kind: 'function', file: path.join(os.tmpdir(), 'elsewhere.js'), line: 1 },
      ],
    }))
    const result = await tool.execute({ name: 'jump' }, ctx)
    assert.equal(result.content, 'src/player.js:7 method jump (in Player)')
  })

  test('ys_references by name refuses an ambiguous name, listing the candidates', async () => {
    const tool = createReferencesTool(fake({
      workspaceSymbols: async () => [
        { name: 'update', kind: 'method', file: at('src/player.js'), line: 4 },
        { name: 'update', kind: 'function', file: at('src/game.js'), line: 3 },
      ],
    }))
    const result = await tool.execute({ name: 'update' }, ctx)
    assert.equal(result.isError, true)
    assert.match(result.content, /names 2 definitions/)
    assert.match(result.content, /src\/game\.js:3/)
  })

  test('ys_references prints each use with its line', async () => {
    const tool = createReferencesTool(fake({
      workspaceSymbols: async () => [{ name: 'spawn', kind: 'function', file: at('src/player.js'), line: 12 }],
      references: async (file, line, character) => {
        assert.equal(line, 12)
        assert.equal(character, 'export function '.length + 1)
        return [{ file: at('src/player.js'), line: 12, character: 17 }, { file: at('src/game.js'), line: 3, character: 11 }]
      },
    }))
    const result = await tool.execute({ name: 'spawn' }, ctx)
    assert.equal(result.content, '2 references in 2 files:\nsrc/player.js:12: export function spawn() {\nsrc/game.js:3: const p = spawn()')
  })
})

describe('a big file reads as its outline first (item 5)', () => {
  const big = Array.from({ length: 600 }, (_, i) => (i % 50 === 0 ? `function f${i}() {` : i % 50 === 49 ? '}' : `  // line ${i + 1}`)).join('\n')
  write('src/big.js', big)
  const read = createReadFileTool(null)

  test('over 400 lines with no offset: outline and head', async () => {
    const result = await read.execute({ path: 'src/big.js' }, ctx)
    assert.match(result.content, /^src\/big\.js \(600 lines\)/)
    assert.match(result.content, /--- outline ---\n1 function f0\n51 function f50/)
    assert.match(result.content, new RegExp(`--- lines 1-${OUTLINE_HEAD_LINES} ---`))
    assert.match(result.content, /read a range with offset and limit\.\]$/)
    assert.ok(!result.content.includes('line 300'), 'the body past the head is not sent')
  })

  test('with an offset, it reads as before', async () => {
    const result = await read.execute({ path: 'src/big.js', offset: 300, limit: 5 }, ctx)
    assert.match(result.content, /lines 300-304 of 600/)
  })
})

describe('the TypeScript provider (the bench)', () => {
  const provider = createTsSymbolProvider(root)

  test('outline', async () => {
    const symbols = await provider.outline(at('src/player.js'))
    const player = symbols.find((s) => s.name === 'Player')!
    assert.equal(player.line, 3)
    assert.equal(player.endLine, 10)
    assert.deepEqual(player.children?.map((c) => c.name), ['constructor', 'jump'])
  })

  test('definitions and references across files', async () => {
    const defs = (await provider.workspaceSymbols('clamp')).filter((s) => s.name === 'clamp')
    assert.ok(defs.some((d) => d.file === at('src/util.js') && d.line === 1))
    const refs = await provider.references(at('src/util.js'), 1, 'export const '.length + 1)
    const files = new Set(refs.map((r) => path.relative(root, r.file).replace(/\\/g, '/')))
    assert.deepEqual([...files].sort(), ['src/game.js', 'src/player.js', 'src/util.js'])
  })
})
