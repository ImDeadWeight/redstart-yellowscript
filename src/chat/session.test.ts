import { test, describe, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { ChatSession, RESUME_PROMPT, type SessionDeps } from './session.ts'
import { BackgroundProcesses } from '../tools/process-runner.ts'
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
      conversationId: 'test',
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
  test('queues a second send while a turn is streaming', async () => {
    const h = new Harness()
    let release: (() => void) | undefined
    let requests = 0
    h.respond(async () => {
      // Only the first request blocks. The queued turn that drains after it
      // must be answered, or `await first` waits on it forever.
      if (requests++ === 0) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return emptyResult({ content: 'done' })
    })

    const first = h.session.send('one')
    await h.session.send('two')

    // Second prompt is queued, not rejected. A pending user message is emitted.
    const notices = h.ofType('notice')
    assert.equal(notices.length, 0, 'no warning notice is emitted; the prompt queues')
    const pending = h.ofType('message').find((m) => m.message.pending === true)
    assert.ok(pending, 'queued prompt emits a pending user message')
    assert.equal(pending.message.content, 'two')
    assert.equal(h.requests.length, 1, 'only the first request is issued')

    release?.()
    await first
    // After first completes, the queued turn runs as a second request.
    assert.equal(h.requests.length, 2, 'queued turn runs after the first finishes')
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
            { index: 0, id: 'c1', function: { name: 'ys_read_file', arguments: '{"path":"note.txt"}' } },
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
      conversationId: 'test',
      onUnauthorized: () => {},
      emit: (message) => emitted.push(message),
      newId: (() => {
        let n = 0
        return () => `id-${++n}`
      })(),
      tools: () => registry(),
      toolContext: () => ({ workspaceRoots: [workspace] }),
    })
    return { session, emitted, ofType: <T extends HostMessage['type']>(type: T) => emitted.filter((m) => m.type === type) as Array<Extract<HostMessage, { type: T }>> }
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

    const call = h.ofType('tool/call')[0]
    assert.ok(call && call.type === 'tool/call')
    assert.equal(call.name, 'ys_read_file')
    assert.equal(call.recovered, false)

    const result = h.ofType('tool/result')[0]
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
    assert.ok(tools?.some((entry) => entry.function.name === 'ys_read_file'))
  })

  test('sends no client system message — the Nest owns the system context', async () => {
    // The Nest gateway derives capability claims from THIS request's tools
    // array (it prepends an identity + tool-policy block that only fires when
    // tools are actually present), and reads the Yellowscript surface from the
    // credential. So Yellowscript must NOT send its own system prose: doing so
    // would both duplicate the gateway's block and go stale the moment the tool
    // set changes. The client sends only user/assistant turns and the tools.
    let seen: ChatCompletionRequest | undefined
    const h = withTools(async (request, handlers) => {
      seen = request
      handlers.onContent?.('ok')
      return emptyResult({ content: 'ok' })
    })
    await h.session.send('hello')

    assert.ok(
      !seen?.messages.some((message) => message.role === 'system'),
      'a client-supplied system message would double the gateway’s injected context',
    )
    // Tools still go out — that is what makes the gateway emit its capability
    // block, and what lets the model actually call them.
    const tools = seen?.tools as Array<{ function: { name: string } }> | undefined
    assert.ok(tools?.some((entry) => entry.function.name === 'ys_read_file'))
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
      conversationId: 'test',
      tools: () => null,
    })
    await session.send('hi')

    assert.equal(seen?.tools, undefined)
    assert.ok(!emitted.some((m) => m.type === 'tool/call'))
    // And no system message: with no tools going out the gateway sends bare
    // identity text, so there is no over-claim to correct and no reason to
    // spend context correcting it.
    assert.ok(!seen?.messages.some((message) => message.role === 'system'))
  })
})

// ---------------------------------------------------------------------------
// The question, the plan and the turn limit (agent-core's host ports)
// ---------------------------------------------------------------------------

