import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  assembleToolCalls,
  runAgentLoop,
  DEFAULT_MAX_ITERATIONS,
  callSignature,
  withHostTools,
  type CompletionStreamer,
} from './loop.ts'
import { MAX_TOOL_CALLS_PER_REPLY, type PlanStep } from './agent-core.ts'
import { ContextTracker } from './context-budget.ts'
import { NestHttpError } from '../nest/types.ts'
import { createToolRegistry } from '../tools/registry.ts'
import type { PendingWrite, Tool, ToolContext } from '../tools/types.ts'
import type { EditorState } from '../tools/editor-context.ts'
import type { ChatCompletionRequest, StreamResult } from '../nest/client.ts'
import type { ToolCallDelta } from '../nest/streaming.ts'

// --- assembleToolCalls ------------------------------------------------------

const delta = (over: Partial<ToolCallDelta> & { index: number }): ToolCallDelta => over

describe('assembleToolCalls', () => {
  test('joins a name and arguments split across many chunks', () => {
    // The wire format: id and name up front, then arguments a slice at a time.
    const calls = assembleToolCalls([
      delta({ index: 0, id: 'call_1', function: { name: 'ys_read_file', arguments: '{"pa' } }),
      delta({ index: 0, function: { arguments: 'th":"a' } }),
      delta({ index: 0, function: { arguments: '.txt"}' } }),
    ])
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], {
      id: 'call_1',
      type: 'function',
      function: { name: 'ys_read_file', arguments: '{"path":"a.txt"}' },
    })
  })

  test('keeps parallel calls separate by index', () => {
    const calls = assembleToolCalls([
      delta({ index: 0, id: 'a', function: { name: 'ys_read_file', arguments: '{"path":"' } }),
      delta({ index: 1, id: 'b', function: { name: 'ys_glob', arguments: '{"pattern":"' } }),
      delta({ index: 0, function: { arguments: 'one.txt"}' } }),
      delta({ index: 1, function: { arguments: '*.ts"}' } }),
    ])
    assert.deepEqual(
      calls.map((c) => [c.function.name, c.function.arguments]),
      [
        ['ys_read_file', '{"path":"one.txt"}'],
        ['ys_glob', '{"pattern":"*.ts"}'],
      ],
    )
  })

  test('returns calls in index order regardless of arrival order', () => {
    const calls = assembleToolCalls([
      delta({ index: 2, id: 'c', function: { name: 'ys_grep', arguments: '{}' } }),
      delta({ index: 0, id: 'a', function: { name: 'ys_read_file', arguments: '{}' } }),
    ])
    assert.deepEqual(calls.map((c) => c.id), ['a', 'c'])
  })

  test('treats a missing index as the first call rather than dropping it', () => {
    // Some servers omit index when there is only ever one call.
    const calls = assembleToolCalls([
      { function: { name: 'ys_read_file', arguments: '{}' } } as unknown as ToolCallDelta,
    ])
    assert.equal(calls.length, 1)
  })

  test('synthesises an id when the server sends none', () => {
    // The id is what matches a result back to its call; without one a
    // multi-call turn misattributes answers.
    const calls = assembleToolCalls([delta({ index: 0, function: { name: 'ys_glob', arguments: '{}' } })])
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
    assert.ok(tools.some((entry) => entry.function.name === 'ys_read_file'))
  })

  test('executes a tool call and feeds the result back', async () => {
    const client = scriptedStreamer([
      streamResult({ toolCalls: [callDelta('ys_read_file', '{"path":"a.txt"}')] }),
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
      streamResult({ content: 'Let me look.', toolCalls: [callDelta('ys_read_file', '{"path":"a.txt"}')] }),
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
          callDelta('ys_read_file', '{"path":"a.txt"}', 0),
          callDelta('ys_list_directory', '{"path":"."}', 1),
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
      streamResult({ toolCalls: [callDelta('ys_read_file', '{"path":"missing.txt"}')] }),
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
    assert.match(result.toolRuns[0]?.result.content ?? '', /ys_read_file/)
  })
})

