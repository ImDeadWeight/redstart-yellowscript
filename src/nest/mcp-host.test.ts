// =============================================================================
// Tests for McpHost — the SSE-speaking MCP client (Phase 4.2).
// =============================================================================
// Exercises the pure host logic with a fake SSE stream, proving:
//  - the initialize + tools/list flow populates `toolNames`
//  - re-list clears and repopulates (the active profile can change on reconnect)
//  - callTool returns budgeted result text
//  - ws_* names never collide with Nest tool names
// =============================================================================

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  McpHost,
  type McpMessage,
  type McpNestClient,
  type McpSseStream,
  type SseEvent,
  type McpTool,
} from './mcp-host.ts'

interface FakeSseStream extends McpSseStream {
  emit: (event: SseEvent) => void
}

interface FakeControl {
  tools: McpTool[]
  swapTools: (tools: McpTool[]) => void
}

/** A fake SSE stream that lets the test inject events on demand. */
function fakeStream(): FakeSseStream {
  const events: SseEvent[] = []
  const waiters: Array<(result: IteratorResult<SseEvent>) => void> = []
  let closed = false

  const drain = (): IteratorResult<SseEvent> | undefined => {
    if (events.length > 0) return { value: events.shift()!, done: false }
    return undefined
  }

  const iterator: AsyncIterator<SseEvent> = {
    next(): Promise<IteratorResult<SseEvent>> {
      const next = drain()
      console.error('DEBUG iterator.next, drained=', next?.value?.type, 'waiters=', waiters.length)
      if (next) return Promise.resolve(next)
      if (closed) return Promise.resolve({ value: undefined, done: true })
      return new Promise((resolve) => {
        waiters.push((result) => resolve(result))
      })
    },
  }

  return {
    events: { [Symbol.asyncIterator](): AsyncIterator<SseEvent> { return iterator } },
    emit: (event: SseEvent) => {
      events.push(event)
      const w = waiters.shift()
      if (w) {
        const drained = drain()
        if (drained) w(drained)
        else w({ value: undefined, done: true } as IteratorResult<SseEvent>)
      }
    },
    close: () => {
      closed = true
      const w = waiters.shift()
      if (w) w({ value: undefined, done: true })
    },
  }
}

/** Echo the request id back so postJsonRpc's HTTP fast-path resolves. */
function echoMessage(req: McpMessage, result: unknown): Response {
  return new Response(
    JSON.stringify({ id: req.id, jsonrpc: '2.0', result }),
    { status: 200 },
  )
}

function makeFakeClient(): { client: McpNestClient; control: FakeControl } {
  const control: FakeControl = {
    tools: [
      { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, meta: { 'redstart/capability': 'filesystem', 'redstart/class': 'read' } },
      { name: 'postgres_query', description: 'Run a SQL query', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, meta: { 'redstart/capability': 'postgres', 'redstart/class': 'read' } },
    ],
    swapTools(newTools: McpTool[]) { control.tools = newTools },
  }

  const parseRequest = (body: string): McpMessage | null => {
    try {
      const decoded = decodeURIComponent(body)
      const match = decoded.match(/^message=(.+)/)
      if (!match || !match[1]) return null
      return JSON.parse(match[1]) as McpMessage
    } catch {
      return null
    }
  }

  const client: unknown = {
    baseUrl: 'http://nest:19080',
    listMcpServers: () =>
      Promise.resolve({
        servers: [{ name: 'filesystem', url: 'http://nest:19082/sse' }],
        disabledTools: [],
      }),
    getCredential: () => null,
    fetch: (url: string, init?: RequestInit): Promise<Response> => {
      const body = String(init?.body ?? '')
      posted.push({ url, body })
      const req = parseRequest(body)

      if (!req) {
        return Promise.resolve(
          new Response(JSON.stringify({ id: '', jsonrpc: '2.0', error: { code: -32600, message: 'bad' } }), { status: 200 }),
        )
      }

      const method = req.method ?? ''
      if (method === 'initialize') {
        return Promise.resolve(echoMessage(req, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'redstart-fetch', version: '1.0.0' },
        }))
      }

      if (method === 'tools/list') {
        return Promise.resolve(echoMessage(req, { tools: control.tools }))
      }

      if (method === 'tools/call') {
        return Promise.resolve(echoMessage(req, { content: [{ type: 'text', text: 'query result: 42 rows' }] }))
      }

      return Promise.resolve(echoMessage(req, {}))
    },
  }

  const posted: Array<{ url: string; body: string }> = []
  void posted
  void client

  return { client: client as McpNestClient, control }
}