describe('ChatSession — ask_user, update_plan and the turn limit', () => {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-ports-')))
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'hello\n')
  after(() => fs.rmSync(workspace, { recursive: true, force: true }))

  const registry = () =>
    createToolRegistry({
      ripgrepPath: null,
      diagnostics: () => [],
      editorState: () => ({ activeFile: null, languageId: null, isDirty: false, cursor: null, selection: null, openFiles: [] }),
    })

  /** Scripted round trips; each entry is one model reply. */
  function scripted(replies: Array<Partial<StreamResult>>, extra: Partial<SessionDeps> = {}) {
    const requests: ChatCompletionRequest[] = []
    const emitted: HostMessage[] = []
    let persisted = 0
    let n = 0
    const session = new ChatSession({
      getClient: () =>
        fakeClient(async (req, handlers) => {
          requests.push(structuredClone(req))
          const next = replies[requests.length - 1] ?? { content: 'fallback' }
          if (next.content) handlers.onContent?.(next.content)
          return emptyResult(next)
        }),
      conversationId: 'test',
      onUnauthorized: () => {},
      emit: (message) => emitted.push(message),
      newId: () => `id-${++n}`,
      tools: () => registry(),
      toolContext: () => ({ workspaceRoots: [workspace] }),
      onPersist: () => {
        persisted++
      },
      ...extra,
    })
    const states = () => emitted.filter((m) => m.type === 'conversationState').map((m) => (m as Extract<HostMessage, { type: 'conversationState' }>).state)
    return { session, requests, emitted, states, persisted: () => persisted }
  }

  const call = (name: string, args: unknown) => ({
    toolCalls: [{ index: 0, id: 'q1', function: { name, arguments: JSON.stringify(args) } }],
  })
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 1))
  }

  test('shows the question, and the picked option reaches the model', async () => {
    const h = scripted([call('ask_user', { question: 'Which one?', options: ['A', 'B'] }), { content: 'Going with A.' }])
    const done = h.session.send('do it')
    await until(() => h.session.state().question !== null)

    const question = h.session.state().question
    assert.equal(question?.question, 'Which one?')
    assert.deepEqual(question?.options, ['A', 'B'])
    assert.equal(h.session.answer('not-this-one', { chosen: ['B'] }), false, 'an answer must name the open question')
    assert.equal(h.session.answer(question!.id, { chosen: ['A'] }), true)
    await done

    assert.equal(h.session.state().question, null)
    const toolMessage = h.requests[1]?.messages.find((m) => m.role === 'tool')
    assert.match(String(toolMessage?.content), /\bA\b/)
    const turn = h.session.snapshot().find((m) => m.role === 'assistant')
    assert.equal(turn?.tools?.[0]?.name, 'ask_user')
    assert.match(turn?.tools?.[0]?.summary ?? '', /Answered: A/)
  })

  test('a message typed while the question is open is the answer, not a queued prompt', async () => {
    const h = scripted([call('ask_user', { question: 'Name?' }), { content: 'Hi Sam.' }])
    const done = h.session.send('greet me')
    await until(() => h.session.state().question !== null)
    await h.session.send('Sam')
    await done

    assert.equal(h.session.queued, 0)
    assert.equal(h.requests.length, 2)
    assert.match(String(h.requests[1]?.messages.find((m) => m.role === 'tool')?.content), /Sam/)
  })

  test('several questions in one call are one card, answered together', async () => {
    const h = scripted([
      call('ask_user', {
        questions: [
          { header: 'Engine', question: 'Canvas or DOM?', options: ['Canvas', 'DOM'] },
          { question: 'Name the hero?' },
        ],
      }),
      { content: 'Building it.' },
    ])
    const done = h.session.send('make a game')

    await until(() => h.session.state().question !== null)
    const card = h.session.state().question!
    assert.equal(card.questions?.length, 2)
    assert.deepEqual(card.questions?.[0], { header: 'Engine', question: 'Canvas or DOM?', multiSelect: false, options: ['Canvas', 'DOM'] })
    assert.equal(card.question, 'Canvas or DOM?', 'the first question is mirrored for a one-question view')
    assert.equal(h.session.answer(card.id, { answers: [{ chosen: ['Canvas'] }, null] }), true)
    await done

    const tool = String(h.requests[1]?.messages.find((m) => m.role === 'tool')?.content)
    assert.match(tool, /1\. Canvas or DOM\?\n.*Canvas/)
    assert.match(tool, /did not answer/)
  })

  test('a message typed during several questions answers them all at once', async () => {
    const h = scripted([
      call('ask_user', { questions: [{ question: 'Colour?' }, { question: 'Size?' }] }),
      { content: 'OK.' },
    ])
    const done = h.session.send('style it')
    await until(() => h.session.state().question !== null)
    await h.session.send('red and large')
    await done

    assert.equal(h.requests.length, 2)
    assert.equal(h.session.state().question, null)
    assert.match(String(h.requests[1]?.messages.find((m) => m.role === 'tool')?.content), /all your questions in one message/)
  })

  test('stopping the flow skips the open question', async () => {
    const h = scripted([call('ask_user', { question: 'Sure?' })])
    const done = h.session.send('go')
    await until(() => h.session.state().question !== null)
    h.session.abort()
    await done
    assert.equal(h.session.state().question, null)
  })

  test('keeps the plan, saves it, and lets the person clear it', async () => {
    const h = scripted([
      call('update_plan', { steps: [{ text: 'Read', status: 'done' }, { text: 'Write', status: 'pending' }] }),
      { content: 'Read it. Is that all?' },
    ])
    await h.session.send('plan it')

    assert.deepEqual(h.session.planSnapshot()?.map((s) => s.status), ['done', 'pending'])
    assert.ok(h.states().some((s) => s.plan?.length === 2), 'the panel was told')
    assert.ok(h.persisted() > 0)

    h.session.clearPlan()
    assert.equal(h.session.state().plan, null)
  })

  test('a loaded plan rides on the next request as the tail note', async () => {
    const h = scripted([{ content: 'ok' }])
    h.session.load([], [{ text: 'Write the tests', status: 'in_progress' }])
    await h.session.send('carry on')
    const last = h.requests[0]?.messages.at(-1)
    assert.match(String(last?.content), /Write the tests/)
  })

  test('waits at the turn limit, and goes on when the person says so', async () => {
    const reads = Array.from({ length: 12 }, () => call('ys_read_file', { path: 'note.txt' }))
    const h = scripted([...reads, { content: 'Finished.' }], { maxTurns: () => 10 })
    const done = h.session.send('read it a lot')
    await until(() => h.session.state().atTurnLimit)
    assert.equal(h.session.state().atTurnLimit, true)
    h.session.continueAtLimit(true)
    await done

    assert.equal(h.session.state().atTurnLimit, false)
    assert.match(h.session.snapshot().at(-1)?.content ?? '', /Finished\./)
  })
})

