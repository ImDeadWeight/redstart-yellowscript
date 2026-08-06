// =============================================================================
// ConnectionManager — the connect/authenticate state machine.
// =============================================================================
// Everything the extension knows about "are we talking to a Nest, and as whom"
// lives here. It imports no `vscode` API; the host wires real implementations of
// the four injected dependencies in extension.ts, and tests pass fakes.
//
// The design problem this solves is that a 401 from Nest is ambiguous, and
// guessing wrong strands the user:
//
//   - Session tokens live in the Nest's MEMORY ONLY. Restarting the Nest — a
//     routine thing an operator does to load a different model — invalidates
//     every session token. A 401 here is expected and the fix is "sign in
//     again", not "your password is wrong".
//   - An `rst_` API key is persistent. A 401 means it was revoked or mistyped,
//     and silently re-prompting for the same key just loops.
//
// So the credential kind is stored alongside the credential, and the reason for
// landing in `unauthenticated` is carried in the state for the UI to explain.
// =============================================================================

import { discoverNests, type DiscoveredNest } from './nest/discovery.ts'
import { NestClient } from './nest/client.ts'
import { NestHttpError, type Credential, type NestUser } from './nest/types.ts'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Why we are sitting at a sign-in prompt. Drives the wording the user sees. */
export type UnauthenticatedReason =
  /** Nothing stored for this server yet. */
  | 'no-credential'
  /** A stored session token was rejected — almost always a Nest restart. */
  | 'session-expired'
  /** A stored API key was rejected — revoked or wrong. Re-prompting is futile. */
  | 'key-rejected'
  /** A sign-in attempt just failed. */
  | 'rejected'

export type ConnectionState =
  | { status: 'disconnected' }
  | { status: 'discovering' }
  | { status: 'connecting'; url: string }
  | { status: 'unauthenticated'; url: string; reason: UnauthenticatedReason }
  | { status: 'connected'; url: string; authRequired: boolean; user: NestUser | null }
  | { status: 'error'; message: string; url?: string }

export function describeState(state: ConnectionState): string {
  switch (state.status) {
    case 'disconnected':
      return 'Not connected to a Redstart Nest.'
    case 'discovering':
      return 'Scanning the local network for a Redstart Nest…'
    case 'connecting':
      return `Connecting to ${state.url}…`
    case 'unauthenticated':
      switch (state.reason) {
        case 'no-credential':
          return `Sign in to ${state.url}.`
        case 'session-expired':
          return `Your session ended (the Nest was likely restarted). Sign in again to ${state.url}.`
        case 'key-rejected':
          return `The stored API key was rejected by ${state.url}. Enter a new one.`
        case 'rejected':
          return `Sign-in failed at ${state.url}.`
      }
    // falls through is impossible — every reason returns above
    case 'connected':
      if (!state.authRequired) return `Connected to ${state.url} (authentication disabled).`
      return `Connected to ${state.url} as ${state.user?.username ?? 'unknown'}.`
    case 'error':
      return state.message
  }
}

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/** Credential persistence. Backed by VSCode SecretStorage in the real host —
 *  never by settings.json, and never written into model context or logs. */
export interface CredentialStore {
  get(serverUrl: string): Promise<Credential | null>
  set(serverUrl: string, credential: Credential): Promise<void>
  delete(serverUrl: string): Promise<void>
}

/** Somewhere to remember the last server, so a new window reconnects silently. */
export interface StateStore {
  getLastServerUrl(): string | undefined
  setLastServerUrl(url: string | undefined): Promise<void>
}

export interface ConnectionDeps {
  credentials: CredentialStore
  state: StateStore
  createClient: (baseUrl: string) => NestClient
  discover: () => Promise<DiscoveredNest[]>
}

export interface ConnectOptions {
  /** Skip discovery and go straight to this URL. */
  url?: string
  /** Don't scan even if no URL is known — used by silent auto-connect. */
  noDiscovery?: boolean
  signal?: AbortSignal
}

type Listener = (state: ConnectionState) => void

// ---------------------------------------------------------------------------
// ConnectionManager
// ---------------------------------------------------------------------------