describe('runAgentLoop — recovery of malformed calls', () => {
  test('recovers a call the model wrote as text instead of tool_calls', async () => {
    // Without this the model narrates work it never did.
    const client = scriptedStreamer([
      streamResult({ content: 'ys_read_file({"path": "a.txt"})' }),
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
        reasoning: 'ys_read_file({"path": "a.txt"})',
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
        content: 'I will also mention ys_glob({"pattern":"*.ts"}) in passing.',
        toolCalls: [callDelta('ys_read_file', '{"path":"a.txt"}')],
      }),
      streamResult({ content: 'Done.' }),
    ])
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })

    assert.equal(result.toolRuns.length, 1)
    assert.equal(result.toolRuns[0]?.call.function.name, 'ys_read_file')
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
        return streamResult({ toolCalls: [callDelta('ys_read_file', '{"path":"a.txt"}')] })
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
        return streamResult({ toolCalls: [callDelta('ys_read_file', '{"path":"a.txt"}')] })
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
      streamResult({ content: 'Let me check.', toolCalls: [callDelta('ys_read_file', '{"path":"a.txt"}')] }),
      streamResult({ content: 'It contains text.' }),
    ])
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })
    assert.match(result.content, /Let me check\./)
    assert.match(result.content, /It contains text\./)
  })

  test('notifies handlers for each call and result', async () => {
    const seen: string[] = []
    const client = scriptedStreamer([
      streamResult({ toolCalls: [callDelta('ys_read_file', '{"path":"a.txt"}')] }),
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
      'call:ys_read_file',
      'result:ys_read_file:false',
      'iteration:2',
    ])
  })

  test('carries timings and model from the final round trip', async () => {
    const client = scriptedStreamer([
      streamResult({ toolCalls: [callDelta('ys_read_file', '{"path":"a.txt"}')] }),
      streamResult({ content: 'Done.', model: 'qwen', timings: { predicted_n: 10, predicted_ms: 100 } }),
    ])
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })
    assert.equal(result.model, 'qwen')
    assert.equal(result.timings?.predicted_n, 10)
  })

  test('does not mutate the caller’s message array', async () => {
    const request: ChatCompletionRequest = { messages: [{ role: 'user', content: 'hi' }] }
    const client = scriptedStreamer([
      streamResult({ toolCalls: [callDelta('ys_read_file', '{"path":"a.txt"}')] }),
      streamResult({ content: 'Done.' }),
    ])
    await runAgentLoop({ client, request, tools: registry(), toolContext })
    assert.equal(request.messages.length, 1)
  })

  test('routes a planned write through the approval gate and reports the outcome', async () => {
    // A tool that returns a PendingWrite but no bytes. The loop must call the
    // gate (and NOT persist anything itself) and tell the model the result.
    const planned: PendingWrite = {
      label: 'edit (1 file)',
      changes: [
        {
          path: 'a.txt',
          absolutePath: path.join(base, 'a.txt'),
          isNew: false,
          isDeleted: false,
          before: 'file contents here\n',
          after: 'file contents here (edited)\n',
          diff: '--- a.txt\n+++ a.txt\n-foo\n+bar',
        },
      ],
    }
    const writeTool: Tool = {
      definition: { name: 'ys_edit_file', description: 'plan a write', inputSchema: { type: 'object', properties: {} } },
      async execute() {
        return { content: 'planned', isError: false, summary: 'planned', truncated: false, pendingWrite: planned }
      },
    }
    const customRegistry = {
      tools: [writeTool],
      names: ['ys_edit_file'],
      payload: () => [{ type: 'function', function: { name: 'ys_edit_file', description: '', parameters: {} } }],
      get: () => writeTool,
      execute: (name: string, args: string, ctx: ToolContext) => writeTool.execute(args, ctx),
    } as unknown as ReturnType<typeof registry>

    const gateCalls: PendingWrite[] = []
    let diskWritten = ''
    const client = scriptedStreamer([
      streamResult({ toolCalls: [callDelta('ys_edit_file', '{}')] }),
      streamResult({ content: 'Applied per your approval.' }),
    ])

    const result = await runAgentLoop({
      client,
      request: baseRequest,
      tools: customRegistry,
      toolContext,
      approveChange: async (pending) => {
        gateCalls.push(pending)
        diskWritten = pending.changes[0]!.after
        return true
      },
    })

    assert.equal(gateCalls.length, 1)
    assert.equal(diskWritten, 'file contents here (edited)\n')
    // The model is told the write happened, and the plan flag is cleared.
    assert.match(result.toolRuns[0]?.result.content ?? '', /Applied/)
    assert.equal(result.toolRuns[0]?.result.pendingWrite, undefined)
  })

  test('the write effect records the checkpoint the gate took', async () => {
    const tools = registry()
    const client = scriptedStreamer([
      streamResult({ toolCalls: [callDelta('ys_write_file', JSON.stringify({ path: 'new.txt', content: 'x\n' }))] }),
      streamResult({ content: 'done' }),
    ])
    const result = await runAgentLoop({
      client,
      request: baseRequest,
      tools,
      toolContext,
      approveChange: async () => ({ applied: true, checkpoint: { revision: 'abc123', root: '/ws' } }),
    })
    const effect = result.toolRuns[0]!.result.effect
    assert.equal(effect?.kind, 'write')
    if (effect?.kind === 'write') {
      assert.equal(effect.applied, true)
      assert.deepEqual(effect.checkpoint, { revision: 'abc123', root: '/ws' })
      assert.equal(effect.files[0]!.path, 'new.txt')
      assert.equal(effect.files[0]!.isNew, true)
      assert.ok(effect.files[0]!.absolutePath)
    }
  })
})

