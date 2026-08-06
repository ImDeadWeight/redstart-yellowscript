import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createToolRegistry, parseToolArguments } from './registry.ts'
import type { ToolContext } from './types.ts'
import type { EditorState } from './editor-context.ts'

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-registry-')))
fs.writeFileSync(path.join(base, 'a.txt'), 'hello\n')
after(() => fs.rmSync(base, { recursive: true, force: true }))

const ctx: ToolContext = { workspaceRoots: [base] }

const emptyEditor = (): EditorState => ({
  activeFile: null,
  languageId: null,
  isDirty: false,
  cursor: null,
  selection: null,
  openFiles: [],
})

const registry = () =>
  createToolRegistry({ ripgrepPath: null, diagnostics: () => [], editorState: emptyEditor })

describe('createToolRegistry', () => {
  test('registers the whole Phase 2 read-only set', () => {
    assert.deepEqual([...registry().names].sort(), [
      'ws_diagnostics',
      'ws_editor_context',
      'ws_glob',
      'ws_grep',
      'ws_list_directory',
      'ws_read_file',
    ])
  })

  test('every tool is ws_-prefixed, so none can shadow a Nest filesystem tool', () => {
    // The collision is silent: one tools array cannot carry two functions with
    // the same name, and the model would get Nest's rootDir instead of the
    // workspace.
    assert.ok(registry().names.every((name) => name.startsWith('ws_')))
  })

  test('names are unique', () => {
    const names = registry().names
    assert.equal(new Set(names).size, names.length)
  })
})

describe('payload', () => {
  test('renders OpenAI-shaped function entries', () => {
    const entry = registry()
      .payload()
      .find((item) => item.function.name === 'ws_read_file')
    assert.ok(entry)
    assert.equal(entry.type, 'function')
    assert.ok(entry.function.description.length > 0)
    assert.deepEqual((entry.function.parameters as { required: string[] }).required, ['path'])
  })

  test('every tool appears exactly once', () => {
    const payload = registry().payload()
    assert.equal(payload.length, registry().names.length)
  })

  test('is JSON-serialisable — it goes on the wire verbatim', () => {
    assert.doesNotThrow(() => JSON.stringify(registry().payload()))
  })

  test('search tool descriptions reflect the degraded backend', () => {
    // The description is what the model plans against, so it has to tell the
    // truth about whether regex is available.
    const degraded = createToolRegistry({
      ripgrepPath: null,
      diagnostics: () => [],
      editorState: emptyEditor,
    })
    const grep = degraded.payload().find((item) => item.function.name === 'ws_grep')
    assert.match(grep?.function.description ?? '', /LITERAL substring/)

    const full = createToolRegistry({
      ripgrepPath: '/somewhere/rg',
      diagnostics: () => [],
      editorState: emptyEditor,
    })
    const fullGrep = full.payload().find((item) => item.function.name === 'ws_grep')
    assert.match(fullGrep?.function.description ?? '', /regular expression/)
  })
})

describe('execute', () => {
  test('runs a tool by name', async () => {
    const result = await registry().execute('ws_read_file', '{"path":"a.txt"}', ctx)
    assert.equal(result.isError, false)
    assert.match(result.content, /hello/)
  })

  test('an unknown tool names the alternatives so the model can correct itself', async () => {
    // A model that invented `read_file` should be able to find `ws_read_file`.
    const result = await registry().execute('read_file', '{"path":"a.txt"}', ctx)
    assert.equal(result.isError, true)
    assert.match(result.content, /no tool called "read_file"/)
    assert.match(result.content, /ws_read_file/)
  })

  test('malformed JSON arguments become a correctable error, not a throw', async () => {
    const result = await registry().execute('ws_read_file', '{path: a.txt}', ctx)
    assert.equal(result.isError, true)
    assert.match(result.content, /not valid JSON/)
    assert.match(result.content, /"path"/)
  })

  test('empty arguments are treated as no arguments', async () => {
    // Tools with no required fields get called with "" constantly.
    const result = await registry().execute('ws_editor_context', '', ctx)
    assert.equal(result.isError, false)
  })

  test('a tool failure is a result, never an exception', async () => {
    const result = await registry().execute('ws_read_file', '{"path":"missing.txt"}', ctx)
    assert.equal(result.isError, true)
    assert.match(result.content, /does not exist/)
  })

  test('containment still applies through the registry', async () => {
    const result = await registry().execute('ws_read_file', '{"path":"../escape.txt"}', ctx)
    assert.equal(result.isError, true)
    assert.match(result.content, /outside the workspace/)
  })
})

describe('parseToolArguments', () => {
  test('parses an object', () => {
    assert.deepEqual(parseToolArguments('{"a":1}'), { ok: true, value: { a: 1 } })
  })

  test('treats empty or whitespace as no arguments', () => {
    assert.deepEqual(parseToolArguments(''), { ok: true, value: {} })
    assert.deepEqual(parseToolArguments('   '), { ok: true, value: {} })
  })

  test('passes a bare JSON value through for the tool to reject with a better message', () => {
    // The tool can say "requires a path"; this layer only knows "not JSON".
    assert.deepEqual(parseToolArguments('"a.txt"'), { ok: true, value: 'a.txt' })
    assert.deepEqual(parseToolArguments('[1,2]'), { ok: true, value: [1, 2] })
  })

  test('reports genuinely unparseable text', () => {
    const result = parseToolArguments("{'a': 1}")
    assert.equal(result.ok, false)
  })
})
