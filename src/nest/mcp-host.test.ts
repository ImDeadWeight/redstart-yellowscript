// =============================================================================
// Tests for McpHost — the Streamable HTTP MCP client (Phase 4.2).
// =============================================================================
// A fake /mcp server, shaped like Nest's (daemon/mcp-server.mjs): initialize
// opens a session and returns its id in `mcp-session-id`; every later request
// must carry it; a forgotten session answers 404; replies are SSE or JSON.
// Proves:
//  - the initialize + initialized + tools/list flow populates `toolNames`
//  - the session id and protocol version ride on every later request
//  - SSE-framed and JSON replies are both read
//  - a 404 for a forgotten session (Nest restarted) opens a new one, once
//  - re-list clears and repopulates (the active profile can change)
//  - callTool, approvals' `_meta`, prompts, and ys_* disjointness
// =============================================================================

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { McpHost, parseMcpResponse, type McpMessage, type McpNestClient, type McpTool } from './mcp-host.ts'

interface Sent {
  method: string | undefined
  body: Record<string, unknown>
  headers: Record<string, string>
  httpMethod: string
}

interface FakeServer {
  client: McpNestClient
  tools: McpTool[]
  /** Every request the host made, in order. */
  sent: Sent[]
  /** Every tools/call `params`, in order. */
  calls: Array<Record<string, unknown>>
  onCall?: (params: Record<string, unknown>) => unknown
  /** Extra method handlers (prompts/list, prompts/get…). */
  handlers: Record<string, (params: any) => unknown>
  /** Answer as an SSE stream (Nest's default) instead of JSON. */
  sse: boolean
  /** Forget every session, as a restarted Nest does. */
  restart(): void
  sessionsOpened: number
}

