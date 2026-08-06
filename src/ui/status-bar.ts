// =============================================================================
// Status bar — the one always-visible answer to "is Yellowscript working?"
// =============================================================================
// Three things belong here and nothing else: are we connected, to what, and as
// whom. Phase 1 adds the live model name and tokens/sec once the completions
// stream exists; `setModel` is the seam for that.
//
// Clicking always does the most useful next thing for the current state —
// connect when disconnected, sign in when unauthenticated, show details when
// connected — so the item is never merely decorative.
// =============================================================================

import * as vscode from 'vscode'

import { type ConnectionState, type UnauthenticatedReason } from '../connection.ts'

export class StatusBar {
  private readonly item: vscode.StatusBarItem
  private model: string | null = null
  private tokensPerSecond: number | null = null
  private state: ConnectionState = { status: 'disconnected' }

  constructor() {
    // Right-aligned with a high priority so it sits near the language/encoding
    // indicators rather than getting buried behind every SCM extension.
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    this.item.name = 'Redstart Yellowscript'
    this.render()
    this.item.show()
  }

  update(state: ConnectionState): void {
    this.state = state
    // A model belongs to a connection. Dropping it on any non-connected state
    // stops a stale model name from implying we are still talking to a Nest.
    if (state.status !== 'connected') {
      this.model = null
      this.tokensPerSecond = null
    }
    this.render()
  }

  /** Phase 1 seam: called when /v1/models resolves and as timings stream in. */
  setModel(model: string | null, tokensPerSecond: number | null = null): void {
    this.model = model
    this.tokensPerSecond = tokensPerSecond
    this.render()
  }

  private render(): void {
    const { text, tooltip, command, warning } = this.presentation()
    this.item.text = text
    this.item.tooltip = tooltip
    this.item.command = command
    this.item.backgroundColor = warning
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined
  }

  private presentation(): {
    text: string
    tooltip: string
    command: string
    warning: boolean
  } {
    const state = this.state
    switch (state.status) {
      case 'disconnected':
        return {
          text: '$(circle-slash) Yellowscript',
          tooltip: 'Not connected to a Redstart Nest. Click to connect.',
          command: 'redstartYellowscript.connect',
          warning: false,
        }

      case 'discovering':
        return {
          text: '$(sync~spin) Finding Nest…',
          tooltip: 'Scanning the local network for a Redstart Nest.',
          command: 'redstartYellowscript.showStatus',
          warning: false,
        }

      case 'connecting':
        return {
          text: '$(sync~spin) Yellowscript',
          tooltip: `Connecting to ${state.url}…`,
          command: 'redstartYellowscript.showStatus',
          warning: false,
        }

      case 'unauthenticated':
        return {
          text: '$(key) Sign in',
          tooltip: `${signInHint(state.reason)}\n${state.url}\n\nClick to sign in.`,
          command: 'redstartYellowscript.signIn',
          // Warning-coloured: this state needs the user to act, and a grey
          // status item is exactly what people stop noticing.
          warning: true,
          }

      case 'connected': {
        const label = this.model ?? 'Nest'
        const rate = this.tokensPerSecond ? ` · ${this.tokensPerSecond.toFixed(1)} tok/s` : ''
        const identity = state.authRequired
          ? `Signed in as ${state.user?.username ?? 'unknown'} (${state.user?.role ?? 'unknown role'})`
          : 'Authentication is disabled on this Nest'
        return {
          text: `$(rocket) ${label}${rate}`,
          tooltip: `Redstart Yellowscript\n${state.url}\n${identity}${this.model ? `\nModel: ${this.model}` : ''}`,
          command: 'redstartYellowscript.showStatus',
          warning: false,
        }
      }

      case 'error':
        return {
          text: '$(error) Yellowscript',
          tooltip: `${state.message}\n\nClick to retry.`,
          command: 'redstartYellowscript.connect',
          warning: true,
        }
    }
  }

  dispose(): void {
    this.item.dispose()
  }
}

function signInHint(reason: UnauthenticatedReason): string {
  switch (reason) {
    case 'session-expired':
      return 'Your session ended — the Nest was probably restarted.'
    case 'key-rejected':
      return 'The stored API key was rejected. You will need a new one.'
    case 'rejected':
      return 'Sign-in failed.'
    case 'no-credential':
      return 'Sign in to this Redstart Nest.'
  }
}