// --- What agent-core brings ---------------------------------------------------
// The loop is agent-core's now. These pin the behaviour Yellowscript gained by
// hosting it, through Yellowscript's ports.

describe('runAgentLoop — agent-core behaviour', () => {
  test('routes ask_user to the host and gives the model the answer', async () => {
    const client = scriptedStreamer([
      streamResult({ toolCalls: [callDelta('ask_user', '{"question":"Which file?","options":["a.txt","b.txt"]}')] }),
      streamResult({ content: 'Reading a.txt.' }),
    ])
    const asked: string[] = []
    const result = await runAgentLoop({
      client,
      request: baseRequest,
      tools: registry(),
      toolContext,
      ask: {
        user: async (request) => {
          asked.push(request.questions[0]!.question)
          return { chosen: ['a.txt'] }
        },
      },
    })

    assert.deepEqual(asked, ['Which file?'])
    const toolMessage = client.requests[1]?.messages.find((m) => m.role === 'tool')
    assert.match(String(toolMessage?.content), /a\.txt/)
    assert.equal(result.stopReason, 'complete')
  })

  test('keeps a plan and gives one more turn when the answer leaves steps open', async () => {
    const client = scriptedStreamer([
      streamResult({
        toolCalls: [callDelta('update_plan', '{"steps":[{"text":"Read a.txt","status":"in_progress"},{"text":"Summarise","status":"pending"}]}')],
      }),
      streamResult({ content: 'Here is a.txt.' }),
      streamResult({ content: 'And the summary.' }),
    ])
    const store: { plan: PlanStep[] | null } = { plan: null }
    const result = await runAgentLoop({
      client,
      request: baseRequest,
      tools: registry(),
      toolContext,
      plan: { get: () => store.plan, save: (steps) => { store.plan = steps } },
    })

    assert.equal(store.plan?.length, 2)
    assert.equal(client.requests.length, 3, 'one extra turn for the open steps')
    const tail = client.requests[2]?.messages.at(-1)
    assert.match(String(tail?.content), /still open/)
    assert.equal(result.content, 'Here is a.txt.\n\nAnd the summary.')
  })

  test('runs at most the per-reply limit of calls and answers the rest', async () => {
    const many = Array.from({ length: MAX_TOOL_CALLS_PER_REPLY + 3 }, (_, i) =>
      callDelta('ys_read_file', '{"path":"a.txt"}', i),
    )
    const client = scriptedStreamer([streamResult({ toolCalls: many }), streamResult({ content: 'ok' })])
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })

    assert.equal(result.toolRuns.length, MAX_TOOL_CALLS_PER_REPLY)
    const results = client.requests[1]?.messages.filter((m) => m.role === 'tool') ?? []
    assert.equal(results.length, many.length, 'every call has a result, run or not')
  })

  test('sends an earlier call with malformed arguments back as "{}"', async () => {
    // llama-server fails the whole request when one call's arguments in the
    // history do not parse.
    const client = scriptedStreamer([
      streamResult({ toolCalls: [callDelta('ys_read_file', '<parameter=path>a.txt')] }),
      streamResult({ content: 'sorry' }),
    ])
    await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })
    const assistant = client.requests[1]?.messages.find((m) => m.role === 'assistant') as
      | { tool_calls?: Array<{ function: { arguments: string } }> }
      | undefined
    assert.equal(assistant?.tool_calls?.[0]?.function.arguments, '{}')
  })

  test('goes on past the turn limit when the host says so', async () => {
    let n = 0
    const client: CompletionStreamer = {
      async streamChatCompletion() {
        n++
        return n <= 3
          ? streamResult({ toolCalls: [callDelta('ys_read_file', '{"path":"a.txt"}')] })
          : streamResult({ content: 'done' })
      },
    }
    let asked = 0
    const result = await runAgentLoop({
      client,
      request: baseRequest,
      tools: registry(),
      toolContext,
      maxIterations: 2,
      askContinue: async () => {
        asked++
        return true
      },
    })
    assert.equal(asked, 1)
    assert.equal(result.stopReason, 'complete')
    assert.equal(result.content, 'done')
  })
})

