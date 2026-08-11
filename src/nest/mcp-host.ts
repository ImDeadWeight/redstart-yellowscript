// =============================================================================
// McpHost — speaks the Redstart Nest's built-in MCP server over SSE.
// =============================================================================
// Phase 4.2. This is NOT the @modelcontextprotocol SDK — that bundle is ~3MB and
// the Nest's MCP surface is a single SSE server with a fixed contract (HANDOFF
// section 10). Speaking the protocol directly keeps the extension host bundle at
// ~77 kB and gives us a seam to test without a server.
//
// The protocol, as served by redstart-nest:
//
//   1. GET /sse          — an SSE stream. First event is `endpoint`, whose data
//                          is a BARE URI (no query-string ceremony). All JSON-RPC
//                          calls thereafter POST to that URI as
//                          `application/x-www-form-urlencoded`.
//   2. POST /message     — the `initialize` exchange + every `tools/list`,
//                          `tools/call`, etc. A successful call returns 200 and
//                          optionally pushes result/error events back on the SSE
//                          stream keyed by `id`.
//
// Authentication rides the same `Authorization: Bearer` header as every other
// Nest call — the credential never crosses into the webview, and this host runs
// in the extension process, not the webview.
//
// The set of tools is NOT static: it follows the Nest's active profile, so we
// re-list on every (re)connect. `toolNames` is therefore a method, not a cached
// field.
//
// No `vscode` import: the host is testable with a fake SSE client. The adapter
// that turns a real `fetch` into `SseStream` live in ui/.
// =============================================================================

import type { McpServersResponse, Credential } from '../nest/types.ts'
import { credentialValue } from '../nest/types.ts'
import { truncateForModel, MAX_RESULT_CHARS } from '../tools/types.ts'

/** A single JSON-RPC 2.0 request or response on the MCP wire. */
export interface McpMessage {
  id: string
  jsonrpc: '2.0'
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** A tool as discovered from the Nest's MCP `tools/list`. */
export interface McpTool {
  /** Raw, un-prefixed name. e.g. `read_file`, `postgres_query`. */
  name: string
  /** The model-facing description, verbatim from the server. */
  description: string
  inputSchema: unknown
  /** The annotations block every tool now carries (HANDOFF 4.3). */
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    openWorldHint?: boolean
  }
  /** Server-supplied provenance. Source of truth for capability/class. */
  meta?: Record<string, unknown>
}

/** The resolved built-in server the host is connected to. */
export interface McpConnection {
  serverUrl: string
  servers: McpServersResponse['servers']
  disabledTools: readonly string[]
}

/**
 * A handle on the SSE stream that abstracts the transport. In production this
 * wraps `fetch(...).body` decoded line-by-line; in tests it is a fake that
 * pushes parsed events. Decoupling lets the host logic be pure.
 */
export interface McpSseStream {
  /** Events in arrival order. `endpoint` carries a bare URI string as `data`;
   *  JSON-RPC results/error events carry a serialised `McpMessage`. */
  events: AsyncIterable<SseEvent>
  close(): void
}

export interface SseEvent {
  /** The SSE `event:` field, or `'message'` when absent. */
  type: string
  data: string
}

/**
 * The fetch + credential surface the host needs. Injected so the host is
 * testable without a server.
 */
export interface McpNestClient {
  baseUrl: string
  listMcpServers(signal?: AbortSignal): Promise<McpServersResponse>
  /** A fetch bound to the gateway, carrying the bearer header when we have a
   *  credential. Used both for the SSE stream and POST /message. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  getCredential(): Credential | null
}

export interface McpHostOptions {
  /** Where the SSE stream comes from. */
  openStream: (url: string) => Promise<McpSseStream>
  /** Re-fetch the tool list when the connection is (re)established. */
  onTools: (tools: readonly McpTool[]) => void
  /** The full merged set — ws_ tools plus Nest tools — after a re-list. */
  onConnection: (conn: McpConnection) => void
  onError: (err: Error) => void
}

export class McpHost {
  private readonly client: McpNestClient
  private readonly options: McpHostOptions
  private stream: McpSseStream | null = null
  private endpoint: string | null = null
  private pending = new Map<string, { resolve: (v: McpMessage) => void; reject: (e: Error) => void }>()
  private messageId = 0
  private readonly capabilities: Map<string, McpTool> = new Map()
  private currentConnection: McpConnection | null = null

  constructor(client: McpNestClient, options: McpHostOptions) {
    this.client = client
    this.options = options
  }

