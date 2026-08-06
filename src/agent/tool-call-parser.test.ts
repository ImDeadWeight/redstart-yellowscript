// =============================================================================
// Tests for the vendored fallback tool-call parser.  [VENDORED]
// =============================================================================
// Origin repo:   redstart-project (github.com/ImDeadWeight/redstart-project)
// Origin path:   redstart-nest/src/chat-ui/tests/unit/tool-call-parser.test.ts
// Origin commit: a41c9d3 (2026-08-05)
// Vendored:      2026-08-06
//
// The cases are the origin's, one for one, including the two condensed from
// real sessions. The assertions are rewritten from vitest to node:test +
// node:assert/strict, since this repo runs tests through Node's native type
// stripping with no test-runner dependency:
//
//   expect(x).toHaveLength(n)  →  assert.equal(x.length, n)
//   expect(x).toStrictEqual(y) →  assert.deepEqual(x, y)   (strict mode)
//   expect(x).toBe(y)          →  assert.equal(x, y)
//   expect(x).toContain(s)     →  assert.ok(x.includes(s))
//
// `onlyCall` also covers what chat-ui's `calls[0]` did implicitly: this repo
// sets noUncheckedIndexedAccess, so an index access is `T | undefined` and has
// to be narrowed before use.
// =============================================================================

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseToolCallsFromText,
  parseToolCallsFromTurn,
  createApiToolCalls,
  type ParsedToolCall,
  type ToolCallParserConfig,
} from './tool-call-parser.ts'

const TOOLS = [{ name: 'create_document' }, { name: 'write_file' }, { name: 'search_files' }]

function cfg(patterns: string[] = ['fn']): ToolCallParserConfig {
  return { patterns, availableTools: TOOLS }
}

/** Assert exactly one call was parsed and hand it back, narrowed. */
function onlyCall(calls: ParsedToolCall[]): ParsedToolCall {
  assert.equal(calls.length, 1)
  const call = calls[0]
  if (!call) throw new Error('unreachable: length was asserted to be 1')
  return call
}

function argsOf(content: string, patterns?: string[]): unknown {
  return JSON.parse(onlyCall(parseToolCallsFromText(content, cfg(patterns))).arguments)
}

describe('parseToolCallsFromText — JSON args', () => {
  test('parses JSON args in fn pattern', () => {
    assert.deepEqual(argsOf('write_file({"path": "a.txt", "content": "hi"})'), {
      path: 'a.txt',
      content: 'hi',
    })
  })

  test('captures brace-delimited args in braces pattern', () => {
    // The regex captures between the outer braces, so the JSON body's own
    // braces re-wrap in tryParseJson only when the capture is itself valid
    // JSON; a bare key:value capture passes through as the raw string.
    const call = onlyCall(parseToolCallsFromText('write_file{"path": "a.txt"}', cfg(['braces'])))
    assert.equal(call.arguments, '"path": "a.txt"')
  })

  test('ignores tool names not in availableTools', () => {
    assert.equal(parseToolCallsFromText('unknown_tool(x=1)', cfg()).length, 0)
  })
})

describe('parseToolCallsFromText — Python-style kwargs fallback', () => {
  test('parses single-quoted string kwargs', () => {
    assert.deepEqual(
      argsOf("create_document(content='Hello World', filename='hello_world.md', format='md')"),
      { content: 'Hello World', filename: 'hello_world.md', format: 'md' },
    )
  })

  test('parses double-quoted string kwargs', () => {
    assert.deepEqual(argsOf('write_file(path="notes/a.txt", content="line one")'), {
      path: 'notes/a.txt',
      content: 'line one',
    })
  })

  test('unescapes escaped quotes and backslashes inside strings', () => {
    assert.deepEqual(argsOf("write_file(content='it\\'s a \\\\ test')"), {
      content: "it's a \\ test",
    })
  })

  test('parses integer and float values', () => {
    assert.deepEqual(argsOf('search_files(limit=10, threshold=0.5, offset=-3)'), {
      limit: 10,
      threshold: 0.5,
      offset: -3,
    })
  })

  test('parses true, false, and null literals', () => {
    assert.deepEqual(argsOf('search_files(recursive=true, hidden=false, filter=null)'), {
      recursive: true,
      hidden: false,
      filter: null,
    })
  })

  test('works in the xml pattern too', () => {
    assert.deepEqual(argsOf("<function=write_file>path='a.txt'</function>", ['xml']), {
      path: 'a.txt',
    })
  })

  test('prefers JSON when args are valid JSON', () => {
    // {"a": 1} is valid JSON; kwargs parsing must not rewrite it.
    const call = onlyCall(parseToolCallsFromText('write_file({"a": 1})', cfg()))
    assert.equal(call.arguments, '{"a": 1}')
  })

  test('falls back to the raw string when args are mostly prose', () => {
    // Contains one k=v pair but is dominated by prose — the 80% consumed
    // threshold must reject it so callers see the original text.
    const prose = 'please summarize the report where status=done and include all sections'
    const call = onlyCall(parseToolCallsFromText(`search_files(${prose})`, cfg()))
    assert.equal(call.arguments, prose)
  })

  test('falls back to the raw string when nothing matches', () => {
    const call = onlyCall(parseToolCallsFromText('search_files(just some words)', cfg()))
    assert.equal(call.arguments, 'just some words')
  })
})