// --- Long runs: the repeat check and the context budget ----------------------

describe('runAgentLoop — long runs', () => {
  test('a call repeated with identical arguments is not run past the limit', async () => {
    const same = () => streamResult({ toolCalls: [callDelta('ys_read_file', '{"path":"a.txt"}')] })
    const client = scriptedStreamer([same(), same(), same(), same(), same(), streamResult({ content: 'Giving up.' })])
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })

    const notRun = result.toolRuns.filter((r) => r.result.summary === 'Not run: repeated call')
    assert.equal(result.toolRuns.length, 5)
    assert.equal(notRun.length, 2, 'calls 4 and 5 are refused')
    assert.match(notRun[0]!.result.content, /3 times in this task/)
    assert.equal(result.stopReason, 'complete')
  })

  test('different arguments are not a repeat', async () => {
    const client = scriptedStreamer([
      ...Array.from({ length: 5 }, (_, i) =>
        streamResult({ toolCalls: [callDelta('ys_read_file', `{"path":"a.txt","offset":${i + 1}}`)] }),
      ),
      streamResult({ content: 'done' }),
    ])
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext })
    assert.ok(result.toolRuns.every((r) => r.result.summary !== 'Not run: repeated call'))
  })

  test('the default cap allows a long task', () => {
    assert.ok(DEFAULT_MAX_ITERATIONS >= 40)
  })

  /** A workspace file big enough that a few reads fill a small window. */
  const bigFile = path.join(base, 'big.txt')
  fs.writeFileSync(bigFile, Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n'))
  const readBig = (i: number) =>
    streamResult({ toolCalls: [{ index: 0, id: `r${i}`, function: { name: 'ys_read_file', arguments: `{"path":"big.txt","offset":${i + 1}}` } }] })

  test('trims old results before a request that would overflow', async () => {
    const client = scriptedStreamer([...Array.from({ length: 6 }, (_, i) => readBig(i)), streamResult({ content: 'read them all' })])
    const tracker = new ContextTracker({ props: async () => ({ nCtx: 16_384 }) })
    const trims: number[] = []
    const result = await runAgentLoop({
      client,
      request: baseRequest,
      tools: registry(),
      toolContext,
      context: tracker,
      handlers: { onContextTrimmed: (r) => trims.push(r.stubbed) },
    })

    assert.equal(result.stopReason, 'complete')
    assert.ok(trims.length > 0, 'a trim happened')
    const lastRequest = client.requests.at(-1)!
    const stubs = lastRequest.messages.filter((m) => m.role === 'tool' && String(m.content).startsWith('[Earlier result of ys_read_file'))
    assert.ok(stubs.length > 0)
    assert.equal(lastRequest.messages[0]!.content, 'read a.txt', 'the request is never trimmed')
    // The run's record keeps the full results.
    assert.ok(result.toolRuns.every((r) => !r.result.content.startsWith('[Earlier result')))
  })

  test('a context-exceeded refusal teaches n_ctx, trims, and retries once', async () => {
    const script = [...Array.from({ length: 4 }, (_, i) => readBig(i)), streamResult({ content: 'done' })]
    const requests: ChatCompletionRequest[] = []
    let refused = false
    const client = {
      requests,
      async streamChatCompletion(request: ChatCompletionRequest) {
        requests.push(structuredClone(request))
        const toolResults = request.messages.filter((m) => m.role === 'tool' && !String(m.content).startsWith('[Earlier'))
        // The server's window holds two full results; the third overflows.
        if (toolResults.length >= 3 && !refused) {
          refused = true
          throw new NestHttpError(400, 'request exceeds the available context size', undefined, { nCtx: 8_192, promptTokens: 9_500 })
        }
        const turn = requests.length - (refused ? 2 : 1)
        return script[turn] ?? streamResult({ content: 'fallback' })
      },
    }
    // /props unavailable: nothing is known until the server says.
    const tracker = new ContextTracker({ props: async () => ({ nCtx: null }) })
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext, context: tracker })

    assert.equal(refused, true)
    assert.equal(tracker.contextSize, 8_192)
    const retried = requests[requests.findIndex((r) => r.messages.filter((m) => m.role === 'tool').length >= 3) + 1]!
    assert.ok(retried.messages.some((m) => m.role === 'tool' && String(m.content).startsWith('[Earlier result')))
    assert.equal(result.stopReason, 'complete')
  })

  test('a second refusal is reported, not retried forever', async () => {
    let calls = 0
    const client = {
      async streamChatCompletion(): Promise<StreamResult> {
        calls++
        throw new NestHttpError(400, 'too big', undefined, { nCtx: 4_096 })
      },
    }
    const tracker = new ContextTracker({ props: async () => ({ nCtx: 4_096 }) })
    await assert.rejects(runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext, context: tracker }), /too big/)
    assert.equal(calls, 2)
  })
})