  /** The names of all tools currently known from the Nest. */
  toolNames(): string[] {
    return [...this.capabilities.keys()]
  }

  /** A tool by name, or null if unknown/banned. */
  getTool(name: string): McpTool | null {
    const tool = this.capabilities.get(name)
    return tool ?? null
  }

  /**
   * Bring up the SSE link and negotiate the session. Resolves the
   * McpConnection on success (fire-and-forget for events); rejects with an Error
   * on a hard failure (missing server, endpoint never sent).
   */
  async connect(): Promise<McpConnection | null> {
    const servers = await this.discoverServers()
    if (servers === null) return null

    const server = servers.servers[0]
    if (!server) {
      this.options.onError(new Error('No MCP servers returned by /redstart/mcp-servers'))
      return null
    }

    const baseUrl = this.resolveServerUrl(server.url, servers.serverUrl)
    this.endpoint = null
    this.capabilities.clear()
    this.currentConnection = { ...servers, servers: [...servers.servers] }

    try {
      const stream = await this.options.openStream(`${baseUrl}/sse`)
      this.stream = stream
      void this.runStream(stream).catch((err) => {
        this.options.onError(err instanceof Error ? err : new Error(String(err)))
      })
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      this.stop()
      this.options.onError(e)
      return null
    }

    return this.currentConnection
  }

  /**
   * Drive the SSE event loop until the stream ends or is closed. The first
   * `endpoint` event sets the JSON-RPC POST target; the first `message` event
   * carrying a JSON-RPC response resolves a pending call.
   */
  private async runStream(stream: McpSseStream): Promise<void> {
    let initialized = false
    for await (const event of stream.events) {
      if (event.type === 'endpoint') {
        this.endpoint = event.data.trim()
        if (this.endpoint && !initialized) {
          initialized = true
          void this.initialize().catch((err) => {
            this.options.onError(err instanceof Error ? err : new Error(String(err)))
          })
        }
        continue
      }

      // A `message` event (or default) carrying JSON-RPC — resolve the pending
      // request this response belongs to, if any.
      if (event.type === 'message' || event.type === 'sse') {
        let msg: McpMessage
        try {
          msg = JSON.parse(event.data) as McpMessage
        } catch {
          continue
        }
        const pending = this.pending.get(msg.id)
        if (pending) {
          pending.resolve(msg)
          this.pending.delete(msg.id)
        }
      }
    }
  }

