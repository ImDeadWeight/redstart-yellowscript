import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { SseParser, parseStreamChunk, tokensPerSecond, DONE_SENTINEL } from './streaming.ts'
import { NestClient } from './client.ts'

describe('SseParser', () => {
  test('emits complete data payloads', () => {
    const parser = new SseParser()
    assert.deepEqual(parser.push('data: {"a":1}\n\ndata: {"b":2}\n\n'), ['{"a":1}', '{"b":2}'])
  })

  test('buffers a payload split across network chunks', () => {
    // The single most common source of truncated-JSON bugs: a chunk boundary
    // that lands mid-object.
    const parser = new SseParser()
    assert.deepEqual(parser.push('data: {"cho'), [])
    assert.deepEqual(parser.push('ices":[]}\n'), ['{"choices":[]}'])
  })

  test('handles a boundary between the CR and the LF', () => {
    const parser = new SseParser()
    assert.deepEqual(parser.push('data: {"a":1}\r'), [])
    assert.deepEqual(parser.push('\n'), ['{"a":1}'])
  })

  test('tolerates a missing space after the colon', () => {
    const parser = new SseParser()
    assert.deepEqual(parser.push('data:{"a":1}\n'), ['{"a":1}'])
  })

  test('ignores blank lines, comments and other SSE fields', () => {
    const parser = new SseParser()
    const out = parser.push(': keep-alive\n\nevent: message\nid: 7\ndata: {"a":1}\n\n')
    assert.deepEqual(out, ['{"a":1}'])
  })

  test('flush recovers a final line with no trailing newline', () => {
    const parser = new SseParser()
    assert.deepEqual(parser.push('data: [DONE]'), [])
    assert.deepEqual(parser.flush(), ['[DONE]'])
  })

  test('flush returns nothing when the buffer holds no data line', () => {
    const parser = new SseParser()
    parser.push('data: {"a":1}\n')
    assert.deepEqual(parser.flush(), [])
  })
})

describe('parseStreamChunk', () => {
  const chunk = (body: unknown) => parseStreamChunk(JSON.stringify(body))

  test('reads content deltas', () => {
    assert.deepEqual(chunk({ choices: [{ delta: { content: 'Hello' } }] }), { content: 'Hello' })
  })

  test('reads reasoning on its own channel', () => {
    // reasoning_content is a separate stream from content. From Phase 2 this is
    // load-bearing: models emit whole tool calls inside their thinking and then
    // only *claim* in the answer that the call ran.
    const parsed = chunk({ choices: [{ delta: { reasoning_content: 'thinking…' } }] })
    assert.deepEqual(parsed, { reasoning: 'thinking…' })
  })

  test('reads content and reasoning arriving in the same chunk', () => {
    const parsed = chunk({ choices: [{ delta: { content: 'a', reasoning_content: 'b' } }] })
    assert.deepEqual(parsed, { content: 'a', reasoning: 'b' })
  })

  test('reads timings from the chunk top level, not from choices', () => {
    const parsed = chunk({ choices: [{ delta: {} }], timings: { predicted_n: 10, predicted_ms: 500 } })
    assert.deepEqual(parsed?.timings, { predicted_n: 10, predicted_ms: 500 })
  })

  test('reads the model name and finish reason', () => {
    const parsed = chunk({ model: 'qwen3.6-35b', choices: [{ delta: {}, finish_reason: 'stop' }] })
    assert.equal(parsed?.model, 'qwen3.6-35b')
    assert.equal(parsed?.finishReason, 'stop')
  })

  test('carries tool_call deltas through unparsed', () => {
    const parsed = chunk({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'ws_read_file' } }] } }],
    })
    assert.equal(parsed?.toolCalls?.length, 1)
  })

  test('returns null for the DONE sentinel', () => {
    assert.equal(parseStreamChunk(DONE_SENTINEL), null)
  })

  test('drops a malformed chunk instead of throwing', () => {
    // A dropped chunk costs a few tokens. A thrown error costs the whole turn.
    assert.equal(parseStreamChunk('{not json'), null)
    assert.equal(parseStreamChunk('null'), null)
    assert.equal(parseStreamChunk('"a string"'), null)
    assert.equal(parseStreamChunk(''), null)
  })

  test('ignores empty-string deltas so they do not fire handlers', () => {
    assert.deepEqual(chunk({ choices: [{ delta: { content: '' } }] }), {})
  })

  test('survives a chunk with no choices at all', () => {
    assert.deepEqual(chunk({ timings: { predicted_n: 1 } }), { timings: { predicted_n: 1 } })
  })
})

describe('tokensPerSecond', () => {
  test('prefers the rate llama.cpp reports', () => {
    assert.equal(tokensPerSecond({ predicted_per_second: 42.5, predicted_n: 1, predicted_ms: 1 }), 42.5)
  })

  test('computes from counts when the rate is absent', () => {
    assert.equal(tokensPerSecond({ predicted_n: 20, predicted_ms: 1000 }), 20)
  })

  test('returns null rather than Infinity or NaN', () => {
    // A zero duration would render as a nonsense status-bar number.
    assert.equal(tokensPerSecond({ predicted_n: 10, predicted_ms: 0 }), null)
    assert.equal(tokensPerSecond({ predicted_n: 0, predicted_ms: 100 }), null)
    assert.equal(tokensPerSecond({}), null)
    assert.equal(tokensPerSecond(undefined), null)
  })
})

