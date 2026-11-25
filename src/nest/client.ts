// =============================================================================
// NestClient — every HTTP call to a Redstart Nest gateway.
// =============================================================================
// The extension host owns all requests. Nothing here ever runs in the webview:
// the credential must not cross that boundary, even though the gateway's CORS
// policy would technically permit it.
//
// The gateway is the only port a client talks to. llama-server sits behind it
// on port+1 bound to loopback, and the MCP server on port+2 is discovered
// through /redstart/mcp-servers — never addressed by arithmetic.
//
// No `vscode` import: unit-testable under `node --test`.
// =============================================================================

import {
  NestHttpError,
  credentialValue,
  type AuthConfig,
  type ClientKeysResponse,
  type ContextExceeded,
  type Credential,
  type IssueClientKeyResponse,
  type LoginResponse,
  type McpServersResponse,
  type MeResponse,
  type ModelsResponse,
} from './types.ts'
import {
  DONE_SENTINEL,
  SseParser,
  parseStreamChunk,
  type ParsedChunk,
  type StreamTimings,
  type ToolCallDelta,
} from './streaming.ts'

const DEFAULT_TIMEOUT_MS = 10_000

/** Injected so tests don't need a live server. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * fetch for the Nest's API: never follows a redirect. A Nest in LAN-HTTPS
 * mode answers http://<ip>:80 with a 308 to its https name, and following it
 * crosses origins, which drops the Authorization header: every request then
 * came back 401 and read as a sign-out (2026-11-24). Sign-in was worse: a
 * 308 keeps the body, so the password went wherever port 80 pointed. A
 * redirect is reported instead (httpError), naming where it leads.
 */
export const nestFetch: FetchLike = (input, init) => fetch(input, { ...init, redirect: 'manual' })

export interface NestClientOptions {
  fetch?: FetchLike
  timeoutMs?: number
}

/** Strip a trailing slash so `${baseUrl}${path}` never doubles up. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return withScheme.replace(/\/+$/, '')
}

/** What llama-server reports about the loaded model (see NestClient.props). */
export interface ModelProps {
  nCtx: number | null
  vision: boolean
}

export class NestClient {
  readonly baseUrl: string
  private readonly doFetch: FetchLike
  private readonly timeoutMs: number
  private credential: Credential | null = null

