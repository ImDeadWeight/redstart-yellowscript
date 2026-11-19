// =============================================================================
// McpHost — speaks the Redstart Nest's built-in MCP server (Streamable HTTP).
// =============================================================================
// Phase 4.2. This is NOT the @modelcontextprotocol SDK — that bundle is ~3MB and
// the Nest's MCP surface is one server with a fixed contract. Speaking the
// protocol directly keeps the extension bundle small and leaves a seam to test
// without a server.
//
// The protocol, as served by redstart-nest (daemon/mcp-server.mjs):
//
//   POST <url>  — the URL /redstart/mcp-servers gives, ending in /mcp. Every
//                 JSON-RPC call is a POST with a JSON body; the reply is JSON
//                 or a short SSE stream carrying the response. Both are read.
//   initialize  — opens a session: its reply carries `mcp-session-id`, which
//                 every later request sends, then `notifications/initialized`.
//   404         — on a request with a session id: Nest restarted and forgot
//                 it. Open a new session and repeat the call, once.
//
// Until 2026-11-19 this spoke the legacy SSE transport (GET /sse, POST
// /message), which Nest removed in September: every Nest tool, ask_user and
// update_plan included, was silently missing from Yellowscript.
//
// Authentication rides the same `Authorization: Bearer` header as every other
// Nest call; the credential never crosses into the webview.
//
// The set of tools is NOT static: it follows the Nest's active profile, so we
// re-list on every (re)connect.
//
// No `vscode` import: the host is testable with a fake fetch.
// =============================================================================

import type { McpServersResponse, Credential } from '../nest/types.ts'
import { credentialValue } from '../nest/types.ts'
import { truncateForModel, MAX_RESULT_CHARS } from '../tools/types.ts'
import { approvalRequired, type NestCallResult } from './approval.ts'

/** The MCP experimental capability a client declares to be offered the
 *  host-resolved tools (Nest interaction-tools.mjs HOST_TOOLS_CAPABILITY). */
export const HOST_TOOLS_CAPABILITY = 'redstart/hostTools'
/** The host-resolved tools Yellowscript answers. */
export const HOST_RESOLVED_TOOLS = ['ask_user', 'update_plan'] as const

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

/** A Nest workflow, as an MCP prompt. */
export interface McpPrompt {
  name: string
  title: string
  description?: string
  arguments: Array<{ name: string; description?: string; required: boolean }>
}

/** The resolved built-in server the host is connected to. */
export interface McpConnection {
  serverUrl: string
  servers: McpServersResponse['servers']
  disabledTools: readonly string[]
}

/** The MCP revision this client speaks (the first with Streamable HTTP). */
export const MCP_PROTOCOL_VERSION = '2025-03-26'
/** tools/call can run a web fetch or Python; everything else is quick. */
const CALL_TIMEOUT_MS = 300_000
const RPC_TIMEOUT_MS = 30_000

/** The server no longer knows our session (it restarted): start a new one. */
class SessionExpiredError extends Error {
  constructor() {
    super('MCP session expired')
    this.name = 'SessionExpiredError'
  }
}

/**
 * The JSON-RPC response with `id` in a Streamable HTTP reply. The server
 * answers a POST either as JSON or as a short SSE stream whose `message`
 * events carry JSON-RPC; both are read here. Null when the reply holds none.
 */
export function parseMcpResponse(contentType: string | null, body: string, id: string): McpMessage | null {
  const pick = (value: unknown): McpMessage | null => {
    const list = Array.isArray(value) ? value : [value]
    for (const item of list) {
      if (item && typeof item === 'object' && (item as McpMessage).id === id) return item as McpMessage
    }
    return null
  }
  if ((contentType ?? '').includes('text/event-stream')) {
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (!data) continue
      try {
        const found = pick(JSON.parse(data))
        if (found) return found
      } catch {
        // not JSON: a comment or keep-alive
      }
    }
    return null
  }
  try {
    return pick(JSON.parse(body))
  } catch {
    return null
  }
}

/**
 * The fetch + credential surface the host needs. Injected so the host is
 * testable without a server.
 */