describe('ChatSession — projects and workflows', () => {
  test('names the linked project on every request, and nothing when unlinked', async () => {
    let project: string | null = 'p-123'
    const requests: ChatCompletionRequest[] = []
    const session = new ChatSession({
      getClient: () => fakeClient(async (req) => {
        requests.push(req)
        return emptyResult({ content: 'ok' })
      }),
      conversationId: 'test',
      onUnauthorized: () => {},
      emit: () => {},
      projectId: () => project,
    })
    await session.send('one')
    project = null
    await session.send('two')
    assert.equal(requests[0]?.redstart_project, 'p-123')
    assert.equal('redstart_project' in (requests[1] ?? {}), false)
  })

  test('a workflow message carries the composed text and shows the workflow', async () => {
    const h = new Harness()
    await h.session.send('Turn these notes into the weekly report: …', { name: 'weekly', title: 'Weekly report' })
    const user = h.session.transcript[0]
    assert.equal(user?.workflow?.title, 'Weekly report')
    assert.match(h.lastRequest.messages[0]?.content ?? '', /weekly report/)
  })
})

describe('ChatSession — approvals', () => {
  const request = {
    kind: 'command' as const,
    title: 'Run a command',
    subject: 'npm test',
    options: [
      { id: 'run', label: 'Run', kind: 'allow' as const },
      { id: 'deny', label: 'Deny', kind: 'deny' as const },
    ],
  }

  test('shows the request in the conversation state and resolves with the choice', async () => {
    const h = new Harness()
    const pending = h.session.askApproval(request)
    const approval = h.session.state().approval
    assert.equal(approval?.subject, 'npm test')
    const pushed = h.ofType('conversationState').at(-1)
    assert.equal(pushed?.state.approval?.id, approval?.id)
    assert.equal(h.session.approve('stale', 'run'), false)
    assert.equal(h.session.approve(approval!.id, 'run'), true)
    assert.equal(await pending, 'run')
    assert.equal(h.session.state().approval, null)
  })

  test('Stop denies a waiting approval', async () => {
    const h = new Harness()
    const pending = h.session.askApproval(request)
    h.session.abort()
    assert.equal(await pending, 'deny')
  })
})