function fakeServer(): FakeServer {
  const live = new Set<string>()
  const server: FakeServer = {
    tools: [
      { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, meta: { 'redstart/capability': 'filesystem' } },
      { name: 'postgres_query', description: 'Run a SQL query', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, meta: { 'redstart/capability': 'postgres' } },
    ],
    sent: [],
    calls: [],
    handlers: {},
    sse: true,
    sessionsOpened: 0,
    restart: () => live.clear(),
    client: undefined as never,
  }

  const reply = (msg: McpMessage, result: unknown, extraHeaders: Record<string, string> = {}): Response => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })
    return server.sse
      ? new Response(`event: message\ndata: ${payload}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream', ...extraHeaders } })
      : new Response(payload, { status: 200, headers: { 'Content-Type': 'application/json', ...extraHeaders } })
  }

  server.client = {
    baseUrl: 'http://nest:19080',
    listMcpServers: () => Promise.resolve({ servers: [{ name: 'Redstart Built-in', url: 'http://nest:19080/mcp' }], disabledTools: [] }),
    getCredential: () => ({ kind: 'apiKey', key: 'rst_test' }),
    fetch: async (url: string, init?: RequestInit): Promise<Response> => {
      assert.equal(url, 'http://nest:19080/mcp', 'every request goes to the advertised /mcp URL')
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
      const httpMethod = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      server.sent.push({ method: body.method as string | undefined, body, headers, httpMethod })
      if (httpMethod === 'DELETE') return new Response(null, { status: 200 })

      const msg = body as unknown as McpMessage
      if (msg.method === 'initialize') {
        assert.match(headers['accept'] ?? '', /application\/json/)
        assert.match(headers['accept'] ?? '', /text\/event-stream/)
        const sid = `s${++server.sessionsOpened}`
        live.add(sid)
        return reply(msg, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'redstart', version: '1' } }, { 'mcp-session-id': sid })
      }
      const sid = headers['mcp-session-id']
      if (!sid) return new Response('{"error":"No valid session ID provided"}', { status: 400 })
      if (!live.has(sid)) return new Response('{"error":{"message":"Session not found"}}', { status: 404 })
      if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 })
      if (msg.method === 'tools/list') return reply(msg, { tools: server.tools })
      if (msg.method === 'tools/call') {
        const params = (msg.params ?? {}) as Record<string, unknown>
        server.calls.push(params)
        return reply(msg, server.onCall ? server.onCall(params) : { content: [{ type: 'text', text: 'query result: 42 rows' }] })
      }
      const handler = msg.method ? server.handlers[msg.method] : undefined
      return reply(msg, handler ? handler(msg.params) : {})
    },
  }
  return server
}

function hostFor(server: FakeServer, onTools: (tools: readonly McpTool[]) => void = () => {}): McpHost {
  return new McpHost(server.client, { onTools, onConnection: () => {}, onError: (err) => { throw err } })
}

describe('McpHost', () => {
  it('opens a session, sends initialized, and lists tools', async () => {
    const server = fakeServer()
    let received: string[] = []
    const host = hostFor(server, (tools) => (received = tools.map((t) => t.name)))

    const conn = await host.connect()
    assert.ok(conn)
    assert.deepEqual(received, ['read_file', 'postgres_query'])
    assert.deepEqual(host.toolNames(), ['read_file', 'postgres_query'])
    assert.equal(host.getTool('ys_read_file'), null)
    assert.deepEqual(server.sent.map((s) => s.method), ['initialize', 'notifications/initialized', 'tools/list'])
    host.stop()
  })

  it('sends the session id, protocol version and bearer on every request after initialize', async () => {
    const server = fakeServer()
    const host = hostFor(server)
    await host.connect()
    await host.callTool('postgres_query', {})
    const [init, ...rest] = server.sent
    assert.equal(init!.headers['mcp-session-id'], undefined)
    for (const s of rest) {
      assert.equal(s.headers['mcp-session-id'], 's1')
      assert.equal(s.headers['mcp-protocol-version'], '2025-03-26')
      assert.equal(s.headers['authorization'], 'Bearer rst_test')
    }
    host.stop()
    assert.equal(server.sent.at(-1)?.httpMethod, 'DELETE', 'stop ends the session on the server')
  })

  it('reads JSON replies as well as SSE ones', async () => {
    const server = fakeServer()
    server.sse = false
    const host = hostFor(server)
    await host.connect()
    assert.equal(await host.callTool('postgres_query', {}), 'query result: 42 rows')
    host.stop()
  })

  it('a forgotten session (Nest restarted) is reopened and the call repeated, once', async () => {
    const server = fakeServer()
    const host = hostFor(server)
    await host.connect()
    server.restart()
    assert.equal(await host.callTool('postgres_query', { q: 1 }), 'query result: 42 rows')
    assert.equal(server.sessionsOpened, 2)
    assert.equal(server.calls.length, 1, 'the call ran once, on the new session')
    host.stop()
  })

  it('a failed initialize is reported, not thrown', async () => {
    const server = fakeServer()
    server.client.fetch = async () => new Response('Not found', { status: 404 })
    const errors: Error[] = []
    const host = new McpHost(server.client, { onTools: () => {}, onConnection: () => {}, onError: (e) => errors.push(e) })
    assert.equal(await host.connect(), null)
    assert.match(errors[0]?.message ?? '', /MCP initialize: 404/)
  })

  it('re-lists tools on every connect (profile can change between sessions)', async () => {
    const server = fakeServer()
    let received: string[] = []
    const host = hostFor(server, (tools) => (received = tools.map((t) => t.name)))
    await host.connect()
    assert.deepEqual(received, ['read_file', 'postgres_query'])
    host.stop()

    server.tools = [{ name: 'create_document', description: 'Make a doc', inputSchema: { type: 'object', properties: {} } }]
    const host2 = hostFor(server, (tools) => (received = tools.map((t) => t.name)))
    await host2.connect()
    assert.deepEqual(received, ['create_document'])
    assert.deepEqual(host2.toolNames(), ['create_document'])
    host2.stop()
  })

  it("reads a tool's provenance from the wire's `_meta`", async () => {
    const server = fakeServer()
    server.tools = [
      {
        name: 'delete_file',
        description: 'Delete a file',
        inputSchema: { type: 'object', properties: {} },
        _meta: { 'redstart/class': 'destructive', 'redstart/approvalRule': 'always', 'redstart/approvalEnforced': true },
      } as unknown as McpTool,
    ]
    let listed: readonly McpTool[] = []
    const host = hostFor(server, (t) => (listed = t))
    await host.connect()
    assert.equal(listed[0]?.meta?.['redstart/approvalRule'], 'always')
    host.stop()
  })

  it('callToolResult hands back a pending approval and sends `_meta` on the repeat', async () => {
    const server = fakeServer()
    server.onCall = (params) => {
      const meta = params._meta as Record<string, unknown> | undefined
      if (meta?.['redstart/approvalId'] === 'ap-1') return { content: [{ type: 'text', text: 'Deleted notes.md' }] }
      return {
        isError: true,
        content: [{ type: 'text', text: 'Not done: needs approval' }],
        _meta: { 'redstart/approval': { id: 'ap-1', tool: 'delete_file', summary: 'Delete notes.md', argsDigest: 'x', expiresAt: 1 } },
      }
    }
    const host = hostFor(server)
    await host.connect()

    const first = await host.callToolResult('delete_file', { path: 'notes.md' })
    assert.equal(first.isError, true)
    assert.equal(first.approval?.id, 'ap-1')
    assert.equal(server.calls[0]?._meta, undefined, 'a first call sends no _meta')

    const second = await host.callToolResult('delete_file', { path: 'notes.md' }, { 'redstart/approvalId': 'ap-1' })
    assert.deepEqual(second, { text: 'Deleted notes.md', isError: false, approval: null })
    assert.deepEqual(server.calls[1]?._meta, { 'redstart/approvalId': 'ap-1' })
    host.stop()
  })

  it('declares at initialize that it answers ask_user and update_plan', async () => {
    const server = fakeServer()
    const host = hostFor(server)
    await host.connect()
    const init = server.sent.find((s) => s.method === 'initialize')!
    const params = init.body.params as { protocolVersion: string; capabilities: { experimental?: Record<string, { names?: string[] }> } }
    assert.equal(params.protocolVersion, '2025-03-26')
    assert.deepEqual(params.capabilities.experimental?.['redstart/hostTools']?.names, ['ask_user', 'update_plan'])
    host.stop()
  })

  it('lists workflows as prompts and composes one with its arguments', async () => {
    const server = fakeServer()
    server.handlers['prompts/list'] = () => ({
      prompts: [
        { name: 'weekly', title: 'Weekly report', description: 'Notes to report', arguments: [{ name: 'notes', required: true }] },
        { name: 'org-standup', arguments: [] },
        { title: 'no name' },
      ],
    })
    server.handlers['prompts/get'] = (p: { name: string; arguments: Record<string, string> }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `${p.name}: ${p.arguments.notes}` } }],
    })
    const host = hostFor(server)
    await host.connect()
    const prompts = await host.listPrompts()
    assert.deepEqual(prompts.map((p) => [p.name, p.title]), [['weekly', 'Weekly report'], ['org-standup', 'org-standup']])
    assert.deepEqual(prompts[0]?.arguments, [{ name: 'notes', required: true }])
    assert.equal(await host.getPrompt('weekly', { notes: 'shipped it' }), 'weekly: shipped it')
    host.stop()
  })

  it('ys_* names never collide with Nest tool names (disjointness)', async () => {
    const server = fakeServer()
    const host = hostFor(server)
    await host.connect()
    for (const name of host.toolNames()) {
      assert.equal(name.startsWith('ys_'), false, `Nest tool "${name}" collides with the ys_ prefix`)
    }
    host.stop()
  })
})

describe('parseMcpResponse', () => {
  it('finds the response by id in an SSE body, skipping other events', () => {
    const body = ': keep-alive\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":"ys_3","result":{"ok":true}}\n\n'
    assert.deepEqual(parseMcpResponse('text/event-stream', body, 'ys_3')?.result, { ok: true })
  })

  it('reads JSON, a JSON batch, and returns null for no match', () => {
    assert.ok(parseMcpResponse('application/json', '{"jsonrpc":"2.0","id":"a","result":1}', 'a'))
    assert.ok(parseMcpResponse('application/json', '[{"jsonrpc":"2.0","id":"b","result":1}]', 'b'))
    assert.equal(parseMcpResponse('application/json', '{"jsonrpc":"2.0","id":"x","result":1}', 'a'), null)
    assert.equal(parseMcpResponse('text/html', '<html>', 'a'), null)
  })
})
