// =============================================================================
// Nest wire types.
// =============================================================================
// These mirror response shapes pinned by redstart-nest's test suite
// (scripts/test-contracts.mjs, test-auth.mjs). A shape marked "pinned" below
// fails Nest's CI if it drifts — but Nest's CI does not gate THIS repo, so the
// live smoke test (npm run smoke) is what actually protects us. Keep the two in
// sync.
//
// Verified against redstart-nest @ 52fbf08, 2026-08-05.
// =============================================================================

/** GET /auth/config — pinned. Callable without a token. */
export interface AuthConfig {
  authRequired: boolean
}

/**
 * The user object embedded in /auth/login and /auth/me — pinned to exactly
 * these fields. It never carries a secret; `apiKeyPrefix` is a display stub,
 * not a usable key.
 */
export interface NestUser {
  id: string
  username: string
  role: string
  apiKeyPrefix: string
  createdAt: string
  lastLoginAt: string | null
}

/** POST /auth/login — pinned. */
export interface LoginResponse {
  token: string
  user: NestUser
}

/** GET /auth/me — pinned. `user` is null when auth is off. */
export interface MeResponse {
  authRequired: boolean
  user: NestUser | null
}

/** GET /redstart/mcp-servers. */
export interface McpServersResponse {
  servers: Array<{ name: string; url: string }>
  /**
   * Function names the server has centrally banned. This is UX guidance — grey
   * them out, don't offer them. Real enforcement is the gateway stripping them
   * out of every completions request. Never re-enable one client-side.
   *
   * Derived from the ACTIVE PROFILE's disabled tool IDs, so it changes when the
   * Nest operator switches profiles. Re-fetch on reconnect; don't cache for the
   * life of a session.
   */
  disabledTools: string[]
}

/** GET /v1/models — passthrough to llama-server. */
export interface ModelsResponse {
  data: Array<{ id: string; object?: string; created?: number; owned_by?: string }>
}

/**
 * A credential for the `Authorization: Bearer <value>` header. Nest accepts
 * both kinds on the same header, but they fail differently and so must be
 * told apart:
 *
 *  - `session` tokens live in the Nest's memory only. A Nest restart
 *    invalidates every one of them, so a 401 here is routine and means
 *    "log in again", not "your credentials are wrong".
 *  - `apiKey` (`rst_…`) is persistent. A 401 here means the key was revoked or
 *    mistyped, and re-prompting for the same key will not help.
 */
export type Credential =
  | { kind: 'session'; token: string; username: string }
  | { kind: 'apiKey'; key: string }

export function credentialValue(credential: Credential): string {
  return credential.kind === 'session' ? credential.token : credential.key
}

/** An HTTP-level failure from Nest, carrying the status so callers can branch. */
export class NestHttpError extends Error {
  // Fields are declared and assigned explicitly rather than via TypeScript
  // parameter properties: Node's native type stripping (which is what lets
  // `npm test` run the .ts sources with no build step) rejects that syntax
  // because it emits code rather than only erasing types.
  readonly status: number
  readonly url: string | undefined

  constructor(status: number, message: string, url?: string) {
    super(message)
    this.name = 'NestHttpError'
    this.status = status
    this.url = url
  }

  /** 401 — credential missing, expired, or revoked. */
  get isUnauthorized(): boolean {
    return this.status === 401
  }

  /** 502 — the gateway is up but no llama-server is running behind it. */
  get isNoModel(): boolean {
    return this.status === 502
  }
}
