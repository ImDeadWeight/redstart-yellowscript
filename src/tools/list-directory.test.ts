import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { listDirectoryTool, MAX_ENTRIES } from './list-directory.ts'
import type { ToolContext } from './types.ts'

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-list-')))
const work = path.join(base, 'work')
const outside = path.join(base, 'outside')

fs.mkdirSync(path.join(work, 'src'), { recursive: true })
fs.mkdirSync(path.join(work, 'assets'), { recursive: true })
fs.mkdirSync(path.join(work, 'empty-dir'), { recursive: true })
fs.mkdirSync(path.join(work, 'crowded'), { recursive: true })
fs.mkdirSync(outside, { recursive: true })
fs.writeFileSync(path.join(work, 'readme.md'), '# hi\n')
fs.writeFileSync(path.join(work, 'app.ts'), 'x'.repeat(2_048))
fs.writeFileSync(path.join(outside, 'secret.txt'), 'classified')
for (let i = 0; i < MAX_ENTRIES + 25; i++) {
  fs.writeFileSync(path.join(work, 'crowded', `f${String(i).padStart(4, '0')}.txt`), '')
}

after(() => fs.rmSync(base, { recursive: true, force: true }))

const ctx: ToolContext = { workspaceRoots: [work] }
const run = (args: unknown, context: ToolContext = ctx) => listDirectoryTool.execute(args, context)

describe('ws_list_directory — definition', () => {
  test('is ws_-prefixed so it cannot collide with the Nest filesystem server', () => {
    assert.equal(listDirectoryTool.definition.name, 'ws_list_directory')
  })

  test('requires no arguments — listing the root is the common case', () => {
    assert.deepEqual(listDirectoryTool.definition.inputSchema.required, [])
  })
})

describe('ws_list_directory — listing', () => {
  test('lists the workspace root when no path is given', async () => {
    const result = await run({})
    assert.equal(result.isError, false)
    assert.match(result.content, /readme\.md/)
    assert.match(result.content, /src\//)
  })

  test('treats an absent path the same as "."', async () => {
    const withDot = await run({ path: '.' })
    const without = await run({})
    assert.equal(withDot.content, without.content)
  })

  test('marks directories with a trailing slash and files with a size', async () => {
    const result = await run({})
    assert.match(result.content, /src\/$/m)
    assert.match(result.content, /app\.ts\s+2\.0 KB/)
  })

  test('orders directories first, then files, each alphabetical', async () => {
    // A stable order keeps a repeated call byte-identical, which is what lets
    // prompt caching hold across turns.
    const result = await run({})
    const body = result.content
    assert.ok(body.indexOf('assets/') < body.indexOf('src/'), 'directories not alphabetical')
    assert.ok(body.indexOf('src/') < body.indexOf('app.ts'), 'files not after directories')
    assert.ok(body.indexOf('app.ts') < body.indexOf('readme.md'), 'files not alphabetical')
  })

  test('reports the entry count', async () => {
    const result = await run({ path: 'src' })
    assert.match(result.content, /\(0 entries\)|is empty/)
  })

  test('reports an empty directory rather than returning a bare header', async () => {
    const result = await run({ path: 'empty-dir' })
    assert.equal(result.isError, false)
    assert.match(result.content, /empty/)
  })

  test('renders the path workspace-relative, never absolute', async () => {
    const result = await run({ path: 'src' })
    assert.ok(!result.content.includes(work))
  })

  test('caps a crowded directory and says how many were withheld', async () => {
    const result = await run({ path: 'crowded' })
    assert.equal(result.isError, false)
    assert.equal(result.truncated, true)
    assert.match(result.content, /25 more entries not shown/)
    // The count still tells the truth about how big it is.
    assert.match(result.content, new RegExp(`\\(${MAX_ENTRIES + 25} entries\\)`))
  })
})

describe('ws_list_directory — refusals return results, never throw', () => {
  test('a directory that does not exist', async () => {
    const result = await run({ path: 'nope' })
    assert.equal(result.isError, true)
    assert.match(result.content, /does not exist/)
  })

  test('a file, pointing at the right tool instead', async () => {
    const result = await run({ path: 'readme.md' })
    assert.equal(result.isError, true)
    assert.match(result.content, /ws_read_file/)
  })

  test('a path escaping the workspace', async () => {
    const result = await run({ path: '../outside' })
    assert.equal(result.isError, true)
    assert.match(result.content, /outside the workspace/)
    assert.ok(!result.content.includes('secret.txt'))
  })

  test('no workspace open is reported as such, not as an escape attempt', async () => {
    const result = await run({}, { workspaceRoots: [] })
    assert.equal(result.isError, true)
    assert.match(result.content, /No workspace folder is open/)
  })

  test('an already-aborted signal cancels', async () => {
    const result = await run({}, { workspaceRoots: [work], signal: AbortSignal.abort() })
    assert.equal(result.isError, true)
    assert.match(result.content, /cancelled/)
  })
})