// ---------------------------------------------------------------------------
// The run log: what an earlier message's run did, sent with later requests.
// ---------------------------------------------------------------------------

describe('ChatSession run log', () => {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-runlog-')))
  fs.writeFileSync(path.join(workspace, 'game.js'), 'let x = 1\n')
  after(() => fs.rmSync(workspace, { recursive: true, force: true }))

  const registry = () =>
    createToolRegistry({
      ripgrepPath: null,
      diagnostics: () => [],
      editorState: () => ({ activeFile: null, languageId: null, isDirty: false, cursor: null, selection: null, openFiles: [] }),
    })

  /** Each send runs the next script; every request is kept. */
  function session(scripts: StreamScript[], extra: Partial<SessionDeps> = {}) {
    const requests: ChatCompletionRequest[] = []
    let n = 0
    const s = new ChatSession({
      getClient: () => fakeClient((req, handlers, signal) => {
        requests.push(structuredClone(req))
        const script = scripts.shift()
        if (!script) throw new Error('no script left')
        return script(req, handlers, signal)
      }),
      conversationId: 'test',
      onUnauthorized: () => {},
      emit: () => {},
      newId: () => `id-${++n}`,
      tools: () => registry(),
      toolContext: () => ({ workspaceRoots: [workspace] }),
      approveChange: async () => true,
      ...extra,
    })
    return { s, requests }
  }

  const call = (name: string, args: unknown): StreamScript => async () =>
    emptyResult({ toolCalls: [{ index: 0, id: `c-${name}`, function: { name, arguments: JSON.stringify(args) } }] })
  const assistantTexts = (req: ChatCompletionRequest) =>
    req.messages.filter((m) => m.role === 'assistant').map((m) => m.content as string)

  test('the second message knows which file the first one wrote', async () => {
    const { s, requests } = session([
      call('ys_write_file', { path: 'src/new.js', content: 'export const a = 1\n' }),
      says('Created src/new.js.'),
      says('Done.'),
    ])
    await s.send('build X')
    await s.send('now change the file you made')
    const second = requests.at(-1)!
    assert.deepEqual(assistantTexts(second), ['Created src/new.js.\n\n[What this run did]\ncreated src/new.js'])
  })

  test('a rejected write is sent as rejected', async () => {
    const { s, requests } = session(
      [call('ys_replace', { path: 'game.js', old_string: 'let x = 1', new_string: 'let x = 2' }), says('I tried.'), says('ok')],
      { approveChange: async () => false },
    )
    await s.send('change x')
    await s.send('again')
    assert.match(assistantTexts(requests.at(-1)!)[0]!, /rejected, NOT written: game\.js/)
  })

  test('a turn that failed after a write still sends what it did, without its error', async () => {
    const { s, requests } = session([
      call('ys_write_file', { path: 'half.js', content: '1\n' }),
      async () => {
        throw new Error('stream died')
      },
      says('ok'),
    ])
    await s.send('build')
    await s.send('what happened?')
    const texts = assistantTexts(requests.at(-1)!)
    assert.deepEqual(texts, ['[What this run did]\ncreated half.js'])
    assert.ok(!texts.join('').includes('stream died'))
  })

  test('a run that only read sends no log', async () => {
    const { s, requests } = session([call('ys_read_file', { path: 'game.js' }), says('x is 1.'), says('ok')])
    await s.send('what is x')
    await s.send('thanks')
    assert.deepEqual(assistantTexts(requests.at(-1)!), ['x is 1.'])
  })

  test('logs older than the last 6 assistant messages collapse to one line', async () => {
    const scripts: StreamScript[] = []
    for (let i = 0; i < 7; i++) scripts.push(call('ys_write_file', { path: `f${i}.js`, content: `${i}\n` }), says(`made f${i}`))
    scripts.push(says('ok'))
    const { s, requests } = session(scripts)
    for (let i = 0; i < 7; i++) await s.send(`make f${i}`)
    await s.send('done?')
    const texts = assistantTexts(requests.at(-1)!)
    assert.equal(texts.length, 7)
    assert.equal(texts[0], 'made f0\n\n[Earlier run: wrote 1 file]')
    assert.equal(texts[1], 'made f1\n\n[What this run did]\ncreated f1.js')
  })

  test('the live line goes on the newest message only, and is not stored', async () => {
    let live: string | null = 'Running now: p1 "npm run dev" → http://localhost:5173/ (just started)'
    const { s, requests } = session([says('one'), says('two')], { liveState: () => live })
    await s.send('first')
    live = null
    await s.send('second')
    const [first, second] = requests
    assert.equal(first!.messages.at(-1)!.content, '[Running now: p1 "npm run dev" → http://localhost:5173/ (just started)]\n\nfirst')
    const users = second!.messages.filter((m) => m.role === 'user').map((m) => m.content)
    assert.deepEqual(users, ['first', 'second'])
  })
})