describe('runAgentLoop — diagnostics after a write', () => {
  test('an applied write carries the problems now in that file; a rejected one does not ask', async () => {
    const asked: string[][] = []
    const run = (approve: boolean) =>
      runAgentLoop({
        client: scriptedStreamer([
          streamResult({ toolCalls: [callDelta('ys_replace', '{"path":"a.txt","old_string":"contents","new_string":"text"}')] }),
          streamResult({ content: 'done' }),
        ]),
        request: baseRequest,
        tools: registry(),
        toolContext,
        approveChange: async () => approve,
        diagnosticsAfterWrite: async (files) => {
          asked.push(files)
          return 'Diagnostics after this write: 1 error, 0 warnings.\n- error a.txt:1:1: broken'
        },
      })

    const applied = await run(true)
    assert.match(applied.toolRuns[0]!.result.content, /Applied[\s\S]*1 error[\s\S]*broken/)
    assert.deepEqual(asked, [[path.join(base, 'a.txt')]])

    const rejected = await run(false)
    assert.doesNotMatch(rejected.toolRuns[0]!.result.content, /Diagnostics/)
    assert.equal(asked.length, 1)
  })
})

describe('runAgentLoop — images in tool results', () => {
  const withImage = () => {
    const base = registry()
    return {
      ...base,
      names: base.names,
      payload: () => base.payload(),
      execute: async () => ({ content: 'page loaded', isError: false, summary: 'checked', truncated: false, images: ['data:image/png;base64,AAAA'] }),
    } as unknown as ReturnType<typeof registry>
  }
  const run = async (vision: boolean) => {
    const client = scriptedStreamer([
      streamResult({ toolCalls: [callDelta('ys_read_file', '{"path":"a.txt"}')] }),
      streamResult({ content: 'seen' }),
    ])
    const tracker = new ContextTracker({ props: async () => ({ nCtx: 32_768, vision }) })
    await runAgentLoop({ client, request: baseRequest, tools: withImage(), toolContext, context: tracker })
    return client.requests[1]!.messages.find((m) => m.role === 'tool')!.content
  }

  test('a model that reads images gets the screenshot as an image part', async () => {
    const content = await run(true)
    assert.ok(Array.isArray(content))
    assert.deepEqual((content as Array<{ type: string }>).map((p) => p.type), ['text', 'image_url'])
  })

  test('a text-only model gets the text alone', async () => {
    assert.equal(await run(false), 'page loaded')
  })
})