export interface McpNestClient {
  baseUrl: string
  listMcpServers(signal?: AbortSignal): Promise<McpServersResponse>
  /** A fetch bound to the gateway. The host adds the bearer header itself. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  getCredential(): Credential | null
}

export interface McpHostOptions {
  /** Re-fetch the tool list when the connection is (re)established. */
  onTools: (tools: readonly McpTool[]) => void
  /** The full merged set — ys_ tools plus Nest tools — after a re-list. */
  onConnection: (conn: McpConnection) => void
  onError: (err: Error) => void
}

export class McpHost {
  private readonly client: McpNestClient
  private readonly options: McpHostOptions
  /** The server's /mcp URL, from /redstart/mcp-servers. */
  private serverUrl: string | null = null
  private sessionId: string | null = null
  private protocolVersion = MCP_PROTOCOL_VERSION
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
   * Find the built-in server, open a session, and list its tools. Resolves the
   * McpConnection on success; null (after onError) when there is no server or
   * the session cannot be opened.
   */
  async connect(): Promise<McpConnection | null> {
    const servers = await this.discoverServers()
    if (servers === null) return null

    const server = servers.servers[0]
    if (!server) {
      this.options.onError(new Error('No MCP servers returned by /redstart/mcp-servers'))
      return null
    }

    this.serverUrl = this.resolveServerUrl(server.url, servers.serverUrl)
    this.sessionId = null
    this.capabilities.clear()
    this.currentConnection = { ...servers, servers: [...servers.servers] }

    try {
      await this.initialize()
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      this.stop()
      this.options.onError(e)
      return null
    }
    return this.currentConnection
  }