// ---------------------------------------------------------------------------
// An interrupted run: recorded while it goes, offered to continue on reload.
// ---------------------------------------------------------------------------

describe('ChatSession interrupted runs', () => {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-inflight-')))
  after(() => fs.rmSync(workspace, { recursive: true, force: true }))

  test('a run records what it has running, saved as it goes, cleared at the end', async () => {
    const saved: (ReturnType<ChatSession['inFlightSnapshot']>)[] = []
    let session!: ChatSession
    let n = 0
    const scripts: StreamScript[] = [
      async () => emptyResult({ toolCalls: [{ index: 0, id: 'c1', function: { name: 'ys_process', arguments: '{"action":"start","command":"npm run dev"}' } }] }),
      says('Started.'),
    ]
    session = new ChatSession({
      getClient: () => fakeClient((req, handlers, signal) => scripts.shift()!(req, handlers, signal)),
      conversationId: 'c',
      onUnauthorized: () => {},
      emit: () => {},
      newId: () => `id-${++n}`,
      tools: () => createToolRegistry({ ripgrepPath: null, diagnostics: () => [], editorState: () => ({ activeFile: null, languageId: null, isDirty: false, cursor: null, selection: null, openFiles: [] }), processes: new BackgroundProcesses() }),
      toolContext: () => ({ workspaceRoots: [workspace] }),
      approveCommand: async () => ({ text: 'p1 is serving http://localhost:5173/', isError: false, exitCode: null, processId: 'p1' }),
      onPersist: () => saved.push(session.inFlightSnapshot()),
    })
    await session.send('start the dev server')
    const during = saved.find((s) => s?.processes.length)
    assert.deepEqual(during?.processes, [{ id: 'p1', command: 'npm run dev', cwd: workspace }])
    assert.equal(session.inFlightSnapshot(), null, 'cleared when the run ends')
    assert.equal(saved.at(-1), null)
  })

  test('loaded with a run still recorded: offered to continue, and the stuck turn stops spinning', async () => {
    const h = new Harness()
    h.session.load(
      [
        { id: 'u1', role: 'user', content: 'build it' },
        { id: 'a1', role: 'assistant', content: 'Working', streaming: true },
      ],
      null,
      { startedAt: 1, processes: [{ id: 'p1', command: 'npm run dev', cwd: workspace }] },
    )
    assert.deepEqual(h.session.state().interrupted, { startedAt: 1, processes: ['npm run dev'] })
    const turn = h.session.snapshot()[1]!
    assert.equal(turn.streaming, false)
    assert.equal(turn.aborted, true)

    h.respond(says('Picking up.'))
    const resumed = h.session.resumeInterrupted()!
    assert.deepEqual(resumed.processes, [{ command: 'npm run dev', cwd: workspace }])
    await resumed.sent
    assert.equal(h.lastRequest.messages.at(-1)!.content, RESUME_PROMPT)
    assert.equal(h.session.state().interrupted, null)
  })

  test('dismiss puts the card away; a new message does too', async () => {
    const h = new Harness()
    const run = { startedAt: 1, processes: [] }
    h.session.load([], null, run)
    h.session.dismissInterrupted()
    assert.equal(h.session.state().interrupted, null)
    h.session.load([], null, run)
    await h.session.send('something else')
    assert.equal(h.session.state().interrupted, null)
  })
})