describe('runAgentLoop — a model that cannot stop (2026-11-19)', () => {
  test('numbered variants of one command count as a repeat', async () => {
    // Real commands (not no-ops), numbered to dodge an exact check.
    const variant = (n: number) => streamResult({ toolCalls: [callDelta('ys_run_command', `{"command":"node -e \\"console.log(${n})\\""}`)] })
    const client = scriptedStreamer([variant(1), variant(2), variant(3), variant(4), variant(5), streamResult({ content: 'ok' })])
    const result = await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext, approveCommand: async () => ({ text: 'Exit code 0', isError: false }) })
    assert.equal(result.toolRuns.filter((r) => r.result.summary === 'Not run: repeated call').length, 2)
  })

  test('reads of different files are never a repeat', () => {
    assert.notEqual(callSignature('ys_read_file', '{"path":"data/level-01.txt"}'), callSignature('ys_read_file', '{"path":"data/level-02.txt"}'))
    assert.equal(callSignature('ys_run_command', '{"command":"echo break2"}'), callSignature('ys_run_command', '{"command":"echo break3"}'))
    // A start is a command; reading two processes' output is not one call.
    assert.equal(callSignature('ys_process', '{"action":"start","command":"node s1.js"}'), callSignature('ys_process', '{"action":"start","command":"node s2.js"}'))
    assert.notEqual(callSignature('ys_process', '{"action":"output","id":"p1"}'), callSignature('ys_process', '{"action":"output","id":"p2"}'))
  })

  test('ask_user and update_plan are offered even when Nest offers nothing', async () => {
    const client = scriptedStreamer([streamResult({ content: 'hi' })])
    await runAgentLoop({ client, request: baseRequest, tools: registry(), toolContext, ask: { user: async () => null }, plan: { get: () => null, save: () => {} } })
    const names = (client.requests[0]!.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    assert.ok(names.includes('ask_user'))
    assert.ok(names.includes('update_plan'))
  })

  test('without the ports they are not offered, and Nest\'s own copy is not duplicated', () => {
    const base = registry().payload()
    assert.equal(withHostTools(base, {}), base)
    const nestHasIt = [...base, { type: 'function' as const, function: { name: 'ask_user', description: 'nest', parameters: {} } }]
    const merged = withHostTools(nestHasIt, { ask: { user: async () => null } })
    assert.equal(merged.filter((t) => t.function.name === 'ask_user').length, 1)
    assert.equal(merged.find((t) => t.function.name === 'ask_user')!.function.description, 'nest')
  })
})
