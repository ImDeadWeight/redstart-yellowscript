// =============================================================================
// ws_diagnostics and ws_editor_context.
// =============================================================================
// Both take their VSCode state through an injected provider, which is what lets
// these run under `node --test` with no extension host. The provider is a plain
// function returning plain data, so every case below is a literal.
// =============================================================================

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createDiagnosticsTool, MAX_DIAGNOSTICS, type DiagnosticRecord } from './diagnostics.ts'
import { createEditorContextTool, MAX_SELECTION_CHARS, type EditorState } from './editor-context.ts'
import type { ToolContext } from './types.ts'

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-editor-')))
const work = path.join(base, 'work')
const outside = path.join(base, 'outside')
fs.mkdirSync(path.join(work, 'src'), { recursive: true })
fs.mkdirSync(outside, { recursive: true })
fs.writeFileSync(path.join(work, 'src', 'a.ts'), 'const a = 1\n')
fs.writeFileSync(path.join(work, 'src', 'b.ts'), 'const b = 2\n')
fs.writeFileSync(path.join(outside, 'other.ts'), 'const o = 3\n')

after(() => fs.rmSync(base, { recursive: true, force: true }))

const ctx: ToolContext = { workspaceRoots: [work] }
const fileA = path.join(work, 'src', 'a.ts')
const fileB = path.join(work, 'src', 'b.ts')
const foreign = path.join(outside, 'other.ts')

function problem(over: Partial<DiagnosticRecord> = {}): DiagnosticRecord {
  return { file: fileA, line: 1, column: 1, severity: 'error', message: 'boom', ...over }
}

const toolFor = (records: DiagnosticRecord[]) => createDiagnosticsTool(() => records)

describe('ws_diagnostics', () => {
  test('is ws_-prefixed and takes no required arguments', () => {
    const tool = toolFor([])
    assert.equal(tool.definition.name, 'ws_diagnostics')
    assert.deepEqual(tool.definition.inputSchema.required, [])
  })

  test('reports a clean workspace without calling it an error', async () => {
    const result = await toolFor([]).execute({}, ctx)
    assert.equal(result.isError, false)
    assert.match(result.content, /No problems reported/)
  })

  test('renders file, position, severity and message', async () => {
    const result = await toolFor([
      problem({ line: 12, column: 5, message: "Cannot find name 'foo'", source: 'ts', code: '2304' }),
    ]).execute({}, ctx)
    assert.match(result.content, /src\/a\.ts/)
    assert.match(result.content, /12:5\s+error\s+Cannot find name 'foo'\s+\[ts 2304\]/)
  })

  test('counts every severity in the header', async () => {
    const result = await toolFor([
      problem(),
      problem({ severity: 'warning' }),
      problem({ severity: 'warning' }),
    ]).execute({}, ctx)
    assert.match(result.content, /3 problems \(1 error, 2 warnings\)/)
  })

  test('groups by file', async () => {
    const result = await toolFor([problem(), problem({ file: fileB })]).execute({}, ctx)
    assert.match(result.content, /src\/a\.ts/)
    assert.match(result.content, /src\/b\.ts/)
  })

  test('omits diagnostics for files outside the workspace', async () => {
    // VSCode reports these for any open document, including files from another
    // project. The model must not learn about paths it cannot read.
    const result = await toolFor([problem({ file: foreign })]).execute({}, ctx)
    assert.match(result.content, /No problems reported/)
    assert.ok(!result.content.includes('other.ts'))
  })

  test('filters by minimum severity', async () => {
    const records = [problem(), problem({ severity: 'hint', message: 'nit' })]
    const errorsOnly = await toolFor(records).execute({ severity: 'error' }, ctx)
    assert.match(errorsOnly.content, /1 problem \(1 error\)/)
    assert.ok(!errorsOnly.content.includes('nit'))
  })

  test('rejects an unknown severity rather than silently ignoring it', async () => {
    const result = await toolFor([problem()]).execute({ severity: 'critical' }, ctx)
    assert.equal(result.isError, true)
    assert.match(result.content, /Unknown severity/)
  })

  test('scopes to a path when asked', async () => {
    const result = await toolFor([problem(), problem({ file: fileB })]).execute(
      { path: 'src/b.ts' },
      ctx,
    )
    assert.match(result.content, /src\/b\.ts/)
    assert.ok(!result.content.includes('a.ts'))
  })

  test('refuses a scope outside the workspace', async () => {
    const result = await toolFor([problem()]).execute({ path: '../outside' }, ctx)
    assert.equal(result.isError, true)
    assert.match(result.content, /outside the workspace/)
  })

  test('a scope prefix does not match a sibling with the same prefix', async () => {
    // "src" must not select "src-generated".
    fs.mkdirSync(path.join(work, 'src-generated'), { recursive: true })
    fs.writeFileSync(path.join(work, 'src-generated', 'g.ts'), '')
    const generated = path.join(work, 'src-generated', 'g.ts')
    const result = await toolFor([problem({ file: generated })]).execute({ path: 'src' }, ctx)
    assert.match(result.content, /No problems reported/)
  })

  test('truncation drops hints, never errors', async () => {
    // The important one: a file with hundreds of lint hints must not push the
    // real type errors out of the result, or the model concludes it is clean.
    const records: DiagnosticRecord[] = []
    for (let i = 0; i < MAX_DIAGNOSTICS + 40; i++) {
      records.push(problem({ severity: 'hint', line: i + 1, message: `hint ${i}` }))
    }
    records.push(problem({ severity: 'error', line: 999, message: 'THE REAL ERROR' }))

    const result = await toolFor(records).execute({}, ctx)
    assert.match(result.content, /THE REAL ERROR/)
    assert.equal(result.truncated, true)
    assert.match(result.content, /more, lowest severity first/)
  })

  test('the header counts the full set, not just what was shown', async () => {
    // A model told "60 problems" when there are 100 stops looking.
    const records = Array.from({ length: MAX_DIAGNOSTICS + 40 }, (_, i) =>
      problem({ line: i + 1, message: `e${i}` }),
    )
    const result = await toolFor(records).execute({}, ctx)
    assert.match(result.content, new RegExp(`${MAX_DIAGNOSTICS + 40} problems`))
  })

  test('reports no workspace as such', async () => {
    const result = await toolFor([]).execute({}, { workspaceRoots: [] })
    assert.equal(result.isError, true)
    assert.match(result.content, /No workspace folder is open/)
  })
})

