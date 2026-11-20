import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createToolRegistry, parseToolArguments } from './registry.ts'
import { BackgroundProcesses } from './process-runner.ts'
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
  test('registers the whole local tool set', () => {
    assert.deepEqual([...registry().names].sort(), [
      'ys_delete_file',
      'ys_diagnostics',
      'ys_editor_context',
      'ys_glob',
      'ys_grep',
      'ys_list_directory',
      'ys_move_file',
      'ys_note',
      'ys_outline',
      'ys_read_file',
      'ys_replace',
      'ys_run_command',
      'ys_write_file',
    ])
  })

  test('every tool is ys_-prefixed, so none can shadow a Nest filesystem tool', () => {
    // The collision is silent: one tools array cannot carry two functions with
    // the same name, and the model would get Nest's rootDir instead of the
    // workspace.
    assert.ok(registry().names.every((name) => name.startsWith('ys_')))
  })

  test('names are unique', () => {
    const names = registry().names
    assert.equal(new Set(names).size, names.length)
  })

  test('ys_edit_file is offered only with unifiedDiff', () => {
    const on = createToolRegistry({ ripgrepPath: null, diagnostics: () => [], editorState: emptyEditor, unifiedDiff: true })
    assert.ok(on.names.includes('ys_edit_file'))
    assert.ok(!registry().names.includes('ys_edit_file'))
  })

  test('the background processes are one ys_process tool', () => {
    const names = createToolRegistry({ ripgrepPath: null, diagnostics: () => [], editorState: emptyEditor, processes: new BackgroundProcesses() }).names
    assert.deepEqual(names.filter((n) => n.startsWith('ys_process')), ['ys_process'])
  })
})

/**
 * The local tool list is sent on every request; on a 32k model every
 * character of it is context the task cannot use (PLAN-long-tasks.md item 0).
 * Raise this only by deciding a new tool is worth what it costs.
 */
const TOOL_PAYLOAD_BUDGET = 9_000

describe('the tool list fits its budget', () => {
  test(`the full local set is at most ${TOOL_PAYLOAD_BUDGET} characters`, () => {
    const full = createToolRegistry({
      ripgrepPath: '/somewhere/rg',
      diagnostics: () => [],
      editorState: emptyEditor,
      processes: new BackgroundProcesses(),
      browser: { browser: () => null, screenshotDir: () => null },
      symbols: { outline: async () => [], workspaceSymbols: async () => [], references: async () => [] },
    })
    assert.ok(full.names.includes('ys_references'))
    const size = JSON.stringify(full.payload()).length
    assert.ok(size <= TOOL_PAYLOAD_BUDGET, `${size} characters, budget ${TOOL_PAYLOAD_BUDGET}`)
  })
})

describe('payload', () => {
  test('renders OpenAI-shaped function entries', () => {
    const entry = registry()
      .payload()
      .find((item) => item.function.name === 'ys_read_file')
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
    const grep = degraded.payload().find((item) => item.function.name === 'ys_grep')
    assert.match(grep?.function.description ?? '', /LITERAL substring/)

    const full = createToolRegistry({
      ripgrepPath: '/somewhere/rg',
      diagnostics: () => [],
      editorState: emptyEditor,
    })
    const fullGrep = full.payload().find((item) => item.function.name === 'ys_grep')
    assert.match(fullGrep?.function.description ?? '', /regular expression/)
  })
})