  constructor(baseUrl: string, options: NestClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.doFetch = options.fetch ?? nestFetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  setCredential(credential: Credential | null): void {
    this.credential = credential
  }

  getCredential(): Credential | null {
    return this.credential
  }

  /**
   * One request. Adds the bearer header when we hold a credential, enforces a
   * timeout, and turns a non-2xx into a NestHttpError carrying the status.
   *
   * `signal` from the caller composes with the timeout — whichever fires first
   * aborts the request.
   */
  async request<T>(
    path: string,
    init: RequestInit & { authenticated?: boolean; signal?: AbortSignal } = {},
  ): Promise<T> {
    const { authenticated = true, signal, ...rest } = init
    const url = `${this.baseUrl}${path}`

    const headers = new Headers(rest.headers)
    if (authenticated && this.credential) {
      headers.set('Authorization', `Bearer ${credentialValue(this.credential)}`)
    }
    if (rest.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    const timeout = AbortSignal.timeout(this.timeoutMs)
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout

    let response: Response
    try {
      response = await this.doFetch(url, { ...rest, headers, signal: composed })
    } catch (err) {
      // A caller-driven abort is a cancellation, not a connection failure —
      // let it propagate as-is so the UI doesn't report a bogus error.
      if (signal?.aborted) throw err
      const reason = err instanceof Error ? err.message : String(err)
      throw new NestHttpError(0, `Could not reach the Nest at ${this.baseUrl} (${reason})`, url)
    }

    if (!response.ok) {
      throw await httpError(response, url)
    }

    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  // --- Auth -----------------------------------------------------------------

  /** Public route — no credential needed, and none is sent. */
  getAuthConfig(signal?: AbortSignal): Promise<AuthConfig> {
    return this.request<AuthConfig>('/auth/config', { authenticated: false, ...(signal ? { signal } : {}) })
  }

  /**
   * Exchange username/password for a session token. 401 means bad credentials —
   * Nest deliberately returns the same message for an unknown user as for a
   * wrong password, so never try to tell the user which it was.
   */
  login(username: string, password: string, signal?: AbortSignal): Promise<LoginResponse> {
    return this.request<LoginResponse>('/auth/login', {
      method: 'POST',
      authenticated: false,
      body: JSON.stringify({ username, password }),
      ...(signal ? { signal } : {}),
    })
  }

  getMe(signal?: AbortSignal): Promise<MeResponse> {
    return this.request<MeResponse>('/auth/me', signal ? { signal } : {})
  }

  logout(signal?: AbortSignal): Promise<void> {
    return this.request<void>('/auth/logout', { method: 'POST', ...(signal ? { signal } : {}) })
  }

  /**
   * List this account's per-connector keys and the surfaces the deployment
   * knows. Used to surface "issue a Yellowscript key" in the sign-in flow.
   */
  listClientKeys(signal?: AbortSignal): Promise<ClientKeysResponse> {
    return this.request<ClientKeysResponse>('/auth/me/client-keys', signal ? { signal } : {})
  }

  /**
   * Issue a fresh per-connector client key bound to `surface`. The raw key is
   * returned exactly once — callers must persist it immediately. A surface the
   * deployment does not know is refused server-side.
   */
  issueClientKey(surface: string, label?: string, signal?: AbortSignal): Promise<IssueClientKeyResponse> {
    return this.request<IssueClientKeyResponse>('/auth/me/client-keys', {
      method: 'POST',
      body: JSON.stringify({ surface, ...(label ? { label } : {}) }),
      ...(signal ? { signal } : {}),
    })
  }

  // --- Models & MCP ---------------------------------------------------------

  /**
   * Passthrough to llama-server. Throws NestHttpError(502) when the gateway is
   * up but no model is loaded — a normal, recoverable state worth reporting
   * distinctly rather than as "connection failed".
   */
  listModels(signal?: AbortSignal): Promise<ModelsResponse> {
    return this.request<ModelsResponse>('/v1/models', signal ? { signal } : {})
  }

  /**
   * llama-server's /props, through the gateway's passthrough: the context
   * window (n_ctx) and whether the model reads images. Missing fields come
   * back null/false rather than throwing, since the agent can run without
   * them (it then learns n_ctx from the first context-exceeded refusal).
   */
  async props(signal?: AbortSignal): Promise<ModelProps> {
    const body = await this.request<{
      default_generation_settings?: { n_ctx?: unknown }
      n_ctx?: unknown
      modalities?: { vision?: unknown }
    }>('/props', signal ? { signal } : {})
    const raw = body?.default_generation_settings?.n_ctx ?? body?.n_ctx
    return {
      nCtx: typeof raw === 'number' && raw > 0 ? raw : null,
      vision: body?.modalities?.vision === true,
    }
  }

  /**
   * The discovery mechanism for MCP — the built-in server's URL comes from here,
   * never from `gatewayPort + 2`. Re-fetch on every reconnect: both the server
   * list and `disabledTools` follow the Nest's active profile.
   */
  listMcpServers(signal?: AbortSignal): Promise<McpServersResponse> {
    return this.request<McpServersResponse>('/redstart/mcp-servers', signal ? { signal } : {})
  }

  // --- Projects -------------------------------------------------------------

  /** The signed-in account's Nest projects (owner-only until sharing lands). */
  listProjects(signal?: AbortSignal): Promise<{ projects: NestProject[] }> {
    return this.request<{ projects: NestProject[] }>('/projects', signal ? { signal } : {})
  }

  /** Create a project. Nest refuses a duplicate name (409) and past its limit. */
  createProject(name: string, instructions = ''): Promise<NestProject> {
    return this.request<NestProject>('/projects', {
      method: 'POST',
      body: JSON.stringify({ name, instructions }),
    })
  }

  // --- Completions ----------------------------------------------------------

  /**
   * Stream a chat completion, invoking `handlers` as pieces arrive.
   *
   * Deliberately NOT routed through `request()`: that helper reads the whole
   * body as JSON, which is exactly wrong here. The timeout is also different —
   * a generation legitimately runs for minutes, so only the caller's abort
   * signal ends it early.
   *
   * Two behaviours of the gateway apply and are not worth fighting:
   *  - it prepends a Redstart system message to whatever we send
   *  - it strips centrally-banned tool names from `tools` and `tool_choice`
   */
  async streamChatCompletion(
    request: ChatCompletionRequest,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<StreamResult> {
    const url = `${this.baseUrl}/v1/chat/completions`
    const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' })
    if (this.credential) {
      headers.set('Authorization', `Bearer ${credentialValue(this.credential)}`)
    }

    let response: Response
    try {
      response = await this.doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...request, stream: true }),
        ...(signal ? { signal } : {}),
      })
    } catch (err) {
      if (signal?.aborted) throw err
      const reason = err instanceof Error ? err.message : String(err)
      throw new NestHttpError(0, `Could not reach the Nest at ${this.baseUrl} (${reason})`, url)
    }

    if (!response.ok) {
      throw await httpError(response, url)
    }
    if (!response.body) {
      throw new NestHttpError(0, 'The Nest returned an empty response stream', url)
    }

    const result: StreamResult = { content: '', reasoning: '', toolCalls: [], aborted: false }
    const parser = new SseParser()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    const consume = (payload: string): boolean => {
      if (payload === DONE_SENTINEL) return true
      const chunk = parseStreamChunk(payload)
      if (chunk) apply(chunk, result, handlers)
      return false
    }

    try {
      for (;;) {
        // Check before every read, not only when the read itself rejects.
        // `fetch` normally rejects an in-flight read on abort, but that is the
        // transport's courtesy, not a guarantee we should depend on — a stream
        // that simply stops producing would otherwise hang the turn forever
        // with no way for the user to cancel it.
        if (signal?.aborted) {
          result.aborted = true
          break
        }

        const { done, value } = await reader.read()
        if (done) break

        let finished = false
        for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
          if (consume(payload)) {
            finished = true
            break
          }
        }
        if (finished) break
      }
      for (const payload of parser.flush()) consume(payload)
    } catch (err) {
      // An abort mid-read is a cancellation, not a failure. The partial content
      // accumulated so far is still real and worth keeping on screen.
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        result.aborted = true
      } else {
        throw err
      }
    } finally {
      // Best-effort: releasing a already-errored reader throws, and that must
      // not mask the real error.
      try {
        await reader.cancel()
      } catch {
        // ignored on purpose
      }
    }

    return result
  }
}

