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
  type Credential,
  type LoginResponse,
  type McpServersResponse,
  type MeResponse,
  type ModelsResponse,
} from './types.ts'

const DEFAULT_TIMEOUT_MS = 10_000

/** Injected so tests don't need a live server. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

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

export class NestClient {
  readonly baseUrl: string
  private readonly doFetch: FetchLike
  private readonly timeoutMs: number
  private credential: Credential | null = null

  constructor(baseUrl: string, options: NestClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init))
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
      throw new NestHttpError(response.status, await describeError(response), url)
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
   * The discovery mechanism for MCP — the built-in server's URL comes from here,
   * never from `gatewayPort + 2`. Re-fetch on every reconnect: both the server
   * list and `disabledTools` follow the Nest's active profile.
   */
  listMcpServers(signal?: AbortSignal): Promise<McpServersResponse> {
    return this.request<McpServersResponse>('/redstart/mcp-servers', signal ? { signal } : {})
  }
}

/**
 * Nest reports errors as `{ error: { message, type } }`. Fall back to the
 * status text for a body that isn't that shape (a proxy error page, an empty
 * 502) so the user always gets something to act on.
 */
async function describeError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    const message = body?.error?.message
    if (typeof message === 'string' && message.length > 0) return message
  } catch {
    // Not JSON — fall through.
  }
  if (response.status === 401) return 'Unauthorized'
  if (response.status === 502) return 'No model is running on the Nest'
  return response.statusText || `HTTP ${response.status}`
}
