import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  assertWorkspaceToolName,
  boolArg,
  intArg,
  stringArg,
  toolError,
  toolOk,
  truncateForModel,
} from './types.ts'

describe('assertWorkspaceToolName', () => {
  test('accepts a ws_-prefixed name', () => {
    assert.equal(assertWorkspaceToolName('ws_read_file'), 'ws_read_file')
  })

  test('rejects a name that would collide with the Nest filesystem server', () => {
    // read_file, write_file, edit_file, list_directory and search_files are all
    // advertised by Nest's MCP filesystem capability. A duplicate name in one
    // tools array silently shadows one of the two.
    for (const name of ['read_file', 'write_file', 'list_directory', 'search_files']) {
      assert.throws(() => assertWorkspaceToolName(name), /must start with "ws_"/)
    }
  })
})

describe('truncateForModel', () => {
  test('leaves text under the budget untouched', () => {
    const result = truncateForModel('short', 100)
    assert.equal(result.text, 'short')
    assert.equal(result.truncated, false)
  })

  test('cuts text over the budget and says so in-band', () => {
    // In-band because the `truncated` flag never reaches the model — only the
    // string does, and a model reasoning about a fragment as if it were whole
    // is the failure this prevents.
    const result = truncateForModel('x'.repeat(500), 100)
    assert.equal(result.truncated, true)
    assert.match(result.text, /\[truncated — [\d,]+ more characters not shown\]/)
  })

  test('reports how much was omitted', () => {
    const result = truncateForModel('x'.repeat(1_500), 1_000)
    assert.match(result.text, /500 more characters/)
  })

  test('prefers a line boundary when one is close to the limit', () => {
    const text = `${'a'.repeat(95)}\n${'b'.repeat(200)}`
    const result = truncateForModel(text, 100)
    // Half a line of source reads as a syntax error and invites the model to
    // "fix" something that is not broken.
    assert.ok(!result.text.startsWith(`${'a'.repeat(95)}\nb`))
  })

  test('does not sacrifice most of the budget to find a line boundary', () => {
    const text = `a\n${'b'.repeat(500)}`
    const result = truncateForModel(text, 100)
    assert.ok(result.text.length > 50, 'cut back to the newline at index 1')
  })
})

describe('argument readers', () => {
  test('stringArg reads a string field', () => {
    assert.equal(stringArg({ path: 'a.txt' }, 'path'), 'a.txt')
  })

  test('stringArg returns null for a missing or non-string field', () => {
    assert.equal(stringArg({}, 'path'), null)
    assert.equal(stringArg({ path: 42 }, 'path'), null)
    assert.equal(stringArg({ path: null }, 'path'), null)
  })

  test('stringArg survives arguments that are not an object at all', () => {
    // Local models emit a bare string or an array as `arguments` often enough
    // that this must produce "no path given" rather than a TypeError.
    assert.equal(stringArg('a.txt', 'path'), null)
    assert.equal(stringArg(['a.txt'], 'path'), null)
    assert.equal(stringArg(null, 'path'), null)
    assert.equal(stringArg(undefined, 'path'), null)
  })

  test('intArg accepts integers and rejects nonsense', () => {
    assert.equal(intArg({ n: 5 }, 'n'), 5)
    assert.equal(intArg({ n: 0 }, 'n'), 0)
    assert.equal(intArg({ n: -1 }, 'n'), null)
    assert.equal(intArg({ n: 1.5 }, 'n'), null)
    assert.equal(intArg({}, 'n'), null)
  })

  test('intArg accepts a numeric string, which models send constantly', () => {
    assert.equal(intArg({ n: '42' }, 'n'), 42)
    assert.equal(intArg({ n: 'twelve' }, 'n'), null)
  })

  test('boolArg accepts booleans and their string forms', () => {
    assert.equal(boolArg({ b: true }, 'b'), true)
    assert.equal(boolArg({ b: 'false' }, 'b'), false)
    assert.equal(boolArg({ b: 'yes' }, 'b'), null)
  })
})

describe('result constructors', () => {
  test('toolOk defaults to not-truncated and not-an-error', () => {
    assert.deepEqual(toolOk('body', 'did a thing'), {
      content: 'body',
      isError: false,
      summary: 'did a thing',
      truncated: false,
    })
  })

  test('toolError reuses the message as the summary by default', () => {
    const result = toolError('File not found.')
    assert.equal(result.isError, true)
    assert.equal(result.summary, 'File not found.')
  })
})