  /**
   * Send `initialize`, then `tools/list`, populating capabilities and firing
   * `onTools` + `onConnection`.
   */
  private async initialize(): Promise<void> {
    if (!this.endpoint) throw new Error('Cannot initialize: endpoint URI not set')

    const initRes = await this.postJsonRpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, sampling: {}, prompts: {}, completion: {} },
      clientInfo: { name: 'yellowscript', version: '0.0.1' },
    })

    if (initRes.error) {
      throw new Error(`MCP initialize failed: ${initRes.error.message}`)
    }

    const toolsRes = await this.postJsonRpc('tools/list')
    if (toolsRes.error) {
      throw new Error(`MCP tools/list failed: ${toolsRes.error.message}`)
    }

    const rawTools = (toolsRes.result as { tools?: Partial<McpTool>[] })?.tools ?? []
    const tools = rawTools.map(normalizeTool)
    this.capabilities.clear()
    for (const t of tools) this.capabilities.set(t.name, t as McpTool)
    this.options.onTools(tools as McpTool[])
    if (this.currentConnection) this.options.onConnection(this.currentConnection)
  }

  /**
   * POST a JSON-RPC call to the endpoint URI and resolve when the matching
   * response event arrives on the SSE stream. Falls back to the immediate HTTP
   * response if the server echoes synchronously.
   */
    private postJsonRpc(method: string, params?: unknown): Promise<McpMessage> {
    if (!this.endpoint) return Promise.reject(new Error('No MCP endpoint set'))
    const id = `ys_${this.messageId++}`
    const body = new URLSearchParams()
    body.set('message', JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
    const credential = this.client.getCredential?.()
    if (credential) {
      headers['Authorization'] = `Bearer ${credentialValue(credential)}`
    }

    let resolveFn: (v: McpMessage) => void = () => {}
    let rejectFn: (e: Error) => void = () => {}
    const p = new Promise<McpMessage>((resolve, reject) => {
      resolveFn = resolve
      rejectFn = reject
      this.pending.set(id, { resolve, reject })
    })

    const clear = () => {
      clearTimeout(timeout)
      this.pending.delete(id)
    }

    const timeout = setTimeout(() => {
      clear()
      rejectFn(new Error(`MCP ${method} timed out`))
    }, 15_000)

    this.client
      .fetch(this.endpoint, { method: 'POST', headers, body })
      .then(async (res) => {
        if (!res.ok) {
          clear()
          throw new Error(`MCP ${method}: ${res.status} ${res.statusText}`)
        }
        // If the server returns JSON directly (some do), resolve from that.
        const text = await res.text().catch(() => '')
        if (text) {
          try {
            const msg = JSON.parse(text) as McpMessage
            if (msg.id === id && msg.jsonrpc === '2.0') {
              clear()
              resolveFn(msg)
              return
            }
          } catch {
            // Not JSON-RPC — let the SSE stream event resolve it.
          }
        }
        // Otherwise wait for the SSE-driven resolution in runStream.
      })
      .catch((err) => {
        if (!this.pending.has(id)) return
        clear()
        rejectFn(err instanceof Error ? err : new Error(String(err)))
      })

    return p
  }

  stop(): void {
    if (this.stream) {
      this.stream.close()
      this.stream = null
    }
    this.endpoint = null
    this.currentConnection = null
    // Reject any pending calls so a closed session doesn't hang the loop.
    for (const [, entry] of this.pending) entry.reject(new Error('MCP connection closed'))
    this.pending.clear()
  }

  /**
   * Execute an MCP tool call and return its result text, budgeted to the model.
   * The caller is responsible for origin-tagging so the model knows it ran on the
   * Nest, not locally (HANDOFF 4.3).
   */
   async callTool(name: string, args: unknown): Promise<string> {
    const res = await this.postJsonRpc('tools/call', { name, arguments: args })
    if (res.error) return `[Tool ${name} failed: ${res.error.message}]`
    const result = res.result as Record<string, unknown> | undefined
    // MCP tools/call returns isError + content. A server-side policy denial
    // (write/destructive policy, banned tool) arrives as isError=true with a
    // human-readable reason in the content — render it distinctly so the model
    // knows this was refused by the server, not a local failure. (HANDOFF 4.4)
    if (result && result.isError === true) {
      const reason = this.extractText(result)
      return `[Server denial for "${name}": ${reason || 'policy refusal, tool not available'}]`
    }
    return this.extractText(res.result)
  }

  // --- private plumbing -------------------------------------------------------

  /**
   * Resolve the SSE URL for the built-in server. The server advertises a URL
   * that may be relative (`/sse`), a bare path, or a host:port. We anchor bare
   * paths and relative URLs against the gateway.
   */
  private resolveServerUrl(serverUrl: string, gatewayUrl: string): string {
    const trimmed = serverUrl.trim()
    if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '')
    if (trimmed.startsWith('/')) return `${gatewayUrl}${trimmed}`
    return `${gatewayUrl}/${trimmed}`
  }

  private discoverServers(): Promise<McpConnection | null> {
    return this.client
      .listMcpServers()
      .then((resp): McpConnection => ({
        serverUrl: this.client.baseUrl,
        servers: resp.servers,
        disabledTools: resp.disabledTools,
      }))
      .catch((err) => {
        this.options.onError(err instanceof Error ? err : new Error(String(err)))
        return null
      })
  }

  private extractText(result: unknown): string {
    if (!result || typeof result !== 'object') return String(result ?? '')
    const obj = result as Record<string, unknown>
    const content = obj.content
    if (Array.isArray(content)) {
      const joined = content
        .map((item) => {
          const rec = item as Record<string, unknown>
          if (typeof rec === 'object' && rec !== null && 'text' in rec) return String(rec.text)
          return ''
        })
        .filter(Boolean)
        .join('\n')
      return truncateForModel(joined, MAX_RESULT_CHARS).text
    }
    if (typeof content === 'string') return truncateForModel(content, MAX_RESULT_CHARS).text
    return JSON.stringify(result)
  }
}

/** Normalise a tool record. The server already stripped banned names and carries
 *  `_meta` provenance; we keep it as-is and let the merge layer use it. */
function normalizeTool(raw: Partial<McpTool>): McpTool {
  const tool: McpTool = {
    name: raw.name ?? '',
    description: raw.description ?? '',
    inputSchema: raw.inputSchema ?? { type: 'object', properties: {} },
  }
  if (raw.annotations) tool.annotations = raw.annotations
  if (raw.meta) tool.meta = raw.meta
  return tool
}
