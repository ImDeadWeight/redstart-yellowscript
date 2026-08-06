import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  assembleToolCalls,
  runAgentLoop,
  DEFAULT_MAX_ITERATIONS,
  type CompletionStreamer,
} from './loop.ts'
import { createToolRegistry } from '../tools/registry.ts'
import type { ToolContext } from '../tools/types.ts'
import type { EditorState } from '../tools/editor-context.ts'
import type { ChatCompletionRequest, StreamResult } from '../nest/client.ts'
import type { ToolCallDelta } from '../nest/streaming.ts'

// --- assembleToolCalls ------------------------------------------------------

const delta = (over: Partial<ToolCallDelta> & { index: number }): ToolCallDelta => over

describe('assembleToolCalls', () => {
  test('joins a name and arguments split across many chunks', () => {
    // The wire format: id and name up front, then arguments a slice at a time.
    const calls = assembleToolCalls([
      delta({ index: 0, id: 'call_1', function: { name: 'ws_read_file', arguments: '{"pa' } }),
      delta({ index: 0, function: { arguments: 'th":"a' } }),
      delta({ index: 0, function: { arguments: '.txt"}' } }),
    ])
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], {
      id: 'call_1',
      type: 'function',
      function: { name: 'ws_read_file', arguments: '{"path":"a.txt"}' },
    })
  })

  test('keeps parallel calls separate by index', () => {
    const calls = assembleToolCalls([
      delta({ index: 0, id: 'a', function: { name: 'ws_read_file', arguments: '{"path":"' } }),
      delta({ index: 1, id: 'b', function: { name: 'ws_glob', arguments: '{"pattern":"' } }),
      delta({ index: 0, function: { arguments: 'one.txt"}' } }),
      delta({ index: 1, function: { arguments: '*.ts"}' } }),
    ])
    assert.deepEqual(
      calls.map((c) => [c.function.name, c.function.arguments]),
      [
        ['ws_read_file', '{"path":"one.txt"}'],
        ['ws_glob', '{"pattern":"*.ts"}'],
      ],
    )
  })

  test('returns calls in index order regardless of arrival order', () => {
    const calls = assembleToolCalls([
      delta({ index: 2, id: 'c', function: { name: 'ws_grep', arguments: '{}' } }),
      delta({ index: 0, id: 'a', function: { name: 'ws_read_file', arguments: '{}' } }),
    ])
    assert.deepEqual(calls.map((c) => c.id), ['a', 'c'])
  })

  test('treats a missing index as the first call rather than dropping it', () => {
    // Some servers omit index when there is only ever one call.
    const calls = assembleToolCalls([
      { function: { name: 'ws_read_file', arguments: '{}' } } as unknown as ToolCallDelta,
    ])
    assert.equal(calls.length, 1)
  })

  test('synthesises an id when the server sends none', () => {
    // The id is what matches a result back to its call; without one a
    // multi-call turn misattributes answers.
    const calls = assembleToolCalls([delta({ index: 0, function: { name: 'ws_glob', arguments: '{}' } })])
    assert.ok(calls[0]?.id)
  })

  test('drops a fragment that never received a name', () => {
    // Not executable, and guessing a default would run the wrong tool.
    assert.deepEqual(assembleToolCalls([delta({ index: 0, function: { arguments: '{"a":1}' } })]), [])
  })

  test('handles an empty delta list', () => {
    assert.deepEqual(assembleToolCalls([]), [])
  })
})

// --- runAgentLoop -----------------------------------------------------------

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-loop-')))
fs.writeFileSync(path.join(base, 'a.txt'), 'file contents here\n')
after(() => fs.rmSync(base, { recursive: true, force: true }))

const toolContext: ToolContext = { workspaceRoots: [base] }
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

function streamResult(over: Partial<StreamResult> = {}): StreamResult {
  return { content: '', reasoning: '', toolCalls: [], aborted: false, ...over }
}

/** A streamer that replays a scripted sequence, one entry per round trip. */
function scriptedStreamer(script: StreamResult[]): CompletionStreamer & {
  requests: ChatCompletionRequest[]
} {
  const requests: ChatCompletionRequest[] = []
  return {
    requests,
    async streamChatCompletion(request, handlers) {
      requests.push(structuredClone(request))
      const next = script[requests.length - 1] ?? streamResult({ content: 'fallback' })
      if (next.content) handlers.onContent?.(next.content)
      if (next.reasoning) handlers.onReasoning?.(next.reasoning)
      return next
    },
  }
}

const callDelta = (name: string, args: string, index = 0): ToolCallDelta => ({
  index,
  id: `call_${index}`,
  function: { name, arguments: args },
})

const baseRequest: ChatCompletionRequest = {
  messages: [{ role: 'user', content: 'read a.txt' }],
}

