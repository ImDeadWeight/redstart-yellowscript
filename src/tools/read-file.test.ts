import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { readFileTool, DEFAULT_LINE_LIMIT } from './read-file.ts'
import type { ToolContext } from './types.ts'

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-read-')))
const work = path.join(base, 'work')
const outside = path.join(base, 'outside')

fs.mkdirSync(path.join(work, 'sub'), { recursive: true })
fs.mkdirSync(outside, { recursive: true })
fs.writeFileSync(path.join(work, 'a.txt'), 'first\nsecond\nthird\n')
fs.writeFileSync(path.join(work, 'empty.txt'), '')
fs.writeFileSync(path.join(work, 'no-trailing.txt'), 'one\ntwo')
fs.writeFileSync(path.join(work, 'binary.bin'), Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]))
fs.writeFileSync(
  path.join(work, 'many.txt'),
  Array.from({ length: 5_000 }, (_, i) => `line ${i + 1}`).join('\n'),
)
fs.writeFileSync(path.join(work, 'wide.txt'), Array.from({ length: 50 }, () => 'x'.repeat(2_000)).join('\n'))
// Short enough that the 2000-line limit binds before the character budget —
// the two limits are independent and each needs a fixture that reaches it.
fs.writeFileSync(path.join(work, 'short.txt'), Array.from({ length: 3_000 }, () => 'x').join('\n'))
fs.writeFileSync(path.join(work, 'one-huge-line.txt'), 'y'.repeat(60_000))
fs.writeFileSync(path.join(outside, 'secret.txt'), 'classified')

after(() => fs.rmSync(base, { recursive: true, force: true }))

const ctx: ToolContext = { workspaceRoots: [work] }
const run = (args: unknown, context: ToolContext = ctx) => readFileTool.execute(args, context)

describe('ws_read_file — definition', () => {
  test('is ws_-prefixed so it cannot collide with the Nest filesystem server', () => {
    assert.equal(readFileTool.definition.name, 'ws_read_file')
  })

  test('declares path as its only required argument', () => {
    assert.deepEqual(readFileTool.definition.inputSchema.required, ['path'])
  })
})

describe('ws_read_file — reading', () => {
  test('returns the file with 1-based line numbers', async () => {
    const result = await run({ path: 'a.txt' })
    assert.equal(result.isError, false)
    assert.match(result.content, /1\tfirst/)
    assert.match(result.content, /2\tsecond/)
    assert.match(result.content, /3\tthird/)
  })

  test('does not invent a fourth line from the trailing newline', async () => {
    const result = await run({ path: 'a.txt' })
    assert.match(result.content, /\(3 lines\)/)
    assert.ok(!result.content.includes('4\t'))
  })

  test('handles a file with no trailing newline', async () => {
    const result = await run({ path: 'no-trailing.txt' })
    assert.match(result.content, /\(2 lines\)/)
  })

  test('reports an empty file rather than returning nothing', async () => {
    const result = await run({ path: 'empty.txt' })
    assert.equal(result.isError, false)
    assert.match(result.content, /empty/)
  })

  test('accepts a nested path with POSIX separators', async () => {
    fs.writeFileSync(path.join(work, 'sub', 'nested.txt'), 'deep')
    const result = await run({ path: 'sub/nested.txt' })
    assert.equal(result.isError, false)
    assert.match(result.content, /deep/)
  })

  test('renders the path workspace-relative, never absolute', async () => {
    // Absolute paths leak the machine layout into context, cost tokens, and
    // come back as absolute paths in the next call.
    const result = await run({ path: 'a.txt' })
    assert.ok(!result.content.includes(work))
    assert.match(result.content, /^a\.txt/)
  })
})

