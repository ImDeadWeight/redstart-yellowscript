// =============================================================================
// Redstart Yellowscript — extension entry point.
// =============================================================================
// Phase 0: find a Nest, prove who we are, show it in the status bar. No chat,
// no tools yet — those are Phases 1 and 2.
//
// This file is the only place that knows about both `vscode` and the connection
// machinery. Everything below it (connection, discovery, client) is plain Node
// and unit-tested without an extension host, which is what keeps `npm test`
// dependency-free and fast.
// =============================================================================

import * as vscode from 'vscode'

import {
  ConnectionManager,
  createDiscovery,
  describeState,
  type ConnectionState,
} from './connection.ts'
import { NestClient, normalizeBaseUrl } from './nest/client.ts'
import { SecretCredentialStore, WorkspaceStateStore } from './storage.ts'
import { StatusBar } from './ui/status-bar.ts'

const CONFIG_SECTION = 'redstartYellowscript'

let manager: ConnectionManager | undefined
let statusBar: StatusBar | undefined
let output: vscode.LogOutputChannel | undefined

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Redstart Yellowscript', { log: true })
  statusBar = new StatusBar()

  manager = new ConnectionManager({
    credentials: new SecretCredentialStore(context.secrets),
    state: new WorkspaceStateStore(context.workspaceState),
    createClient: (baseUrl) => new NestClient(baseUrl),
    discover: createDiscovery(() => config().get<number>('discovery.timeoutMs', 400)),
  })

  context.subscriptions.push(
    output,
    statusBar,
    manager.onDidChangeState(onStateChanged),
    vscode.commands.registerCommand('redstartYellowscript.connect', connectCommand),
    vscode.commands.registerCommand('redstartYellowscript.disconnect', disconnectCommand),
    vscode.commands.registerCommand('redstartYellowscript.signIn', signInCommand),
    vscode.commands.registerCommand('redstartYellowscript.signOut', signOutCommand),
    vscode.commands.registerCommand('redstartYellowscript.showStatus', showStatusCommand),
  )

  if (config().get<boolean>('autoConnect', true)) {
    // Silent: no scan and no error popup on startup. A user who opens a window
    // with the Nest switched off should see a quiet status bar, not a modal.
    void manager
      .connect({ ...explicitUrl(), noDiscovery: !explicitUrl().url })
      .catch((err: unknown) => output?.error('Auto-connect failed', err))
  }
}

export function deactivate(): void {
  statusBar?.dispose()
  statusBar = undefined
  manager = undefined
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function connectCommand(): Promise<void> {
  if (!manager) return

  const override = explicitUrl()
  const discoveryEnabled = config().get<boolean>('discovery.enabled', true)

  const state = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Connecting to Redstart Nest…' },
    () => manager!.connect({ ...override, noDiscovery: !override.url && !discoveryEnabled }),
  )

  // Connecting is user-initiated, so failures get surfaced rather than logged.
  if (state.status === 'error') {
    const enterManually = 'Enter URL…'
    const choice = await vscode.window.showErrorMessage(state.message, enterManually)
    if (choice === enterManually) await promptForServerUrl()
    return
  }

  if (state.status === 'unauthenticated') {
    await signInCommand()
    return
  }

  if (state.status === 'connected') {
    vscode.window.setStatusBarMessage(`$(rocket) ${describeState(state)}`, 4000)
  }
}

async function disconnectCommand(): Promise<void> {
  await manager?.disconnect()
}

/**
 * Sign in, offering both paths Nest accepts on the same header: a full login,
 * or a pasted `rst_` key. The key path exists for headless/shared setups where
 * a password prompt is the wrong shape.
 */
