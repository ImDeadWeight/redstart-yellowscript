import { test, describe, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { ChatSession } from './session.ts'
import type { HostMessage } from './protocol.ts'
import type { ChatCompletionRequest, NestClient, StreamHandlers, StreamResult } from '../nest/client.ts'
import { NestHttpError } from '../nest/types.ts'
import { createToolRegistry } from '../tools/registry.ts'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type StreamScript = (
  request: ChatCompletionRequest,
  handlers: StreamHandlers,
  signal?: AbortSignal,
) => Promise<StreamResult>

/** Minimal stand-in for NestClient — the session only ever calls this one method. */
function fakeClient(script: StreamScript): NestClient {
  return { streamChatCompletion: script } as unknown as NestClient
}

const emptyResult = (over: Partial<StreamResult> = {}): StreamResult => ({
  content: '',
  reasoning: '',
  toolCalls: [],
  aborted: false,
  ...over,
})

/** A stream that emits the given content and finishes normally. */
const says = (content: string, over: Partial<StreamResult> = {}): StreamScript =>
  async (_req, handlers) => {
    if (content) handlers.onContent?.(content)
    return emptyResult({ content, ...over })
  }

class Harness {
  emitted: HostMessage[] = []
  unauthorizedCalls = 0
  requests: ChatCompletionRequest[] = []
  session: ChatSession
  private script: StreamScript = says('ok')
  private client: NestClient | null

  constructor(options: { connected?: boolean } = {}) {
    this.client = options.connected === false ? null : fakeClient((req, handlers, signal) => {
      this.requests.push(req)
      return this.script(req, handlers, signal)
    })

    let counter = 0
    this.session = new ChatSession({
      getClient: () => this.client,
      onUnauthorized: () => {
        this.unauthorizedCalls++
      },
      emit: (message) => this.emitted.push(message),
      newId: () => `id${++counter}`,
    })
  }

  respond(script: StreamScript): void {
    this.script = script
  }

  ofType<T extends HostMessage['type']>(type: T): Array<Extract<HostMessage, { type: T }>> {
    return this.emitted.filter((m) => m.type === type) as Array<Extract<HostMessage, { type: T }>>
  }

  get lastRequest(): ChatCompletionRequest {
    return this.requests[this.requests.length - 1] as ChatCompletionRequest
  }
}

// ---------------------------------------------------------------------------

describe('ChatSession — a normal turn', () => {
  let h: Harness
  beforeEach(() => {
    h = new Harness()
  })

  test('adds the user message and the assistant turn before streaming', async () => {
    h.respond(says('Hello there'))
    await h.session.send('hi')

    const messages = h.ofType('message')
    assert.equal(messages.length, 2)
    assert.deepEqual(messages[0]?.message, { id: 'id1', role: 'user', content: 'hi' })
    // The assistant turn is announced empty and streaming, so the UI can show a
    // placeholder immediately rather than after the first token.
    assert.equal(messages[1]?.message.role, 'assistant')
    assert.equal(messages[1]?.message.streaming, true)
  })

  test('streams content deltas tagged with the turn id', async () => {
    h.respond(async (_req, handlers) => {
      handlers.onContent?.('Hel')
      handlers.onContent?.('lo')
      return emptyResult({ content: 'Hello' })
    })
    await h.session.send('hi')

    const deltas = h.ofType('turn/delta')
    assert.deepEqual(
      deltas.map((d) => [d.channel, d.text]),
      [
        ['content', 'Hel'],
        ['content', 'lo'],
      ],
    )
    assert.ok(
      deltas.every((d) => d.id === 'id2'),
      'every delta must name its turn so a late one cannot append to a different message',
    )
  })

  test('keeps reasoning on its own channel and off the visible content', async () => {
    h.respond(async (_req, handlers) => {
      handlers.onReasoning?.('thinking')
      handlers.onContent?.('answer')
      return emptyResult({ content: 'answer', reasoning: 'thinking' })
    })
    await h.session.send('hi')

    const deltas = h.ofType('turn/delta')
    assert.deepEqual(deltas.map((d) => d.channel), ['reasoning', 'content'])

    const turn = h.session.transcript[1]
    assert.equal(turn?.content, 'answer')
    assert.equal(turn?.reasoning, 'thinking')
  })

  test('completes the turn with stats derived from timings', async () => {
    h.respond(
      says('done', { timings: { predicted_n: 20, predicted_ms: 1000, prompt_n: 7 }, finishReason: 'stop' }),
    )
    await h.session.send('hi')

    const completed = h.ofType('turn/completed')[0]
    assert.equal(completed?.stats?.tokensPerSecond, 20)
    assert.equal(completed?.stats?.completionTokens, 20)
    assert.equal(completed?.stats?.promptTokens, 7)
    assert.equal(completed?.stats?.finishReason, 'stop')
    assert.equal(h.session.transcript[1]?.streaming, false)
  })

  test('records the model name reported by the stream', async () => {
    h.respond(async (_req, handlers) => {
      handlers.onModel?.('qwen3.6-35b')
      return emptyResult({ content: 'x', model: 'qwen3.6-35b' })
    })
    await h.session.send('hi')
    assert.equal(h.session.currentModel, 'qwen3.6-35b')
  })

  test('trims the prompt and ignores an empty one', async () => {
    await h.session.send('   ')
    assert.equal(h.emitted.length, 0, 'whitespace should not start a turn')

    await h.session.send('  hi  ')
    assert.equal(h.ofType('message')[0]?.message.content, 'hi')
  })
})

describe('ChatSession — request construction', () => {
  let h: Harness
  beforeEach(() => {
    h = new Harness()
  })

  test('sends no tools in Phase 1', async () => {
    // Load-bearing, not an omission: the gateway only claims Nest capabilities
    // in its injected system prompt when the request actually carries tools. A
    // toolless request correctly yields a model that knows it cannot call
    // anything. Do not "fix" this before Phase 2.
    await h.session.send('hi')
    assert.equal(h.lastRequest.tools, undefined)
  })

  test('replays the conversation so far as context', async () => {
    h.respond(says('first reply'))
    await h.session.send('one')
    h.respond(says('second reply'))
    await h.session.send('two')

    assert.deepEqual(h.lastRequest.messages, [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'two' },
    ])
  })

  test('excludes a failed turn from the next request', async () => {
    // Replaying an error message back as the assistant's own words teaches the
    // model to imitate the failure.
    h.respond(async () => {
      throw new NestHttpError(500, 'internal explosion')
    })
    await h.session.send('one')

    h.respond(says('recovered'))
    await h.session.send('two')

    assert.deepEqual(h.lastRequest.messages, [
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
    ])
  })

  test('keeps an aborted turn as context', async () => {
    // Partial text is still something the assistant said. Dropping it would
    // leave a follow-up of "continue" with nothing to refer to.
    h.respond(async (_req, handlers) => {
      handlers.onContent?.('half a th')
      return emptyResult({ content: 'half a th', aborted: true })
    })
    await h.session.send('one')

    h.respond(says('…ought'))
    await h.session.send('continue')

    assert.deepEqual(h.lastRequest.messages, [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'half a th' },
      { role: 'user', content: 'continue' },
    ])
  })

  test('does not send reasoning back as context', async () => {
    // Context is the scarce resource on a 32k local model; the thinking of a
    // previous turn is the first thing worth spending it on elsewhere.
    h.respond(async () => emptyResult({ content: 'answer', reasoning: 'long deliberation' }))
    await h.session.send('one')
    h.respond(says('next'))
    await h.session.send('two')

    const assistant = h.lastRequest.messages.find((m) => m.role === 'assistant')
    assert.equal(assistant?.content, 'answer')
    assert.equal(assistant?.reasoning_content, undefined)
  })
})