describe('ws_read_file — ranges', () => {
  test('honours offset and limit', async () => {
    const result = await run({ path: 'many.txt', offset: 10, limit: 3 })
    assert.match(result.content, /10\tline 10/)
    assert.match(result.content, /12\tline 12/)
    assert.ok(!result.content.includes('\t13\tline 13'))
  })

  test('states which range it returned and how many lines exist', async () => {
    const result = await run({ path: 'many.txt', offset: 10, limit: 3 })
    assert.match(result.content, /lines 10-12 of 5000/)
  })

  test('tells the model how to get the rest', async () => {
    // Without this the model reasons about a fragment as though it were whole.
    const result = await run({ path: 'many.txt', offset: 1, limit: 5 })
    assert.match(result.content, /offset 6/)
  })

  test('the default line limit binds when lines are short', async () => {
    const result = await run({ path: 'short.txt' })
    assert.match(result.content, new RegExp(`lines 1-${DEFAULT_LINE_LIMIT} of 3000`))
    assert.equal(result.truncated, true)
  })

  test('the stated range is exactly what was returned, whichever limit binds', async () => {
    // The invariant, and the bug this caught: when the character budget cut the
    // output short, the header still claimed the full requested range and the
    // "read more" hint pointed past the gap — so the model would compute its
    // next offset from a number covering lines it never saw.
    const result = await run({ path: 'many.txt' })
    assert.equal(result.truncated, true)

    const header = /lines 1-(\d+) of 5000/.exec(result.content)
    assert.ok(header?.[1], `no range header in: ${result.content.slice(0, 80)}`)
    const lastLine = Number(header[1])
    assert.ok(lastLine < 5_000, 'expected the budget to bind before the end of the file')

    // The claimed last line is really the last one present...
    assert.ok(result.content.includes(`${lastLine}\tline ${lastLine}\n`))
    assert.ok(!result.content.includes(`\tline ${lastLine + 1}\n`))
    // ...and the continuation hint resumes from exactly there, with no gap.
    assert.ok(result.content.includes(`offset ${lastLine + 1}`))
    assert.ok(result.content.includes(`${5_000 - lastLine} more lines`))
  })

  test('a single line longer than the whole budget still returns something', async () => {
    const result = await run({ path: 'one-huge-line.txt' })
    assert.equal(result.isError, false)
    assert.ok(result.content.length > 0)
    assert.match(result.content, /\[truncated/)
  })

  test('accepts numeric strings, which local models send constantly', async () => {
    const result = await run({ path: 'many.txt', offset: '10', limit: '2' })
    assert.match(result.content, /10\tline 10/)
  })

  test('rejects an offset past the end with a usable message', async () => {
    const result = await run({ path: 'a.txt', offset: 99 })
    assert.equal(result.isError, true)
    assert.match(result.content, /only 3 lines/)
  })

  test('the character budget binds even when the line count is small', async () => {
    // 50 lines of 2000 characters is far under the line limit and far over the
    // character budget — the two limits are independent for a reason.
    const result = await run({ path: 'wide.txt' })
    assert.equal(result.truncated, true)

    const header = /lines 1-(\d+) of 50/.exec(result.content)
    assert.ok(header?.[1], 'expected a partial range header')
    assert.ok(Number(header[1]) < 50, 'expected fewer than all 50 lines')
    // Stopping at a line boundary means the model gets an offset it can act on,
    // rather than a note that some unknown amount was cut.
    assert.ok(result.content.includes(`offset ${Number(header[1]) + 1}`))
  })
})

describe('ws_read_file — refusals return results, never throw', () => {
  test('a missing path argument', async () => {
    const result = await run({})
    assert.equal(result.isError, true)
    assert.match(result.content, /requires a "path"/)
  })

  test('arguments that are not an object at all', async () => {
    const result = await run('a.txt')
    assert.equal(result.isError, true)
  })

  test('a file that does not exist', async () => {
    const result = await run({ path: 'nope.txt' })
    assert.equal(result.isError, true)
    assert.match(result.content, /does not exist/)
  })

  test('a directory, pointing at the right tool instead', async () => {
    const result = await run({ path: 'sub' })
    assert.equal(result.isError, true)
    assert.match(result.content, /ws_list_directory/)
  })

  test('a binary file', async () => {
    const result = await run({ path: 'binary.bin' })
    assert.equal(result.isError, true)
    assert.match(result.content, /binary/)
  })

  test('a path escaping the workspace', async () => {
    const result = await run({ path: '../outside/secret.txt' })
    assert.equal(result.isError, true)
    assert.match(result.content, /outside the workspace/)
    assert.ok(!result.content.includes('classified'))
  })

  test('an absolute path escaping the workspace', async () => {
    const result = await run({ path: path.join(outside, 'secret.txt') })
    assert.equal(result.isError, true)
    assert.ok(!result.content.includes('classified'))
  })

  test('no workspace open is reported as such, not as an escape attempt', async () => {
    const result = await run({ path: 'a.txt' }, { workspaceRoots: [] })
    assert.equal(result.isError, true)
    assert.match(result.content, /No workspace folder is open/)
  })

  test('an already-aborted signal cancels rather than returning content', async () => {
    const result = await run({ path: 'a.txt' }, { workspaceRoots: [work], signal: AbortSignal.abort() })
    assert.equal(result.isError, true)
    assert.match(result.content, /cancelled/)
  })
})