// --- ws_editor_context ------------------------------------------------------

function editorState(over: Partial<EditorState> = {}): EditorState {
  return {
    activeFile: fileA,
    languageId: 'typescript',
    isDirty: false,
    cursor: { line: 3, column: 7 },
    selection: null,
    openFiles: [fileA, fileB],
    ...over,
  }
}

const editorTool = (state: EditorState) => createEditorContextTool(() => state)

describe('ws_editor_context', () => {
  test('is ws_-prefixed and takes no arguments', () => {
    const tool = editorTool(editorState())
    assert.equal(tool.definition.name, 'ws_editor_context')
    assert.deepEqual(tool.definition.inputSchema.properties, {})
  })

  test('reports the active file, language and cursor', async () => {
    const result = await editorTool(editorState()).execute({}, ctx)
    assert.equal(result.isError, false)
    assert.match(result.content, /Active file: src\/a\.ts \(typescript\)/)
    assert.match(result.content, /Cursor: line 3, column 7/)
  })

  test('flags unsaved changes, because disk does not match what the user sees', async () => {
    const result = await editorTool(editorState({ isDirty: true })).execute({}, ctx)
    assert.match(result.content, /unsaved changes/)
  })

  test('includes the selected text', async () => {
    const state = editorState({
      selection: { start: { line: 2, column: 1 }, end: { line: 3, column: 4 }, text: 'const a = 1' },
    })
    const result = await editorTool(state).execute({}, ctx)
    assert.match(result.content, /Selection: lines 2–3/)
    assert.match(result.content, /const a = 1/)
  })

  test('a single-line selection is described as one line', async () => {
    const state = editorState({
      selection: { start: { line: 2, column: 1 }, end: { line: 2, column: 9 }, text: 'const a' },
    })
    assert.match((await editorTool(state).execute({}, ctx)).content, /Selection: line 2 /)
  })

  test('caps a huge selection instead of spending the whole context on it', async () => {
    const state = editorState({
      selection: {
        start: { line: 1, column: 1 },
        end: { line: 5_000, column: 1 },
        text: 'x'.repeat(MAX_SELECTION_CHARS * 3),
      },
    })
    const result = await editorTool(state).execute({}, ctx)
    assert.match(result.content, /shown truncated/)
    assert.ok(result.content.length < MAX_SELECTION_CHARS * 2)
  })

  test('reports an empty selection as none', async () => {
    const result = await editorTool(editorState()).execute({}, ctx)
    assert.match(result.content, /Selection: none/)
  })

  test('lists open files, workspace-relative', async () => {
    const result = await editorTool(editorState()).execute({}, ctx)
    assert.match(result.content, /Open files \(2\):/)
    assert.match(result.content, /src\/a\.ts/)
    assert.ok(!result.content.includes(work))
  })

  test('omits open files that are outside the workspace', async () => {
    const state = editorState({ openFiles: [fileA, foreign] })
    const result = await editorTool(state).execute({}, ctx)
    assert.match(result.content, /Open files \(1\):/)
    assert.ok(!result.content.includes('other.ts'))
  })

  test('distinguishes "nothing open" from "something open that is not ours"', async () => {
    const nothing = await editorTool(editorState({ activeFile: null })).execute({}, ctx)
    assert.match(nothing.content, /No file is currently active/)

    const foreignActive = await editorTool(
      editorState({ activeFile: foreign, openFiles: [] }),
    ).execute({}, ctx)
    assert.match(foreignActive.content, /outside this workspace/)
    assert.ok(!foreignActive.content.includes('other.ts'))
  })

  test('reports no workspace as such', async () => {
    const result = await editorTool(editorState()).execute({}, { workspaceRoots: [] })
    assert.equal(result.isError, true)
    assert.match(result.content, /No workspace folder is open/)
  })
})