describe('runAgentLoop — basic flow', () => {
  test('a turn with no tool calls completes in one round trip', async () => {
    const client = scriptedStreamer([streamResult({ content: 'Just an answer.' })])
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })

    assert.equal(result.iterations, 1)
    assert.equal(result.stopReason, 'complete')
    assert.equal(result.content, 'Just an answer.')
    assert.deepEqual(result.toolRuns, [])
  })

  test('sends the tool payload on every request', async () => {
    // Sending tools is what makes the gateway claim Nest capabilities, so its
    // absence changes the prompt as well as the model's options.
    const client = scriptedStreamer([streamResult({ content: 'done' })])
    await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })

    const tools = client.requests[0]?.tools as Array<{ function: { name: string } }>
    assert.ok(tools)
    assert.ok(tools.some((entry) => entry.function.name === 'ws_read_file'))
  })

  test('executes a tool call and feeds the result back', async () => {
    const client = scriptedStreamer([
      streamResult({ toolCalls: [callDelta('ws_read_file', '{"path":"a.txt"}')] }),
      streamResult({ content: 'The file says: file contents here' }),
    ])
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })

    assert.equal(result.iterations, 2)
    assert.equal(result.stopReason, 'complete')
    assert.equal(result.toolRuns.length, 1)
    assert.match(result.toolRuns[0]?.result.content ?? '', /file contents here/)
    assert.match(result.content, /The file says/)
  })

  test('the second request carries the assistant call and the tool result', async () => {
    const client = scriptedStreamer([
      streamResult({ content: 'Let me look.', toolCalls: [callDelta('ws_read_file', '{"path":"a.txt"}')] }),
      streamResult({ content: 'Done.' }),
    ])
    await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })

    const second = client.requests[1]
    assert.ok(second)
    const roles = second.messages.map((message) => message.role)
    assert.deepEqual(roles, ['user', 'assistant', 'tool'])

    const assistant = second.messages[1] as { tool_calls?: unknown[] }
    assert.equal(assistant.tool_calls?.length, 1)

    // The id is what matches a result to its call. Without it a multi-call
    // turn misattributes which answer belongs to which question.
    const toolMessage = second.messages[2] as { tool_call_id?: string }
    assert.equal(toolMessage.tool_call_id, 'call_0')
  })

  test('runs several calls from one turn, each with its own id', async () => {
    const client = scriptedStreamer([
      streamResult({
        toolCalls: [
          callDelta('ws_read_file', '{"path":"a.txt"}', 0),
          callDelta('ws_list_directory', '{"path":"."}', 1),
        ],
      }),
      streamResult({ content: 'Both done.' }),
    ])
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })

    assert.equal(result.toolRuns.length, 2)
    const second = client.requests[1]
    const ids = (second?.messages ?? [])
      .filter((message) => message.role === 'tool')
      .map((message) => (message as { tool_call_id?: string }).tool_call_id)
    assert.deepEqual(ids, ['call_0', 'call_1'])
  })

  test('a failing tool reports back as content rather than throwing', async () => {
    // The model needs to read why and try something else.
    const client = scriptedStreamer([
      streamResult({ toolCalls: [callDelta('ws_read_file', '{"path":"missing.txt"}')] }),
      streamResult({ content: 'It does not exist.' }),
    ])
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })

    assert.equal(result.toolRuns[0]?.result.isError, true)
    assert.match(result.toolRuns[0]?.result.content ?? '', /does not exist/)
    assert.equal(result.stopReason, 'complete')
  })

  test('an unknown tool name comes back as a correctable error', async () => {
    const client = scriptedStreamer([
      streamResult({ toolCalls: [callDelta('read_file', '{"path":"a.txt"}')] }),
      streamResult({ content: 'Retrying.' }),
    ])
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })
    assert.match(result.toolRuns[0]?.result.content ?? '', /ws_read_file/)
  })
})

describe('runAgentLoop — recovery of malformed calls', () => {
  test('recovers a call the model wrote as text instead of tool_calls', async () => {
    // Without this the model narrates work it never did.
    const client = scriptedStreamer([
      streamResult({ content: 'ws_read_file({"path": "a.txt"})' }),
      streamResult({ content: 'Here it is.' }),
    ])
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })

    assert.equal(result.toolRuns.length, 1)
    assert.equal(result.toolRuns[0]?.recovered, true)
    assert.match(result.toolRuns[0]?.result.content ?? '', /file contents here/)
  })

  test('recovers a call left in the reasoning stream', async () => {
    const client = scriptedStreamer([
      streamResult({
        content: 'I have read the file for you.',
        reasoning: 'ws_read_file({"path": "a.txt"})',
      }),
      streamResult({ content: 'Done.' }),
    ])
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })
    assert.equal(result.toolRuns.length, 1)
    assert.equal(result.toolRuns[0]?.recovered, true)
  })

  test('does not run the parser when structured calls were present', async () => {
    // Otherwise a turn that both calls a tool AND quotes one in prose runs it
    // twice.
    const client = scriptedStreamer([
      streamResult({
        content: 'I will also mention ws_glob({"pattern":"*.ts"}) in passing.',
        toolCalls: [callDelta('ws_read_file', '{"path":"a.txt"}')],
      }),
      streamResult({ content: 'Done.' }),
    ])
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })

    assert.equal(result.toolRuns.length, 1)
    assert.equal(result.toolRuns[0]?.call.function.name, 'ws_read_file')
    assert.equal(result.toolRuns[0]?.recovered, false)
  })

  test('plain prose mentioning no tool completes normally', async () => {
    const client = scriptedStreamer([streamResult({ content: 'I think the answer is 42.' })])
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })
    assert.equal(result.toolRuns.length, 0)
    assert.equal(result.stopReason, 'complete')
  })
})