describe('parseToolCallsFromText — canonical JSON tool calls', () => {
  const jsonCfg = (patterns = ['json']): ToolCallParserConfig => ({
    patterns,
    availableTools: TOOLS,
  })

  test('parses a bare JSON tool call', () => {
    const call = onlyCall(
      parseToolCallsFromText(
        '{"name": "create_document", "arguments": {"title": "Log", "format": "docx"}}',
        jsonCfg(),
      ),
    )
    assert.equal(call.name, 'create_document')
    assert.deepEqual(JSON.parse(call.arguments), { title: 'Log', format: 'docx' })
  })

  test('parses a call wrapped in <tool_call> tags', () => {
    const call = onlyCall(
      parseToolCallsFromText(
        '<tool_call>\n{"name": "write_file", "arguments": {"path": "a.txt"}}\n</tool_call>',
        jsonCfg(),
      ),
    )
    assert.equal(call.name, 'write_file')
  })

  test('parses a call inside a json code fence', () => {
    const calls = parseToolCallsFromText(
      'Here is the call:\n```json\n{"name": "write_file", "arguments": {"path": "a.txt"}}\n```',
      jsonCfg(),
    )
    assert.equal(calls.length, 1)
  })

  test('handles nested objects and braces inside string values', () => {
    const call = onlyCall(
      parseToolCallsFromText(
        '{"name": "create_document", "arguments": {"content": "a } brace { in text", "meta": {"deep": {"x": 1}}}}',
        jsonCfg(),
      ),
    )
    const args = JSON.parse(call.arguments) as { content: string; meta: { deep: { x: number } } }
    assert.equal(args.content, 'a } brace { in text')
    assert.equal(args.meta.deep.x, 1)
  })

  test('accepts parameters as an alias for arguments', () => {
    const call = onlyCall(
      parseToolCallsFromText('{"name": "write_file", "parameters": {"path": "a.txt"}}', jsonCfg()),
    )
    assert.deepEqual(JSON.parse(call.arguments), { path: 'a.txt' })
  })

  test('parses multiple sequential tool calls', () => {
    const calls = parseToolCallsFromText(
      '<tool_call>{"name":"write_file","arguments":{"path":"a"}}</tool_call>' +
        '<tool_call>{"name":"search_files","arguments":{"pattern":"b"}}</tool_call>',
      jsonCfg(),
    )
    assert.deepEqual(
      calls.map((c) => c.name),
      ['write_file', 'search_files'],
    )
  })

  test('ignores JSON objects that are not tool calls', () => {
    assert.equal(parseToolCallsFromText('{"foo": "bar"}', jsonCfg()).length, 0)
    assert.equal(parseToolCallsFromText('{"name": "not_a_real_tool"}', jsonCfg()).length, 0)
  })

  test('ignores malformed JSON', () => {
    assert.equal(parseToolCallsFromText('{"name": "write_file", oops}', jsonCfg()).length, 0)
  })

  // Installs that saved the previous default pattern list must still recover
  // a plain JSON call — this is the shape templates actually emit.
  test('is tried as a last resort even when not in the pattern list', () => {
    const call = onlyCall(
      parseToolCallsFromText(
        '{"name": "create_document", "arguments": {"title": "Log"}}',
        jsonCfg(['braces', 'xml', 'fn']),
      ),
    )
    assert.equal(call.name, 'create_document')
  })

  test('does not override a call the configured patterns already found', () => {
    const call = onlyCall(
      parseToolCallsFromText('write_file({"path": "from-fn.txt"})', jsonCfg(['fn'])),
    )
    assert.deepEqual(JSON.parse(call.arguments), { path: 'from-fn.txt' })
  })
})