async function signInCommand(): Promise<void> {
  if (!manager) return

  const state = manager.state
  if (state.status === 'disconnected' || state.status === 'discovering') {
    vscode.window.showWarningMessage('Connect to a Redstart Nest first.')
    return
  }

  const method = await vscode.window.showQuickPick(
    [
      { label: '$(account) Username and password', detail: 'Sign in with a Redstart account', id: 'password' },
      { label: '$(key) API key', detail: 'Paste an rst_… key', id: 'apiKey' },
    ],
    { title: 'Sign in to Redstart Nest', placeHolder: 'How do you want to authenticate?' },
  )
  if (!method) return

  const result = method.id === 'password' ? await passwordFlow() : await apiKeyFlow()
  if (!result) return

  if (result.status === 'connected') {
    vscode.window.showInformationMessage(describeState(result))
  } else if (result.status === 'unauthenticated' && result.reason === 'rejected') {
    // Nest gives the same 401 for an unknown user as for a wrong password, on
    // purpose. Don't imply we know which one it was.
    vscode.window.showErrorMessage('Sign-in failed. Check the credentials and try again.')
  } else if (result.status === 'error') {
    vscode.window.showErrorMessage(result.message)
  }
}

async function passwordFlow(): Promise<ConnectionState | undefined> {
  const username = await vscode.window.showInputBox({
    title: 'Redstart Nest — sign in',
    prompt: 'Username',
    ignoreFocusOut: true,
  })
  if (!username) return undefined

  const password = await vscode.window.showInputBox({
    title: 'Redstart Nest — sign in',
    prompt: `Password for ${username}`,
    password: true,
    ignoreFocusOut: true,
  })
  if (password === undefined) return undefined

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Signing in…' },
    () => manager!.signInWithPassword(username, password),
  )
}

async function apiKeyFlow(): Promise<ConnectionState | undefined> {
  const key = await vscode.window.showInputBox({
    title: 'Redstart Nest — API key',
    prompt: 'Paste an rst_ API key',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().startsWith('rst_') ? null : 'Redstart API keys start with "rst_".',
  })
  if (!key) return undefined

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Verifying key…' },
    () => manager!.signInWithApiKey(key),
  )
}

async function signOutCommand(): Promise<void> {
  const state = await manager?.signOut()
  if (state) vscode.window.showInformationMessage('Signed out of the Redstart Nest.')
}

/** A details view that also offers the next useful action for the state. */
async function showStatusCommand(): Promise<void> {
  if (!manager) return
  const state = manager.state
  const message = describeState(state)

  const actions: string[] = []
  if (state.status === 'connected') actions.push('Sign Out', 'Disconnect')
  if (state.status === 'unauthenticated') actions.push('Sign In')
  if (state.status === 'error' || state.status === 'disconnected') actions.push('Connect', 'Enter URL…')

  const choice = await vscode.window.showInformationMessage(message, ...actions)
  switch (choice) {
    case 'Sign In':
      return signInCommand()
    case 'Sign Out':
      return signOutCommand()
    case 'Connect':
      return connectCommand()
    case 'Disconnect':
      return disconnectCommand()
    case 'Enter URL…':
      return promptForServerUrl()
  }
}

/** Manual fallback for a Nest discovery can't see (different subnet, VPN). */
async function promptForServerUrl(): Promise<void> {
  const entered = await vscode.window.showInputBox({
    title: 'Redstart Nest URL',
    prompt: 'Gateway address, e.g. 192.168.1.20:19080',
    value: config().get<string>('serverUrl', ''),
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value.trim()) return 'Enter a host and port.'
      try {
        new URL(normalizeBaseUrl(value))
        return null
      } catch {
        return 'That is not a valid URL.'
      }
    },
  })
  if (!entered) return

  const url = normalizeBaseUrl(entered)
  await config().update('serverUrl', url, vscode.ConfigurationTarget.Workspace)
  await manager?.connect({ url })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_SECTION)
}

/** The configured override, if any, in the shape connect() expects. */
function explicitUrl(): { url?: string } {
  const configured = config().get<string>('serverUrl', '').trim()
  return configured ? { url: normalizeBaseUrl(configured) } : {}
}

function onStateChanged(state: ConnectionState): void {
  statusBar?.update(state)
  // The credential never reaches the log — only the state name and the server.
  const target = 'url' in state && state.url ? ` (${state.url})` : ''
  output?.info(`connection: ${state.status}${target}`)
}