describe('runAgentLoop — termination', () => {
  test('stops at the iteration cap and says so', async () => {
    // A model that answers every result with another call would otherwise run
    // forever.
    const forever: CompletionStreamer = {
      async streamChatCompletion() {
        return streamResult({ toolCalls: [callDelta('ws_read_file', '{"path":"a.txt"}')] })
      },
    }
    const result = await runAgentLoop({
      client: forever,
      request: baseRequest,
      tools: registry(),
      toolContext,
      maxIterations: 3,
    })

    assert.equal(result.iterations, 3)
    assert.equal(result.stopReason, 'turn-cap')
    assert.equal(result.toolRuns.length, 3)
  })

  test('defaults to a bounded number of iterations', async () => {
    const forever: CompletionStreamer = {
      async streamChatCompletion() {
        return streamResult({ toolCalls: [callDelta('ws_read_file', '{"path":"a.txt"}')] })
      },
    }
    const result = await runAgentLoop({ client: forever, request: baseRequest, tools: registry(), toolContext })
    assert.equal(result.iterations, DEFAULT_MAX_ITERATIONS)
  })

  test('an aborted stream ends the loop and is reported', async () => {
    const client = scriptedStreamer([streamResult({ content: 'partial', aborted: true })])
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })

    assert.equal(result.aborted, true)
    assert.equal(result.stopReason, 'aborted')
    assert.equal(result.content, 'partial')
  })

  test('an already-aborted signal does not start a round trip at all', async () => {
    const client = scriptedStreamer([streamResult({ content: 'should not run' })])
    const result = await runAgentLoop({
      client,
      request: baseRequest,
      tools: registry(),
      toolContext,
      signal: AbortSignal.abort(),
    })

    assert.equal(client.requests.length, 0)
    assert.equal(result.stopReason, 'aborted')
  })

  test('a client error propagates — ChatSession already reports those', async () => {
    const failing: CompletionStreamer = {
      async streamChatCompletion() {
        throw new Error('connection lost')
      },
    }
    await assert.rejects(
      () => runAgentLoop({ client: failing, request: baseRequest, tools: registry(), toolContext }),
      /connection lost/,
    )
  })
})

describe('runAgentLoop — reporting', () => {
  test('accumulates content across iterations', async () => {
    const client = scriptedStreamer([
      streamResult({ content: 'Let me check.', toolCalls: [callDelta('ws_read_file', '{"path":"a.txt"}')] }),
      streamResult({ content: 'It contains text.' }),
    ])
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })
    assert.match(result.content, /Let me check\./)
    assert.match(result.content, /It contains text\./)
  })

  test('notifies handlers for each call and result', async () => {
    const seen: string[] = []
    const client = scriptedStreamer([
      streamResult({ toolCalls: [callDelta('ws_read_file', '{"path":"a.txt"}')] }),
      streamResult({ content: 'Done.' }),
    ])
    await runAgentLoop({
      client,
      request: baseRequest,
      tools: registry(),
      toolContext,
      handlers: {
        onIteration: (n) => seen.push(`iteration:${n}`),
        onToolCall: (call) => seen.push(`call:${call.function.name}`),
        onToolResult: (call, res) => seen.push(`result:${call.function.name}:${res.isError}`),
      },
    })

    assert.deepEqual(seen, [
      'iteration:1',
      'call:ws_read_file',
      'result:ws_read_file:false',
      'iteration:2',
    ])
  })

  test('carries timings and model from the final round trip', async () => {
    const client = scriptedStreamer([
      streamResult({ toolCalls: [callDelta('ws_read_file', '{"path":"a.txt"}')] }),
      streamResult({ content: 'Done.', model: 'qwen', timings: { predicted_n: 10, predicted_ms: 100 } }),
    ])
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })
    assert.equal(result.model, 'qwen')
    assert.equal(result.timings?.predicted_n, 10)
  })

  test('does not mutate the caller’s message array', async () => {
    const request: ChatCompletionRequest = { messages: [{ role: 'user', content: 'hi' }] }
    const client = scriptedStreamer([
      streamResult({ toolCalls: [callDelta('ws_read_file', '{"path":"a.txt"}')] }),
      streamResult({ content: 'Done.' }),
    ])
    await runAgentLoop({ client, request, tools: registry(), toolContext })
    assert.equal(request.messages.length, 1)
  })
})
