// =============================================================================
// The Redstart account in VS Code's Accounts menu.
// =============================================================================
// An AuthenticationProvider, so the signed-in Redstart account shows where
// every other signed-in extension shows its account, with "Sign Out" there.
// It is a window onto ConnectionManager, not a second credential store: the
// credential stays in SecretStorage, keyed per server, and never leaves the
// host. The session's accessToken is deliberately empty: nothing outside this
// extension should be handed a key to the Nest through this API.
// =============================================================================

import * as vscode from 'vscode'

import type { ConnectionManager } from '../connection.ts'

export const AUTH_PROVIDER_ID = 'redstart'

export class RedstartAuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>()
  readonly onDidChangeSessions = this.changed.event
  private current: vscode.AuthenticationSession | null = null
  private readonly subscription: { dispose(): void }

  constructor(
    private readonly manager: ConnectionManager,
    private readonly actions: { signIn(): Promise<void>; signOut(): Promise<void> },
  ) {
    this.current = this.sessionFromState()
    this.subscription = manager.onDidChangeState(() => this.refresh())
  }

  private sessionFromState(): vscode.AuthenticationSession | null {
    const state = this.manager.state
    if (state.status !== 'connected' || !state.user) return null
    const host = (() => {
      try {
        return new URL(state.url).host
      } catch {
        return state.url
      }
    })()
    return {
      id: `${state.url}#${state.user.username}`,
      accessToken: '',
      account: { id: `${state.url}#${state.user.id}`, label: `${state.user.username} (${host})` },
      scopes: [],
    }
  }

  private refresh(): void {
    const next = this.sessionFromState()
    const before = this.current
    if (before?.id === next?.id) return
    this.current = next
    this.changed.fire({
      added: next && !before ? [next] : [],
      removed: before && !next ? [before] : [],
      changed: before && next ? [next] : [],
    })
  }

  async getSessions(): Promise<vscode.AuthenticationSession[]> {
    return this.current ? [this.current] : []
  }

  async createSession(): Promise<vscode.AuthenticationSession> {
    await this.actions.signIn()
    this.refresh()
    if (!this.current) throw new Error('Not signed in to a Redstart Nest.')
    return this.current
  }

  async removeSession(): Promise<void> {
    await this.actions.signOut()
    this.refresh()
  }

  dispose(): void {
    this.subscription.dispose()
    this.changed.dispose()
  }
}
