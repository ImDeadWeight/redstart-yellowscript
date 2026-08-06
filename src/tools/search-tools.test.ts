// =============================================================================
// ws_glob and ws_grep.
// =============================================================================
// The degraded (no-ripgrep) path is pure Node, so it is exercised on every
// machine and is where the behavioural assertions live.
//
// The ripgrep path needs the binary, which only exists inside a VSCode install
// and at a location that differs by version. Those tests are therefore opt-in
// via YELLOWSCRIPT_TEST_RIPGREP=<path to rg>, following the same convention as
// npm run smoke — a suite that silently passes because it skipped is worse than
// one that is honestly conditional.
//
//   YELLOWSCRIPT_TEST_RIPGREP="C:/…/@vscode/ripgrep-universal/bin/win32-x64/rg.exe" npm test
// =============================================================================

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createGlobTool } from './glob.ts'
import { createGrepTool, parseRipgrepLine } from './grep.ts'
import type { ToolContext } from './types.ts'

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-search-')))
const work = path.join(base, 'work')
const outside = path.join(base, 'outside')

fs.mkdirSync(path.join(work, 'src', 'deep'), { recursive: true })
fs.mkdirSync(path.join(work, 'node_modules', 'pkg'), { recursive: true })
fs.mkdirSync(outside, { recursive: true })
fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules/\nignored.ts\n')
fs.writeFileSync(path.join(work, 'root.ts'), 'export const root = 1\n')
fs.writeFileSync(path.join(work, 'ignored.ts'), 'export const SENTINEL = "ignored"\n')
fs.writeFileSync(path.join(work, 'src', 'a.ts'), 'alpha\nexport const SENTINEL = 1\nomega\n')
fs.writeFileSync(path.join(work, 'src', 'deep', 'b.ts'), 'deep SENTINEL here\n')
fs.writeFileSync(path.join(work, 'src', 'notes.md'), 'SENTINEL in markdown\n')
fs.writeFileSync(path.join(work, 'node_modules', 'pkg', 'index.js'), 'vendored SENTINEL\n')
fs.writeFileSync(path.join(outside, 'secret.txt'), 'SENTINEL classified')

after(() => fs.rmSync(base, { recursive: true, force: true }))

const ctx: ToolContext = { workspaceRoots: [work] }

// --- Degraded mode (no ripgrep) ---------------------------------------------

describe('ws_glob — degraded mode', () => {
  const tool = createGlobTool(null)

  test('says in its description that .gitignore is not applied', () => {
    assert.match(tool.definition.description, /gitignore is not being applied/)
  })

  test('finds files by pattern across directories', async () => {
    const result = await tool.execute({ pattern: '**/*.ts' }, ctx)
    assert.equal(result.isError, false)
    assert.match(result.content, /src\/a\.ts/)
    assert.match(result.content, /src\/deep\/b\.ts/)
    assert.match(result.content, /root\.ts/)
  })

  test('a segment-scoped pattern does not cross directories', async () => {
    const result = await tool.execute({ pattern: '*.ts' }, ctx)
    assert.match(result.content, /root\.ts/)
    assert.ok(!result.content.includes('src/a.ts'))
  })

  test('skips node_modules even without .gitignore support', async () => {
    const result = await tool.execute({ pattern: '**/*.js' }, ctx)
    assert.ok(!result.content.includes('node_modules'))
  })

  test('announces the degradation in its output', async () => {
    const result = await tool.execute({ pattern: '**/*.ts' }, ctx)
    assert.match(result.content, /ripgrep unavailable/)
  })

  test('scopes to a subdirectory when given one', async () => {
    const result = await tool.execute({ pattern: '**/*.ts', path: 'src' }, ctx)
    assert.match(result.content, /a\.ts/)
    assert.ok(!result.content.includes('root.ts'))
  })

  test('reports no matches without calling it an error', async () => {
    const result = await tool.execute({ pattern: '**/*.rs' }, ctx)
    assert.equal(result.isError, false)
    assert.match(result.content, /No files match/)
  })

  test('refuses a negated pattern rather than returning everything else', async () => {
    const result = await tool.execute({ pattern: '!*.ts' }, ctx)
    assert.equal(result.isError, true)
    assert.match(result.content, /cannot start with "!"/)
  })

  test('requires a pattern', async () => {
    assert.equal((await tool.execute({}, ctx)).isError, true)
    assert.equal((await tool.execute({ pattern: '  ' }, ctx)).isError, true)
  })

  test('refuses a scope outside the workspace', async () => {
    const result = await tool.execute({ pattern: '*', path: '../outside' }, ctx)
    assert.equal(result.isError, true)
    assert.match(result.content, /outside the workspace/)
  })

  test('reports an empty workspace as such', async () => {
    const result = await tool.execute({ pattern: '*' }, { workspaceRoots: [] })
    assert.equal(result.isError, true)
    assert.match(result.content, /No workspace folder is open/)
  })
})