  /** `initialize`, then `tools/list`, firing `onTools` + `onConnection`. */
  private async initialize(): Promise<void> {
    await this.startSession()
    const toolsRes = await this.rpc('tools/list')
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

  /** Open a session: initialize (which returns its id), then `initialized`. */
  private async startSession(): Promise<void> {
    this.sessionId = null
    const initRes = await this.send('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: {},
        sampling: {},
        prompts: {},
        completion: {},
        // The tools Nest defines but only the client's own loop can answer
        // (Nest daemon/interaction-tools.mjs). Nest offers them only to a
        // client that declares them here, and Yellowscript's loop (agent-core,
        // with ChatSession's ask and plan ports) answers both.
        experimental: { [HOST_TOOLS_CAPABILITY]: { names: [...HOST_RESOLVED_TOOLS] } },
      },
      clientInfo: { name: 'yellowscript', version: '0.0.1' },
    }, RPC_TIMEOUT_MS, true)
    if (initRes.error) throw new Error(`MCP initialize failed: ${initRes.error.message}`)
    const version = (initRes.result as { protocolVersion?: unknown } | undefined)?.protocolVersion
    if (typeof version === 'string' && version) this.protocolVersion = version
    await this.notify('notifications/initialized')
  }

  /** One call; a session the server forgot (it restarted) is reopened once. */
  private async rpc(method: string, params?: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<McpMessage> {
    try {
      return await this.send(method, params, timeoutMs)
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) throw err
      await this.startSession()
      return this.send(method, params, timeoutMs)
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Streamable HTTP: the server may answer with either.
      Accept: 'application/json, text/event-stream',
    }
    const credential = this.client.getCredential?.()
    if (credential) headers['Authorization'] = `Bearer ${credentialValue(credential)}`
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId
      headers['mcp-protocol-version'] = this.protocolVersion
    }
    return headers
  }

  /** POST one JSON-RPC request to /mcp and read its response. */
  private async send(method: string, params: unknown, timeoutMs: number, opening = false): Promise<McpMessage> {
    if (!this.serverUrl) throw new Error('Not connected to an MCP server')
    const id = `ys_${this.messageId++}`
    const res = await this.client.fetch(this.serverUrl, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 404 && this.sessionId && !opening) throw new SessionExpiredError()
    if (!res.ok) throw new Error(`MCP ${method}: ${res.status} ${res.statusText}`)
    if (opening) {
      const sid = res.headers.get('mcp-session-id')
      if (sid) this.sessionId = sid
    }
    const msg = parseMcpResponse(res.headers.get('content-type'), await res.text(), id)
    if (!msg) throw new Error(`MCP ${method}: the server sent no response for this call`)
    return msg
  }

  /** A notification: no id, no response body (202). */
  private async notify(method: string): Promise<void> {
    if (!this.serverUrl) return
    const res = await this.client.fetch(this.serverUrl, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
    await res.text().catch(() => '')
  }

  stop(): void {
    // End the session on the server too; best effort, nothing waits on it.
    if (this.serverUrl && this.sessionId) {
      void this.client
        .fetch(this.serverUrl, { method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(5_000) })
        .catch(() => undefined)
    }
    this.sessionId = null
    this.currentConnection = null
  }

  /**
   * Execute an MCP tool call and return its result text, budgeted to the model.
   * The caller is responsible for origin-tagging so the model knows it ran on the
   * Nest, not locally (HANDOFF 4.3).
   */
  async callTool(name: string, args: unknown): Promise<string> {
    return (await this.callToolResult(name, args)).text
  }

  /**
   * One tools/call, with what the approval exchange needs: `meta` is sent as
   * `params._meta` (the approval id on a repeated call), and a pending approval
   * in the result's `_meta` is handed back rather than flattened into text.
   */
  async callToolResult(name: string, args: unknown, meta?: Record<string, unknown>): Promise<NestCallResult> {
    const params: Record<string, unknown> = { name, arguments: args }
    if (meta && Object.keys(meta).length > 0) params._meta = meta
    const res = await this.rpc('tools/call', params, CALL_TIMEOUT_MS)
    if (res.error) return { text: `[Tool ${name} failed: ${res.error.message}]`, isError: true, approval: null }
    const result = res.result as Record<string, unknown> | undefined
    const approval = approvalRequired(result)
    if (approval) return { text: this.extractText(result), isError: true, approval }
    // MCP tools/call returns isError + content. A server-side policy denial
    // (write/destructive policy, banned tool) arrives as isError=true with a
    // human-readable reason in the content — render it distinctly so the model
    // knows this was refused by the server, not a local failure. (HANDOFF 4.4)
    if (result && result.isError === true) {
      const reason = this.extractText(result)
      return {
        text: `[Server denial for "${name}": ${reason || 'policy refusal, tool not available'}]`,
        isError: true,
        approval: null,
      }
    }
    return { text: this.extractText(res.result), isError: false, approval: null }
  }

  /**
   * The account's workflows, as MCP prompts (Nest workflows-storage.mjs):
   * personal ones, then the organization's (named `org-…`).
   */
  async listPrompts(): Promise<McpPrompt[]> {
    const res = await this.rpc('prompts/list')
    if (res.error) throw new Error(res.error.message)
    const prompts = (res.result as { prompts?: unknown[] } | undefined)?.prompts ?? []
    return prompts.flatMap((raw) => {
      const p = raw as Record<string, unknown>
      if (typeof p.name !== 'string' || !p.name) return []
      const args = Array.isArray(p.arguments) ? p.arguments : []
      return [{
        name: p.name,
        title: typeof p.title === 'string' && p.title ? p.title : p.name,
        ...(typeof p.description === 'string' && p.description ? { description: p.description } : {}),
        arguments: args.flatMap((a) => {
          const r = a as Record<string, unknown>
          if (typeof r.name !== 'string') return []
          return [{
            name: r.name,
            required: r.required === true,
            ...(typeof r.description === 'string' && r.description ? { description: r.description } : {}),
          }]
        }),
      }]
    })
  }

  /**
   * Compose a workflow. Nest builds the text from its own copy of the
   * workflow: a client can only name one and supply argument values, never
   * inject the instructions themselves.
   */
  async getPrompt(name: string, args: Record<string, string>): Promise<string> {
    const res = await this.rpc('prompts/get', { name, arguments: args })
    if (res.error) throw new Error(res.error.message)
    const messages = (res.result as { messages?: Array<{ content?: { type?: string; text?: string } }> } | undefined)?.messages ?? []
    const text = messages
      .map((m) => (m.content?.type === 'text' && typeof m.content.text === 'string' ? m.content.text : ''))
      .filter(Boolean)
      .join('\n\n')
    if (!text) throw new Error(`Workflow "${name}" came back empty`)
    return text
  }

  // --- private plumbing -------------------------------------------------------

  /**
   * The built-in server's URL. Nest advertises a full URL ending in /mcp; a
   * relative one (a bare path) is anchored against the gateway.
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
  // MCP puts provenance in `_meta` (Nest stamps capability, class and the
  // approval rule there). `meta` is accepted too, for older fixtures.
  const meta = (raw as { _meta?: Record<string, unknown> })._meta ?? raw.meta
  if (meta) tool.meta = meta
  return tool
}