/** What we send to /v1/chat/completions. `stream` is set by the client. */
export interface ChatCompletionRequest {
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool'
    /** Parts for a user message with images (chat/attachments.ts). */
    content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
    reasoning_content?: string
    tool_calls?: unknown[]
    tool_call_id?: string
  }>
  model?: string
  temperature?: number
  /** The most tokens one reply may run to (llama-server's default is no limit). */
  max_tokens?: number
  /** Phase 2. Sending these changes the gateway's injected system context: it
   *  only claims Nest capabilities when a request actually carries tools. */
  tools?: unknown[]
  tool_choice?: unknown
  /** The Nest project this chat works in. Nest checks the caller may read it,
   *  then adds its instructions and memories to the prompt. */
  redstart_project?: string
}

/** A Nest project, as GET /projects lists it. */
export interface NestProject {
  id: string
  name: string
  instructions?: string
  /** The project's files folder, relative to the account's Documents. */
  folder?: string
  updatedAt?: number
}

export interface StreamHandlers {
  onContent?: (text: string) => void
  onReasoning?: (text: string) => void
  onModel?: (model: string) => void
  onTimings?: (timings: StreamTimings) => void
  /** Tool call deltas as they arrive: a call's name, then its arguments in pieces. */
  onToolCalls?: (deltas: ToolCallDelta[]) => void
}

