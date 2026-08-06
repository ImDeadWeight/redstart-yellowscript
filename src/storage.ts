// =============================================================================
// VSCode-backed implementations of the ConnectionManager's storage ports.
// =============================================================================
// Credentials go in SecretStorage and nowhere else — not settings.json (which
// syncs and lands in dotfile repos), not workspaceState, not a log line, and
// never into model context. The only non-secret thing we persist is which
// server we last used.
// =============================================================================

import type * as vscode from 'vscode'

import type { CredentialStore, StateStore } from './connection.ts'
import type { Credential } from './nest/types.ts'

/** Namespaced so a key can never collide with another extension's. */
const SECRET_PREFIX = 'redstartYellowscript.credential:'
const LAST_SERVER_KEY = 'redstartYellowscript.lastServerUrl'

export class SecretCredentialStore implements CredentialStore {
  private readonly secrets: vscode.SecretStorage

  constructor(secrets: vscode.SecretStorage) {
    this.secrets = secrets
  }

  async get(serverUrl: string): Promise<Credential | null> {
    const raw = await this.secrets.get(SECRET_PREFIX + serverUrl)
    if (!raw) return null
    try {
      return parseCredential(JSON.parse(raw))
    } catch {
      // Corrupt or from an older format — treat as absent rather than throwing
      // the user into an unrecoverable state. They just sign in again.
      return null
    }
  }

  async set(serverUrl: string, credential: Credential): Promise<void> {
    await this.secrets.store(SECRET_PREFIX + serverUrl, JSON.stringify(credential))
  }

  async delete(serverUrl: string): Promise<void> {
    await this.secrets.delete(SECRET_PREFIX + serverUrl)
  }
}

/**
 * Validate a stored blob back into a Credential. A shape we don't recognise
 * must not be handed to the client as a bearer token.
 */
export function parseCredential(value: unknown): Credential | null {
  if (typeof value !== 'object' || value === null) return null
  const obj = value as Record<string, unknown>

  if (obj.kind === 'session' && typeof obj.token === 'string' && typeof obj.username === 'string') {
    return { kind: 'session', token: obj.token, username: obj.username }
  }
  if (obj.kind === 'apiKey' && typeof obj.key === 'string') {
    return { kind: 'apiKey', key: obj.key }
  }
  return null
}

/**
 * Which Nest this window last talked to.
 *
 * Deliberately workspaceState, not globalState: a workspace is where the
 * project lives, and different projects can reasonably target different Nests
 * (a shared team box for one, a laptop for another).
 */
export class WorkspaceStateStore implements StateStore {
  private readonly memento: vscode.Memento

  constructor(memento: vscode.Memento) {
    this.memento = memento
  }

  getLastServerUrl(): string | undefined {
    return this.memento.get<string>(LAST_SERVER_KEY)
  }

  async setLastServerUrl(url: string | undefined): Promise<void> {
    await this.memento.update(LAST_SERVER_KEY, url)
  }
}