export class ConnectionManager {
  private current: ConnectionState = { status: 'disconnected' }
  private listeners: Listener[] = []
  private client: NestClient | null = null
  // Explicit field, not a parameter property — Node's type stripping (which
  // runs the tests without a build step) does not support that syntax.
  private readonly deps: ConnectionDeps

  constructor(deps: ConnectionDeps) {
    this.deps = deps
  }

  get state(): ConnectionState {
    return this.current
  }

  /** The authenticated client, or null unless we are fully connected. */
  get activeClient(): NestClient | null {
    return this.current.status === 'connected' ? this.client : null
  }

  onDidChangeState(listener: Listener): { dispose(): void } {
    this.listeners.push(listener)
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener)
      },
    }
  }

  private setState(next: ConnectionState): void {
    this.current = next
    for (const listener of this.listeners) listener(next)
  }

  /**
   * Find a Nest (or use the given/remembered URL), then establish identity.
   *
   * Resolves with the resulting state rather than throwing: every failure mode
   * here is a state the UI needs to render, not an exception to bubble.
   */
  async connect(options: ConnectOptions = {}): Promise<ConnectionState> {
    const explicit = options.url ?? this.deps.state.getLastServerUrl()

    let url = explicit
    if (!url) {
      if (options.noDiscovery) {
        this.setState({ status: 'disconnected' })
        return this.current
      }

      this.setState({ status: 'discovering' })
      let found: DiscoveredNest[]
      try {
        found = await this.deps.discover()
      } catch (err) {
        return this.fail(`Network scan failed: ${messageOf(err)}`)
      }

      if (found.length === 0) {
        return this.fail(
          'No Redstart Nest found on this network. Start the Nest, or set redstartYellowscript.serverUrl manually.',
        )
      }

      const best = found[0] as DiscoveredNest
      if (!best.running) {
        // Identified a Nest, but it has no model loaded. Say exactly that —
        // "not found" would send the user hunting for a network problem that
        // isn't there.
        return this.fail(
          `Found a Redstart Nest at ${best.ip}, but no model is running. Start a model in the Nest, then connect again.`,
          best.url,
        )
      }
      url = best.url
    }

    return this.establish(url, options.signal)
  }

  /**
   * Bring up `url`: confirm it speaks Nest, learn whether auth is on, and
   * resolve identity from whatever credential we have stored.
   */
  private async establish(url: string, signal?: AbortSignal): Promise<ConnectionState> {
    this.setState({ status: 'connecting', url })
    const client = this.deps.createClient(url)
    this.client = client

    let authRequired: boolean
    try {
      authRequired = (await client.getAuthConfig(signal)).authRequired
    } catch (err) {
      return this.fail(`Could not reach a Redstart Nest at ${url}: ${messageOf(err)}`, url)
    }

    // Auth disabled (a dev-mode Nest). Admin routes stay locked server-side
    // regardless, so there is nothing to sign in to.
    if (!authRequired) {
      client.setCredential(null)
      await this.deps.state.setLastServerUrl(url)
      this.setState({ status: 'connected', url, authRequired: false, user: null })
      return this.current
    }

    const stored = await this.deps.credentials.get(url)
    if (!stored) {
      this.setState({ status: 'unauthenticated', url, reason: 'no-credential' })
      return this.current
    }

    client.setCredential(stored)
    return this.verify(client, url, stored, signal)
  }

  /** Confirm a credential by asking who it belongs to. */
  private async verify(
    client: NestClient,
    url: string,
    credential: Credential,
    signal?: AbortSignal,
  ): Promise<ConnectionState> {
    try {
      const me = await client.getMe(signal)
      await this.deps.state.setLastServerUrl(url)
      this.setState({ status: 'connected', url, authRequired: me.authRequired, user: me.user })
      return this.current
    } catch (err) {
      if (err instanceof NestHttpError && err.isUnauthorized) {
        // Dead credential — drop it so we never retry it, and say which kind of
        // dead it is. A session token expiring is routine; a rejected API key
        // means the user has to go get a different one.
        await this.deps.credentials.delete(url)
        client.setCredential(null)
        this.setState({
          status: 'unauthenticated',
          url,
          reason: credential.kind === 'session' ? 'session-expired' : 'key-rejected',
        })
        return this.current
      }
      return this.fail(`Could not verify identity at ${url}: ${messageOf(err)}`, url)
    }
  }

  /** Sign in with a username and password, storing the resulting session token. */
  async signInWithPassword(username: string, password: string, signal?: AbortSignal): Promise<ConnectionState> {
    const url = this.urlForSignIn()
    if (!url) return this.fail('Connect to a Nest before signing in.')

    const client = this.client ?? this.deps.createClient(url)
    this.client = client

    try {
      const result = await client.login(username, password, signal)
      const credential: Credential = { kind: 'session', token: result.token, username: result.user.username }
      await this.deps.credentials.set(url, credential)
      client.setCredential(credential)
      await this.deps.state.setLastServerUrl(url)
      this.setState({ status: 'connected', url, authRequired: true, user: result.user })
      return this.current
    } catch (err) {
      if (err instanceof NestHttpError && err.isUnauthorized) {
        // Nest returns an identical message for an unknown user and a wrong
        // password (deliberately — it refuses to confirm which usernames
        // exist). Don't invent a distinction it withholds.
        this.setState({ status: 'unauthenticated', url, reason: 'rejected' })
        return this.current
      }
      return this.fail(`Sign-in failed: ${messageOf(err)}`, url)
    }
  }

  /** Sign in with a pasted `rst_` API key. */
  async signInWithApiKey(key: string, signal?: AbortSignal): Promise<ConnectionState> {
    const url = this.urlForSignIn()
    if (!url) return this.fail('Connect to a Nest before signing in.')

    const client = this.client ?? this.deps.createClient(url)
    this.client = client

    const credential: Credential = { kind: 'apiKey', key: key.trim() }
    client.setCredential(credential)

    try {
      const me = await client.getMe(signal)
      // Only persist a key we have actually seen work.
      await this.deps.credentials.set(url, credential)
      await this.deps.state.setLastServerUrl(url)
      this.setState({ status: 'connected', url, authRequired: me.authRequired, user: me.user })
      return this.current
    } catch (err) {
      client.setCredential(null)
      if (err instanceof NestHttpError && err.isUnauthorized) {
        this.setState({ status: 'unauthenticated', url, reason: 'rejected' })
        return this.current
      }
      return this.fail(`Could not verify the API key: ${messageOf(err)}`, url)
    }
  }

  /** Forget the stored credential for the current server and drop to signed-out. */
  async signOut(): Promise<ConnectionState> {
    const url = this.urlForSignIn()
    if (!url) return this.current

    // Best-effort: tell the Nest to drop the session. A failure here doesn't
    // matter — the credential is going away locally either way, and session
    // tokens die with the server anyway.
    try {
      await this.client?.logout()
    } catch {
      // ignored on purpose
    }

    await this.deps.credentials.delete(url)
    this.client?.setCredential(null)
    this.setState({ status: 'unauthenticated', url, reason: 'no-credential' })
    return this.current
  }

  /** Drop the connection entirely and stop auto-reconnecting to it. */
  async disconnect(): Promise<void> {
    this.client = null
    await this.deps.state.setLastServerUrl(undefined)
    this.setState({ status: 'disconnected' })
  }

  /**
   * Report a 401 observed on some later request (a completion, a tool call).
   * Moves us out of `connected` so the UI can prompt, without a full reconnect.
   */
  async handleUnauthorized(): Promise<void> {
    const url = this.urlForSignIn()
    if (!url) return
    const credential = this.client?.getCredential()
    await this.deps.credentials.delete(url)
    this.client?.setCredential(null)
    this.setState({
      status: 'unauthenticated',
      url,
      reason: credential?.kind === 'apiKey' ? 'key-rejected' : 'session-expired',
    })
  }

  /** The server a sign-in would target, in any state that has one. */
  private urlForSignIn(): string | undefined {
    const state = this.current
    if (state.status === 'connected' || state.status === 'unauthenticated' || state.status === 'connecting') {
      return state.url
    }
    return state.status === 'error' ? state.url : undefined
  }

  private fail(message: string, url?: string): ConnectionState {
    this.setState(url ? { status: 'error', message, url } : { status: 'error', message })
    return this.current
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Default discovery wiring — the real network sweep. */
export function createDiscovery(getTimeoutMs: () => number): () => Promise<DiscoveredNest[]> {
  return () => discoverNests({ timeoutMs: getTimeoutMs() })
}