export interface StreamResult {
  content: string
  reasoning: string
  toolCalls: ToolCallDelta[]
  timings?: StreamTimings
  model?: string
  finishReason?: string
  /** True when the caller cancelled; `content` still holds what arrived. */
  aborted: boolean
}

/** Fold one parsed chunk into the accumulating result and notify listeners. */
function apply(chunk: ParsedChunk, result: StreamResult, handlers: StreamHandlers): void {
  if (chunk.content) {
    result.content += chunk.content
    handlers.onContent?.(chunk.content)
  }
  if (chunk.reasoning) {
    result.reasoning += chunk.reasoning
    handlers.onReasoning?.(chunk.reasoning)
  }
  if (chunk.toolCalls) {
    result.toolCalls.push(...chunk.toolCalls)
    handlers.onToolCalls?.(chunk.toolCalls)
  }
  if (chunk.model && !result.model) {
    result.model = chunk.model
    handlers.onModel?.(chunk.model)
  }
  if (chunk.timings) {
    // Timings stream repeatedly; the last one is the complete picture.
    result.timings = chunk.timings
    handlers.onTimings?.(chunk.timings)
  }
  if (chunk.finishReason) {
    result.finishReason = chunk.finishReason
  }
}

/**
 * Nest reports errors as `{ error: { message, type } }`. Fall back to the
 * status text for a body that isn't that shape (a proxy error page, an empty
 * 502) so the user always gets something to act on.
 */
async function describeError(response: Response): Promise<{ message: string; contextExceeded?: ContextExceeded }> {
  try {
    const body = (await response.json()) as {
      error?: { message?: string; type?: string; n_ctx?: unknown; n_prompt_tokens?: unknown }
    }
    const error = body?.error
    const message = error?.message
    if (typeof message === 'string' && message.length > 0) {
      // llama-server says exactly how big the window is when a prompt does
      // not fit. The agent loop trims with these numbers and tries again.
      if (error?.type === 'exceed_context_size_error' && typeof error.n_ctx === 'number' && error.n_ctx > 0) {
        const contextExceeded: ContextExceeded = { nCtx: error.n_ctx }
        if (typeof error.n_prompt_tokens === 'number') contextExceeded.promptTokens = error.n_prompt_tokens
        return { message, contextExceeded }
      }
      return { message }
    }
  } catch {
    // Not JSON — fall through.
  }
  if (response.status === 401) return { message: 'Unauthorized' }
  if (response.status === 502) return { message: 'No model is running on the Nest' }
  return { message: response.statusText || `HTTP ${response.status}` }
}

/** What a redirect from the Nest is reported as. */
export function redirectMessage(url: string, location: string | null): string {
  let from = url
  let to = location ?? ''
  try {
    from = new URL(url).origin
    if (location) to = new URL(location, url).origin
  } catch {
    // Keep the raw strings.
  }
  return to
    ? `The Nest at ${from} redirects to ${to}. Connect to ${to} instead (Yellowscript does not follow redirects, so your sign-in is never sent elsewhere).`
    : `The Nest at ${from} answered with a redirect. Connect to its https address instead.`
}

/** An HTTP error from a failed response, with its context-exceeded numbers. */
async function httpError(response: Response, url: string): Promise<NestHttpError> {
  // Not followed (nestFetch): say where it leads, so the fix is plain.
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel()
    return new NestHttpError(response.status, redirectMessage(url, response.headers.get('location')), url)
  }
  const { message, contextExceeded } = await describeError(response)
  return new NestHttpError(response.status, message, url, contextExceeded)
}