describe('McpHost', () => {
  it('discovers servers, initializes, and lists tools', async () => {
    const { client } = makeFakeClient()
    const stream = fakeStream()
    let received: string[] = []

    const host = new McpHost(client, {
      openStream: () => Promise.resolve(stream),
      onTools: (tools) => {
        received = tools.map((t) => t.name)
      },
      onConnection: () => {},
      onError: (err) => {
        throw err
      },
    })

    const conn = await host.connect()
    assert.ok(conn)
    stream.emit({ type: 'endpoint', data: 'http://nest:19082/message' })
    await new Promise((r) => setTimeout(r, 100))

    assert.deepEqual(received, ['read_file', 'postgres_query'])
    assert.deepEqual(host.toolNames(), ['read_file', 'postgres_query'])
    assert.equal(host.getTool('read_file')?.name, 'read_file')
    // ws_ names are never in the Nest set.
    assert.equal(host.getTool('ws_read_file'), null)
    host.stop()
  })

  it('re-lists tools on every connect (profile can change between sessions)', async () => {
    const { client, control } = makeFakeClient()
    let received: string[] = []

    const stream = fakeStream()
    const host = new McpHost(client, {
      openStream: () => Promise.resolve(stream),
      onTools: (tools) => {
        received = tools.map((t) => t.name)
      },
      onConnection: () => {},
      onError: (err) => {
        throw err
      },
    })

    await host.connect()
    stream.emit({ type: 'endpoint', data: 'http://nest:19082/message' })
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(received, ['read_file', 'postgres_query'])

    host.stop()
    control.swapTools([
      { name: 'create_document', description: 'Make a doc', inputSchema: { type: 'object', properties: {} }, meta: { 'redstart/capability': 'documents' } },
    ])

    const stream2 = fakeStream()
    const host2 = new McpHost(client, {
      openStream: () => Promise.resolve(stream2),
      onTools: (tools) => {
        received = tools.map((t) => t.name)
      },
      onConnection: () => {},
      onError: (err) => {
        throw err
      },
    })

    await host2.connect()
    stream2.emit({ type: 'endpoint', data: 'http://nest:19082/message' })
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(received, ['create_document'])
    assert.deepEqual(host2.toolNames(), ['create_document'])
    host2.stop()
  })

  it('callTool returns budgeted result text', async () => {
    const { client } = makeFakeClient()
    const stream = fakeStream()
    const host = new McpHost(client, {
      openStream: () => Promise.resolve(stream),
      onTools: () => {},
      onConnection: () => {},
      onError: (err) => {
        throw err
      },
    })

    await host.connect()
    stream.emit({ type: 'endpoint', data: 'http://nest:19082/message' })
    await new Promise((r) => setTimeout(r, 50))

    const text = await host.callTool('postgres_query', { query: 'SELECT 1' })
    assert.equal(text, 'query result: 42 rows')
    host.stop()
  })

  it('ws_* names never collide with Nest tool names (disjointness)', async () => {
    const { client } = makeFakeClient()
    const stream = fakeStream()
    const host = new McpHost(client, {
      openStream: () => Promise.resolve(stream),
      onTools: () => {},
      onConnection: () => {},
      onError: (err) => {
        throw err
      },
    })

    await host.connect()
    stream.emit({ type: 'endpoint', data: 'http://nest:19082/message' })
    await new Promise((r) => setTimeout(r, 50))

    for (const name of host.toolNames()) {
      assert.equal(
        name.startsWith('ws_'),
        false,
        `Nest tool "${name}" collides with the ws_ prefix`,
      )
    }
    host.stop()
  })
})