describe('parseToolCallsFromTurn — reasoning fallback', () => {
  test('prefers a call in the visible answer', () => {
    const call = onlyCall(
      parseToolCallsFromTurn("write_file(path='answer.txt')", "write_file(path='reasoning.txt')", cfg()),
    )
    assert.deepEqual(JSON.parse(call.arguments), { path: 'answer.txt' })
  })

  test('finds a call left in the reasoning stream when the answer has none', () => {
    const call = onlyCall(
      parseToolCallsFromTurn(
        'I have saved the file for you.',
        "I'll call create_document(content='the table', filename='log.docx') now.",
        cfg(),
      ),
    )
    assert.equal(call.name, 'create_document')
  })

  test('recovers the real-world case: model narrates success but only called in its thinking', () => {
    // Condensed from an actual session — the visible answer claimed the file
    // was written while the only call lived in the reasoning block.
    const reasoning = [
      'I should verify the create_document tool signature.',
      "create_document(title='Tiling Purchase Log', content='| Date | Item |', format='docx')",
      'All steps complete.',
    ].join('\n')
    const answer =
      'I have generated the purchase log with exactly 50 rows.\n' +
      'It has been saved as a formatted .docx file for you.'

    assert.equal(parseToolCallsFromText(answer, cfg()).length, 0)

    const call = onlyCall(parseToolCallsFromTurn(answer, reasoning, cfg()))
    assert.equal(call.name, 'create_document')
    assert.deepEqual(JSON.parse(call.arguments), {
      title: 'Tiling Purchase Log',
      content: '| Date | Item |',
      format: 'docx',
    })
  })

  test('returns nothing when neither stream has a call', () => {
    assert.equal(parseToolCallsFromTurn('just prose', 'more prose', cfg()).length, 0)
  })

  describe('orphan arguments (payload in the answer, tool named in reasoning)', () => {
    // Reproduces an observed session: the answer was prose plus a ```json
    // fence holding only the arguments — no "name" key anywhere — while the
    // tool was named solely in the reasoning.
    const answer =
      "I'll generate the DOCX file with your requested purchase log table.\n\n" +
      '```json\n' +
      '{\n"filename": "Tiling_Company_Purchase_Log.docx",\n' +
      '"content": "| Pricing | Items |\\n|---|---|\\n| 2,450.00 | Ceramic Floor Tiles |",\n' +
      '"format": "docx"\n}\n' +
      '```'
    const reasoning =
      "I'll now create the document using create_document.\n" +
      'create_document(filename="Tiling_Company_Purchase_Log.docx", content=markdown_table, format="docx")'

    test('attributes the payload to the tool named in reasoning', () => {
      const call = onlyCall(parseToolCallsFromTurn(answer, reasoning, cfg()))
      assert.equal(call.name, 'create_document')
      const args = JSON.parse(call.arguments) as { filename: string; format: string; content: string }
      assert.equal(args.filename, 'Tiling_Company_Purchase_Log.docx')
      assert.equal(args.format, 'docx')
      // The answer's real table, not the reasoning's "markdown_table" placeholder.
      assert.ok(args.content.includes('Ceramic Floor Tiles'))
    })

    // In the negative cases the reasoning-text scan is still free to recover
    // something on its own — that is a separate path. What must never happen
    // is the answer's payload being routed to a guessed tool.
    const attributedThePayload = (calls: Array<{ arguments: string }>): boolean =>
      calls.some((c) => c.arguments.includes('Ceramic Floor Tiles'))

    test('refuses to guess when several tools are named', () => {
      const ambiguous = `${reasoning}\nOr maybe write_file would be better.`
      assert.equal(attributedThePayload(parseToolCallsFromTurn(answer, ambiguous, cfg())), false)
    })

    test('refuses to guess when no tool is named anywhere', () => {
      assert.equal(parseToolCallsFromTurn(answer, 'No tool mentioned here.', cfg()).length, 0)
    })

    test('ignores a turn with several candidate objects', () => {
      const twoObjects = '```json\n{"a": 1}\n```\n```json\n{"b": 2}\n```'
      const calls = parseToolCallsFromTurn(twoObjects, reasoning, cfg())
      assert.equal(
        calls.some((c) => /"[ab]"\s*:/.test(c.arguments)),
        false,
      )
    })

    test('does not hijack a properly named tool call', () => {
      const named = '{"name": "write_file", "arguments": {"path": "a.txt"}}'
      const call = onlyCall(parseToolCallsFromTurn(named, reasoning, cfg()))
      assert.equal(call.name, 'write_file')
    })
  })

  test('handles missing reasoning content', () => {
    assert.equal(parseToolCallsFromTurn('just prose', undefined, cfg()).length, 0)
  })
})

// Not in the origin's suite: chat-ui got this shape from its own API types,
// whereas here `ToolCall` is our wire type and the agent loop will consume it
// alongside structured calls, so the mapping is worth pinning.
describe('createApiToolCalls', () => {
  test('maps parsed calls onto the wire shape', () => {
    const calls = createApiToolCalls([
      { name: 'write_file', arguments: '{"path":"a.txt"}' },
      { name: 'search_files', arguments: '{}' },
    ])

    assert.equal(calls.length, 2)
    assert.deepEqual(
      calls.map((c) => c.function.name),
      ['write_file', 'search_files'],
    )
    assert.ok(calls.every((c) => c.type === 'function'))
    // Ids must be distinct — they key tool results back to their call.
    assert.equal(new Set(calls.map((c) => c.id)).size, 2)
  })

  test('returns nothing for no calls', () => {
    assert.deepEqual(createApiToolCalls([]), [])
  })
})