describe('ChatSession — failures', () => {
  let h: Harness
  beforeEach(() => {
    h = new Harness()
  })

  test('never rejects, whatever the client throws', async () => {
    // A rejected promise here surfaces as an unhandled rejection in the
    // extension host, which the user never sees. Every failure must become a
    // message instead.
    h.respond(async () => {
      throw new Error('kaboom')
    })
    await assert.doesNotReject(() => h.session.send('hi'))
    assert.equal(h.ofType('turn/failed')[0]?.message, 'kaboom')
  })

  test('reports a 401 in plain language and asks for re-authentication once', async () => {
    h.respond(async () => {
      throw new NestHttpError(401, 'Unauthorized')
    })
    await h.session.send('hi')

    assert.equal(h.unauthorizedCalls, 1)
    assert.match(h.ofType('turn/failed')[0]?.message ?? '', /sign in again/i)
  })

  test('reports "no model running" distinctly from a connection failure', async () => {
    h.respond(async () => {
      throw new NestHttpError(502, 'No model is running on the Nest')
    })
    await h.session.send('hi')

    assert.match(h.ofType('turn/failed')[0]?.message ?? '', /No model is running/i)
    assert.equal(h.unauthorizedCalls, 0)
  })

  test('treats a completely empty response as an error, not a blank success', async () => {
    // Silence renders as a broken extension. Say what happened.
    h.respond(says(''))
    await h.session.send('hi')

    assert.equal(h.session.transcript[1]?.error, 'The model returned an empty response.')
  })

  test('does not call it empty when the model only produced reasoning', async () => {
    h.respond(async () => emptyResult({ reasoning: 'thought about it' }))
    await h.session.send('hi')
    assert.equal(h.session.transcript[1]?.error, undefined)
  })

  test('does not call an aborted turn empty', async () => {
    h.respond(async () => emptyResult({ aborted: true }))
    await h.session.send('hi')
    assert.equal(h.session.transcript[1]?.error, undefined)
  })

  test('refuses to send when not connected', async () => {
    const offline = new Harness({ connected: false })
    await offline.session.send('hi')

    assert.deepEqual(offline.ofType('message'), [], 'nothing should be added to the transcript')
    assert.equal(offline.ofType('notice')[0]?.level, 'error')
  })
})