// ---------------------------------------------------------------------------
// End-to-end through NestClient with a scripted stream
// ---------------------------------------------------------------------------

/** Build a Response whose body streams the given SSE frames. */
function sseResponse(frames: string[], { chunkSize = 0 } = {}): Response {
  const text = frames.join('')
  const pieces = chunkSize > 0 ? text.match(new RegExp(`.{1,${chunkSize}}`, 'gs')) ?? [] : [text]
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const frame = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`

describe('NestClient.streamChatCompletion', () => {
  const request = { messages: [{ role: 'user' as const, content: 'hi' }] }

  test('accumulates content and reasoning into separate results', async () => {
    const client = new NestClient('http://nest:19080', {
      fetch: async () =>
        sseResponse([
          frame({ model: 'qwen', choices: [{ delta: { reasoning_content: 'let me think' } }] }),
          frame({ choices: [{ delta: { content: 'Hello' } }] }),
          frame({ choices: [{ delta: { content: ' world' } }] }),
          frame({ choices: [{ delta: {}, finish_reason: 'stop' }], timings: { predicted_n: 2, predicted_ms: 100 } }),
          'data: [DONE]\n\n',
        ]),
    })

    const contentSeen: string[] = []
    const reasoningSeen: string[] = []
    const result = await client.streamChatCompletion(request, {
      onContent: (t) => contentSeen.push(t),
      onReasoning: (t) => reasoningSeen.push(t),
    })

    assert.equal(result.content, 'Hello world')
    assert.equal(result.reasoning, 'let me think')
    assert.deepEqual(contentSeen, ['Hello', ' world'])
    assert.deepEqual(reasoningSeen, ['let me think'])
    assert.equal(result.model, 'qwen')
    assert.equal(result.finishReason, 'stop')
    assert.equal(tokensPerSecond(result.timings), 20)
    assert.equal(result.aborted, false)
  })

  test('survives the stream being split at arbitrary byte boundaries', async () => {
    const client = new NestClient('http://nest:19080', {
      fetch: async () =>
        sseResponse(
          [
            frame({ choices: [{ delta: { content: 'The quick ' } }] }),
            frame({ choices: [{ delta: { content: 'brown fox' } }] }),
            'data: [DONE]\n\n',
          ],
          { chunkSize: 7 },
        ),
    })

    const result = await client.streamChatCompletion(request, {})
    assert.equal(result.content, 'The quick brown fox')
  })

  test('sets stream:true on the request', async () => {
    let sentBody: unknown
    const client = new NestClient('http://nest:19080', {
      fetch: async (_url, init) => {
        sentBody = JSON.parse(String(init?.body))
        return sseResponse(['data: [DONE]\n\n'])
      },
    })

    await client.streamChatCompletion(request, {})
    assert.equal((sentBody as { stream: boolean }).stream, true)
  })

  test('sends the bearer credential', async () => {
    let auth: string | null = null
    const client = new NestClient('http://nest:19080', {
      fetch: async (_url, init) => {
        auth = new Headers(init?.headers).get('Authorization')
        return sseResponse(['data: [DONE]\n\n'])
      },
    })
    client.setCredential({ kind: 'apiKey', key: 'rst_x' })

    await client.streamChatCompletion(request, {})
    assert.equal(auth, 'Bearer rst_x')
  })

  test('stops reading at [DONE] and ignores anything after it', async () => {
    const client = new NestClient('http://nest:19080', {
      fetch: async () =>
        sseResponse([
          frame({ choices: [{ delta: { content: 'kept' } }] }),
          'data: [DONE]\n\n',
          frame({ choices: [{ delta: { content: ' dropped' } }] }),
        ]),
    })

    const result = await client.streamChatCompletion(request, {})
    assert.equal(result.content, 'kept')
  })

  test('surfaces a 401 as an unauthorized NestHttpError', async () => {
    const client = new NestClient('http://nest:19080', {
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 }),
    })

    await assert.rejects(
      () => client.streamChatCompletion(request, {}),
      (err: Error & { isUnauthorized?: boolean }) => err.isUnauthorized === true,
    )
  })

  test('surfaces "no model loaded" (502) distinctly from a connection failure', async () => {
    const client = new NestClient('http://nest:19080', {
      fetch: async () => new Response(null, { status: 502 }),
    })

    await assert.rejects(
      () => client.streamChatCompletion(request, {}),
      (err: Error & { isNoModel?: boolean }) => err.isNoModel === true,
    )
  })

  test('an abort keeps the partial content rather than discarding the turn', async () => {
    const controller = new AbortController()
    const encoder = new TextEncoder()
    const client = new NestClient('http://nest:19080', {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(encoder.encode(frame({ choices: [{ delta: { content: 'partial' } }] })))
              // Never closes — the abort is what ends it.
            },
            cancel() {},
          }),
          { status: 200 },
        ),
    })

    const promise = client.streamChatCompletion(
      request,
      { onContent: () => controller.abort() },
      controller.signal,
    )
    const result = await promise
    assert.equal(result.aborted, true)
    assert.equal(result.content, 'partial', 'text already on screen must not vanish')
  })
})
