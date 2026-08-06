import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { globToRegExp, walkFiles, literalSearch, SKIPPED_DIRECTORIES } from './fallback-search.ts'

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-fallback-')))
fs.mkdirSync(path.join(base, 'src', 'deep'), { recursive: true })
fs.mkdirSync(path.join(base, 'node_modules', 'pkg'), { recursive: true })
fs.mkdirSync(path.join(base, '.git'), { recursive: true })
fs.writeFileSync(path.join(base, 'root.ts'), 'const root = 1\nNEEDLE here\n')
fs.writeFileSync(path.join(base, 'src', 'a.ts'), 'alpha\nneedle in a\nomega\n')
fs.writeFileSync(path.join(base, 'src', 'deep', 'b.js'), 'deep needle\n')
fs.writeFileSync(path.join(base, 'src', 'notes.md'), 'no match here\n')
fs.writeFileSync(path.join(base, 'node_modules', 'pkg', 'index.js'), 'needle in vendored code\n')
fs.writeFileSync(path.join(base, '.git', 'config'), 'needle in git\n')
fs.writeFileSync(path.join(base, 'binary.bin'), Buffer.from([0x6e, 0x00, 0x65]))

after(() => fs.rmSync(base, { recursive: true, force: true }))

describe('globToRegExp', () => {
  const matches = (glob: string, file: string): boolean => globToRegExp(glob).test(file)

  test('* stays within one path segment', () => {
    assert.ok(matches('*.ts', 'a.ts'))
    assert.ok(!matches('*.ts', 'src/a.ts'))
  })

  test('**/ crosses segments and also matches zero directories', () => {
    // "**/*.ts" finding only nested files is the classic off-by-one here.
    assert.ok(matches('**/*.ts', 'a.ts'))
    assert.ok(matches('**/*.ts', 'src/a.ts'))
    assert.ok(matches('**/*.ts', 'src/deep/a.ts'))
  })

  test('a rooted ** matches at any depth below the prefix', () => {
    assert.ok(matches('src/**/*.ts', 'src/a.ts'))
    assert.ok(matches('src/**/*.ts', 'src/deep/a.ts'))
    assert.ok(!matches('src/**/*.ts', 'lib/a.ts'))
  })

  test('? matches exactly one non-separator character', () => {
    assert.ok(matches('?.ts', 'a.ts'))
    assert.ok(!matches('?.ts', 'ab.ts'))
    assert.ok(!matches('?.ts', '/.ts'))
  })

  test('regex metacharacters in the glob are literal', () => {
    assert.ok(matches('a.ts', 'a.ts'))
    assert.ok(!matches('a.ts', 'axts'), 'the dot was treated as a regex wildcard')
    assert.ok(matches('file(1).txt', 'file(1).txt'))
  })

  test('a bare ** matches everything', () => {
    assert.ok(matches('**', 'a.ts'))
    assert.ok(matches('**', 'src/deep/b.js'))
  })

  test('the pattern is anchored at both ends', () => {
    assert.ok(!matches('*.ts', 'a.ts.bak'))
    assert.ok(!matches('src/*.ts', 'lib/src/a.ts'))
  })
})

describe('walkFiles', () => {
  test('returns nested files with POSIX separators on every platform', async () => {
    const { files } = await walkFiles(base)
    assert.ok(files.includes('src/deep/b.js'), `got: ${files.join(', ')}`)
    assert.ok(!files.some((f) => f.includes('\\')))
  })

  test('skips the heavy directories that would otherwise dominate', async () => {
    const { files } = await walkFiles(base)
    assert.ok(!files.some((f) => f.startsWith('node_modules/')))
    assert.ok(!files.some((f) => f.startsWith('.git/')))
  })

  test('node_modules and .git are on the skip list', () => {
    assert.ok(SKIPPED_DIRECTORIES.has('node_modules'))
    assert.ok(SKIPPED_DIRECTORIES.has('.git'))
  })

  test('stops at the limit and says so', async () => {
    const { files, truncated } = await walkFiles(base, { limit: 2 })
    assert.equal(files.length, 2)
    assert.equal(truncated, true)
  })

  test('an aborted signal ends the walk', async () => {
    const { files } = await walkFiles(base, { signal: AbortSignal.abort() })
    assert.equal(files.length, 0)
  })
})

describe('literalSearch', () => {
  const filesIn = async (): Promise<string[]> => (await walkFiles(base)).files

  test('finds a substring and reports its 1-based line', async () => {
    const { matches } = await literalSearch(base, await filesIn(), 'needle')
    const hit = matches.find((m) => m.file === 'src/a.ts')
    assert.ok(hit, 'no match in src/a.ts')
    assert.equal(hit.line, 2)
    assert.equal(hit.text, 'needle in a')
  })

  test('is case-insensitive by default', async () => {
    const { matches } = await literalSearch(base, await filesIn(), 'needle')
    assert.ok(matches.some((m) => m.file === 'root.ts'), 'missed the upper-case NEEDLE')
  })

  test('honours case sensitivity when asked', async () => {
    const { matches } = await literalSearch(base, await filesIn(), 'NEEDLE', { caseSensitive: true })
    assert.ok(matches.every((m) => m.file === 'root.ts'))
  })

  test('treats the pattern literally, never as a regex', async () => {
    // The whole reason this path exists: a regex here would be unabortable.
    const { matches } = await literalSearch(base, await filesIn(), 'n.edle')
    assert.equal(matches.length, 0)
  })

  test('skips binary files', async () => {
    const { matches } = await literalSearch(base, await filesIn(), 'e')
    assert.ok(!matches.some((m) => m.file === 'binary.bin'))
  })

  test('stops at the limit', async () => {
    const { matches, truncated } = await literalSearch(base, await filesIn(), 'e', { limit: 2 })
    assert.equal(matches.length, 2)
    assert.equal(truncated, true)
  })
})