describe('ChatSession — concurrency and abort', () => {
  test('refuses a second send while a turn is streaming', async () => {
    const h = new Harness()
    let release: (() => void) | undefined
    h.respond(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return emptyResult({ content: 'done' })
    })

    const first = h.session.send('one')
    await h.session.send('two')

    assert.equal(h.ofType('notice')[0]?.level, 'warning')
    assert.equal(h.requests.length, 1, 'a second request must not be issued')

    release?.()
    await first
  })

  test('abort passes a signal the client can observe', async () => {
    const h = new Harness()
    let observed: AbortSignal | undefined
    h.respond(async (_req, handlers, signal) => {
      observed = signal
      handlers.onContent?.('partial')
      h.session.abort()
      return emptyResult({ content: 'partial', aborted: signal?.aborted === true })
    })

    await h.session.send('hi')
    assert.equal(observed?.aborted, true)
    assert.equal(h.session.transcript[1]?.aborted, true)
    assert.equal(h.session.transcript[1]?.content, 'partial', 'partial text must survive the abort')
    assert.equal(h.ofType('turn/completed')[0]?.aborted, true)
  })

  test('is no longer busy once a turn ends', async () => {
    const h = new Harness()
    assert.equal(h.session.busy, false)
    await h.session.send('hi')
    assert.equal(h.session.busy, false)
  })

  test('stays usable after a failure', async () => {
    const h = new Harness()
    h.respond(async () => {
      throw new Error('kaboom')
    })
    await h.session.send('one')
    assert.equal(h.session.busy, false, 'a thrown turn must still release the lock')

    h.respond(says('recovered'))
    await h.session.send('two')
    assert.equal(h.ofType('turn/completed').length, 1)
  })
})

describe('ChatSession — reset', () => {
  test('clears the transcript and announces the empty conversation', async () => {
    const h = new Harness()
    await h.session.send('hi')
    h.session.reset()

    assert.deepEqual(h.session.transcript, [])
    const conversations = h.ofType('conversation')
    assert.deepEqual(conversations[conversations.length - 1]?.messages, [])
  })

  test('aborts a turn in flight rather than orphaning it', async () => {
    const h = new Harness()
    let observed: AbortSignal | undefined
    h.respond(async (_req, _handlers, signal) => {
      observed = signal
      h.session.reset()
      return emptyResult({ aborted: true })
    })

    await h.session.send('hi')
    assert.equal(observed?.aborted, true)
  })
})