describe('ws_grep — degraded mode', () => {
  const tool = createGrepTool(null)

  test('advertises literal-only search, not regex it cannot run', () => {
    assert.match(tool.definition.description, /LITERAL substring/)
    assert.ok(!/Rust regex/.test(tool.definition.description))
  })

  test('finds matches and groups them by file', async () => {
    const result = await tool.execute({ pattern: 'SENTINEL' }, ctx)
    assert.equal(result.isError, false)
    assert.match(result.content, /src\/a\.ts\n\s+2: export const SENTINEL = 1/)
  })

  test('treats the pattern literally — a regex must not match', async () => {
    // The reason the fallback is literal-only: an unabortable JS regex on the
    // extension host is the hazard ripgrep was chosen to avoid.
    const result = await tool.execute({ pattern: 'SENT.NEL' }, ctx)
    assert.match(result.content, /No matches/)
  })

  test('is case-insensitive by default and exact when asked', async () => {
    assert.match((await tool.execute({ pattern: 'sentinel' }, ctx)).content, /a\.ts/)
    const exact = await tool.execute({ pattern: 'sentinel', caseSensitive: true }, ctx)
    assert.match(exact.content, /No matches/)
  })

  test('filters by file glob', async () => {
    const result = await tool.execute({ pattern: 'SENTINEL', glob: '*.md' }, ctx)
    assert.match(result.content, /notes\.md/)
    assert.ok(!result.content.includes('a.ts'))
  })

  test('never reaches outside the workspace', async () => {
    const result = await tool.execute({ pattern: 'classified' }, ctx)
    assert.ok(!result.content.includes('secret.txt'))
  })

  test('requires a pattern', async () => {
    assert.equal((await tool.execute({}, ctx)).isError, true)
    assert.equal((await tool.execute({ pattern: '' }, ctx)).isError, true)
  })

  test('reports an empty workspace as such', async () => {
    const result = await tool.execute({ pattern: 'x' }, { workspaceRoots: [] })
    assert.equal(result.isError, true)
    assert.match(result.content, /No workspace folder is open/)
  })
})

describe('parseRipgrepLine', () => {
  test('reads path, line and text', () => {
    assert.deepEqual(parseRipgrepLine('src/a.ts:12:const x = 1'), {
      file: 'src/a.ts',
      line: 12,
      text: 'const x = 1',
    })
  })

  test('a colon in the matched text is not mistaken for the delimiter', () => {
    // "a.ts:5:foo: bar" is line 5 of a.ts, not a file named "a.ts:5:foo".
    assert.deepEqual(parseRipgrepLine('a.ts:5:foo: bar'), {
      file: 'a.ts',
      line: 5,
      text: 'foo: bar',
    })
  })

  test('normalises Windows separators', () => {
    assert.equal(parseRipgrepLine('src\\deep\\b.ts:3:x')?.file, 'src/deep/b.ts')
  })

  test('strips the "./" that rg prefixes when given "." as its search path', () => {
    // Left in, it is noise in the output and makes an anchored path filter
    // such as "src/**/*.ts" fail to match anything.
    assert.equal(parseRipgrepLine('./src/a.ts:3:x')?.file, 'src/a.ts')
    assert.equal(parseRipgrepLine('.\\src\\a.ts:3:x')?.file, 'src/a.ts')
  })

  test('ignores lines that are not records', () => {
    assert.equal(parseRipgrepLine(''), null)
    assert.equal(parseRipgrepLine('not a match line'), null)
  })
})