describe('execute', () => {
  test('runs a tool by name', async () => {
    const result = await registry().execute('ys_read_file', '{"path":"a.txt"}', ctx)
    assert.equal(result.isError, false)
    assert.match(result.content, /hello/)
  })

  test('an unknown tool names the alternatives so the model can correct itself', async () => {
    // A model that invented `read_file` should be able to find `ys_read_file`.
    const result = await registry().execute('read_file', '{"path":"a.txt"}', ctx)
    assert.equal(result.isError, true)
    assert.match(result.content, /no tool called "read_file"/)
    assert.match(result.content, /ys_read_file/)
  })

  test('ys_edit_file still runs when called by name, though not offered', async () => {
    const diff = '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-hello\n+bye\n'
    const result = await registry().execute('ys_edit_file', JSON.stringify({ diff }), ctx)
    assert.equal(result.isError, false, result.content)
    assert.ok(result.pendingWrite)
  })

  test('an old ys_process_start call runs as ys_process start', async () => {
    const tools = createToolRegistry({ ripgrepPath: null, diagnostics: () => [], editorState: emptyEditor, processes: new BackgroundProcesses() })
    const result = await tools.execute('ys_process_start', '{"command":"npm run dev"}', ctx)
    assert.equal(result.pendingCommand?.background, true)
  })

  test('repaired arguments run, and say they were repaired', async () => {
    const result = await registry().execute('ys_read_file', "{'path': 'a.txt',}", ctx)
    assert.equal(result.isError, false, result.content)
    assert.match(result.content, /hello/)
    assert.deepEqual(result.argumentsRepaired, ['single quotes', 'trailing comma'])
  })

  test('valid arguments carry no repair mark', async () => {
    const result = await registry().execute('ys_read_file', '{"path":"a.txt"}', ctx)
    assert.equal(result.argumentsRepaired, undefined)
  })

  test('a pre-rename ws_ call from an old transcript runs the ys_ tool', async () => {
    const legacy = await registry().execute('ws_read_file', '{"path":"a.txt"}', ctx)
    const current = await registry().execute('ys_read_file', '{"path":"a.txt"}', ctx)
    assert.equal(legacy.isError, current.isError)
    assert.equal(legacy.content, current.content)
  })

  test('malformed JSON arguments become a correctable error, not a throw', async () => {
    const result = await registry().execute('ys_read_file', '{path: a.txt}', ctx)
    assert.equal(result.isError, true)
    assert.match(result.content, /not valid JSON/)
    assert.match(result.content, /"path"/)
  })

  test('empty arguments are treated as no arguments', async () => {
    // Tools with no required fields get called with "" constantly.
    const result = await registry().execute('ys_editor_context', '', ctx)
    assert.equal(result.isError, false)
  })

  test('a tool failure is a result, never an exception', async () => {
    const result = await registry().execute('ys_read_file', '{"path":"missing.txt"}', ctx)
    assert.equal(result.isError, true)
    assert.match(result.content, /does not exist/)
  })

  test('containment still applies through the registry', async () => {
    const result = await registry().execute('ys_read_file', '{"path":"../escape.txt"}', ctx)
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
    assert.equal(parseToolArguments('{path: a.txt}').ok, false)
    assert.equal(parseToolArguments('{"a": 1').ok, false)
  })

  test('repairs the mechanical mistakes and names them', () => {
    // [raw, parsed, repairs]. String.raw keeps every backslash as typed.
    const cases: [string, unknown, string[]][] = [
      ["{'a': 1}", { a: 1 }, ['single quotes']],
      ['{"a": [1, 2,], }', { a: [1, 2] }, ['trailing comma']],
      ['```json\n{"a": 1}\n```', { a: 1 }, ['code fence']],
      [String.raw`{'say': 'it\'s "fine"'}`, { say: 'it\'s "fine"' }, ['single quotes']],
      [String.raw`{"pattern": "\d+\s"}`, { pattern: String.raw`\d+\s` }, ['invalid escape']],
      ['{"path": "a.js", "content": "const a = 1\n\tb()\n"}', { path: 'a.js', content: 'const a = 1\n\tb()\n' }, ['raw newline']],
      ["{'text': 'a, b,]'}", { text: 'a, b,]' }, ['single quotes']],
    ]
    for (const [raw, value, repairs] of cases) {
      const result = parseToolArguments(raw)
      assert.equal(result.ok, true, raw)
      if (result.ok) {
        assert.deepEqual(result.value, value, raw)
        assert.deepEqual(result.repairs ?? [], repairs, raw)
      }
    }
  })

  test('valid JSON escapes survive a repair', () => {
    const result = parseToolArguments(String.raw`{'a': "x\n\"y\" \u00e9",}`)
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.value, { a: 'x\n"y" \u00e9' })
  })
})