// ---------------------------------------------------------------------------
// The Phase 2 seam: with tools available, a turn becomes a loop.
// ---------------------------------------------------------------------------

describe('ChatSession with tools', () => {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-session-')))
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'the answer is 42\n')
  after(() => fs.rmSync(workspace, { recursive: true, force: true }))

  const registry = () =>
    createToolRegistry({
      ripgrepPath: null,
      diagnostics: () => [],
      editorState: () => ({
        activeFile: null,
        languageId: null,
        isDirty: false,
        cursor: null,
        selection: null,
        openFiles: [],
      }),
    })

  /** Calls a tool on the first round trip, answers on the second. */
  const readsThenAnswers = (): StreamScript => {
    let call = 0
    return async (_req, handlers) => {
      call++
      if (call === 1) {
        return emptyResult({
          toolCalls: [
            { index: 0, id: 'c1', function: { name: 'ws_read_file', arguments: '{"path":"note.txt"}' } },
          ],
        })
      }
      handlers.onContent?.('It says 42.')
      return emptyResult({ content: 'It says 42.' })
    }
  }

  function withTools(script: StreamScript) {
    const emitted: HostMessage[] = []
    const session = new ChatSession({
      getClient: () => fakeClient(script),
      onUnauthorized: () => {},
      emit: (message) => emitted.push(message),
      newId: (() => {
        let n = 0
        return () => `id-${++n}`
      })(),
      tools: () => registry(),
      toolContext: () => ({ workspaceRoots: [workspace] }),
    })
    return { session, emitted }
  }

  test('executes a tool call and answers from its result', async () => {
    const h = withTools(readsThenAnswers())
    await h.session.send('what does note.txt say?')

    const turn = h.session.snapshot().find((message) => message.role === 'assistant')
    assert.match(turn?.content ?? '', /It says 42\./)
  })

  test('emits tool/call and tool/result carrying the turn id', async () => {
    // Structure gets its own message types — the renderer must not have to
    // parse prose to find out what ran. The turn id is what stops a late
    // message attaching to the turn that replaced it.
    const h = withTools(readsThenAnswers())
    await h.session.send('read it')

    const call = h.emitted.find((m) => m.type === 'tool/call')
    assert.ok(call && call.type === 'tool/call')
    assert.equal(call.name, 'ws_read_file')
    assert.equal(call.recovered, false)

    const result = h.emitted.find((m) => m.type === 'tool/result')
    assert.ok(result && result.type === 'tool/result')
    assert.equal(result.isError, false)
    assert.equal(result.callId, call.callId)
    assert.equal(result.turnId, call.turnId)
  })

  test('sends the tool payload to the Nest', async () => {
    // Sending tools is also what makes the gateway claim Nest capabilities.
    let seen: ChatCompletionRequest | undefined
    const h = withTools(async (request, handlers) => {
      seen = request
      handlers.onContent?.('done')
      return emptyResult({ content: 'done' })
    })
    await h.session.send('hello')

    const tools = seen?.tools as Array<{ function: { name: string } }> | undefined
    assert.ok(tools?.some((entry) => entry.function.name === 'ws_read_file'))
  })

  test('withholding the registry keeps the Phase 1 single round trip', async () => {
    // With no folder open the tools can only refuse, so they are not offered.
    let seen: ChatCompletionRequest | undefined
    const emitted: HostMessage[] = []
    const session = new ChatSession({
      getClient: () =>
        fakeClient(async (request, handlers) => {
          seen = request
          handlers.onContent?.('plain answer')
          return emptyResult({ content: 'plain answer' })
        }),
      onUnauthorized: () => {},
      emit: (message) => emitted.push(message),
      tools: () => null,
    })
    await session.send('hi')

    assert.equal(seen?.tools, undefined)
    assert.ok(!emitted.some((m) => m.type === 'tool/call'))
  })
})