// --- Real ripgrep (opt-in) --------------------------------------------------

const RG = process.env.YELLOWSCRIPT_TEST_RIPGREP
const skipRg = RG ? false : 'set YELLOWSCRIPT_TEST_RIPGREP to run these'

describe('ws_glob — ripgrep', { skip: skipRg }, () => {
  test('honours .gitignore, which is the whole reason for using ripgrep', async () => {
    const result = await createGlobTool(RG as string).execute({ pattern: '**/*.ts' }, ctx)
    assert.equal(result.isError, false)
    assert.match(result.content, /src\/a\.ts/)
    // Both are ignored by the fixture's .gitignore.
    assert.ok(!result.content.includes('node_modules'), 'returned ignored vendored files')
    assert.ok(!result.content.includes('ignored.ts'), 'returned a gitignored file')
  })

  test('does not announce degradation when the real engine is in use', async () => {
    const result = await createGlobTool(RG as string).execute({ pattern: '**/*.ts' }, ctx)
    assert.ok(!result.content.includes('ripgrep unavailable'))
  })
})

describe('ws_grep — ripgrep', { skip: skipRg }, () => {
  test('runs a real regex', async () => {
    const result = await createGrepTool(RG as string).execute({ pattern: 'SENT.NEL' }, ctx)
    assert.equal(result.isError, false)
    assert.match(result.content, /a\.ts/)
  })

  test('honours .gitignore', async () => {
    const result = await createGrepTool(RG as string).execute({ pattern: 'SENTINEL' }, ctx)
    assert.ok(!result.content.includes('node_modules'))
    assert.ok(!result.content.includes('ignored.ts'))
  })

  test('a file filter does NOT re-admit gitignored files', async () => {
    // Regression guard for ripgrep precedence: a command-line --glob outranks
    // .gitignore, so passing the filter through as `-g '*.ts'` re-admits every
    // ignored .ts file — in a real repo that is every .d.ts in node_modules.
    // The filter goes in as a --type instead. If someone "simplifies" this back
    // to --glob, this test is what catches it.
    const result = await createGrepTool(RG as string).execute(
      { pattern: 'SENTINEL', glob: '*.ts' },
      ctx,
    )
    assert.match(result.content, /src\/a\.ts/, 'should still find the tracked match')
    assert.ok(!result.content.includes('ignored.ts'), 'a gitignored file came back')
    assert.ok(!result.content.includes('node_modules'), 'vendored code came back')
  })

  test('a path-shaped file filter is applied without breaking type syntax', async () => {
    const result = await createGrepTool(RG as string).execute(
      { pattern: 'SENTINEL', glob: 'src/**/*.ts' },
      ctx,
    )
    assert.equal(result.isError, false)
    assert.match(result.content, /src\/a\.ts/)
    assert.ok(!result.content.includes('notes.md'))
  })

  test('literal mode disables the regex', async () => {
    const result = await createGrepTool(RG as string).execute(
      { pattern: 'SENT.NEL', literal: true },
      ctx,
    )
    assert.match(result.content, /No matches/)
  })

  test('a pattern beginning with a dash is a pattern, not a flag', async () => {
    // Guards the `--` separator in the argv.
    const result = await createGrepTool(RG as string).execute({ pattern: '-alpha' }, ctx)
    assert.equal(result.isError, false)
  })

  test('an invalid regex comes back as a correctable error, not a crash', async () => {
    const result = await createGrepTool(RG as string).execute({ pattern: '(unclosed' }, ctx)
    assert.equal(result.isError, true)
    assert.match(result.content, /Search failed/)
  })

  test('no matches is not an error — rg exit code 1', async () => {
    const result = await createGrepTool(RG as string).execute({ pattern: 'zzz-absent-zzz' }, ctx)
    assert.equal(result.isError, false)
    assert.match(result.content, /No matches/)
  })
})
