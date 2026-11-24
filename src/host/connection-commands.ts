// =============================================================================
// The connection to the Nest, as the person drives it: connect, disconnect,
// sign in and out, the status details, the server address, and what follows
// a change of state (the status bar, the account, the model).
// =============================================================================
// It owns which account is signed in, because only a change of connection
// state sets it; everything that scopes by account reads it from here.
// =============================================================================

import * as vscode from 'vscode'

import { describeState, type ConnectionManager, type ConnectionState } from '../connection.ts'
import { NestClient, normalizeBaseUrl } from '../nest/client.ts'
import { discoverNests, localAddresses, localSubnets, type DiscoveredNest } from '../nest/discovery.ts'
import type { ConversationStore } from '../ui/conversation-store.ts'
import type { StatusBar } from '../ui/status-bar.ts'
import { config, explicitUrl } from './config.ts'

type Log = Pick<vscode.LogOutputChannel, 'info' | 'warn' | 'error' | 'debug'>

/** What the panel's login screen sends. */
export type PanelSignIn =
  | { method: 'password'; username: string; password: string }
  | { method: 'apiKey'; key: string }
  | { method: 'clientKey' }

export interface ConnectionDeps {
  manager: ConnectionManager
  statusBar: Pick<StatusBar, 'update' | 'setModel'>
  log: Log
  conversations: Pick<ConversationStore, 'migrateAccountId'>
  /** Each view's snapshot changed (connection, model, server). */
  onSessionChanged: () => void
  /** Signed in (again, or as another account): views follow the account. */
  onSignedIn: () => void
  /** Connected: bring up the Nest's tools. */
  onConnected: () => void
  /** About to disconnect: drop the Nest's tools. */
  onDisconnect: () => void
}

export interface ConnectionCommands {
  /** The signed-in account's username, or null. */
  account(): string | null
  connect(): Promise<void>
  disconnect(): Promise<void>
  signIn(): Promise<void>
  signOut(): Promise<void>
  showStatus(): Promise<void>
  promptForServerUrl(): Promise<void>
  /** Save the Nest's address (empty: back to discovery) and connect. */
  applyServerUrl(entered: string): Promise<void>
  /** A sign-in from the panel's login screen. */
  signInFromPanel(message: PanelSignIn): Promise<void>
  /** On startup, when the setting allows: quietly, no scan for a set URL. */
  autoConnect(): void
  onStateChanged(state: ConnectionState): void
}

export function createConnectionCommands(deps: ConnectionDeps): ConnectionCommands {
  const { manager, log } = deps
  /** The currently signed-in account username, used to scope conversation history.
   *  Set from `/auth/me` on connect/sign-in; cleared on sign-out/disconnect. */
  let currentAccountId: string | null = null

  /** Report how a sign-in ended. Nest gives the same 401 for an unknown user
   *  as for a wrong password, on purpose; don't imply we know which it was. */
  const reportSignIn = (result: ConnectionState): void => {
    if (result.status === 'connected') {
      vscode.window.showInformationMessage(describeState(result))
    } else if (result.status === 'unauthenticated' && result.reason === 'rejected') {
      vscode.window.showErrorMessage('Sign-in failed. Check the credentials and try again.')
    } else if (result.status === 'error') {
      vscode.window.showErrorMessage(result.message)
    }
  }

  async function connect(): Promise<void> {
    const override = explicitUrl()
    const discoveryEnabled = config().get<boolean>('discovery.enabled', true)

    const state = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Connecting to Redstart Nest…' },
      () => manager.connect({ ...override, noDiscovery: !override.url && !discoveryEnabled }),
    )

    // Connecting is user-initiated, so failures get surfaced rather than logged.
    if (state.status === 'error') {
      const enterManually = 'Enter URL…'
      const choice = await vscode.window.showErrorMessage(state.message, enterManually)
      if (choice === enterManually) await promptForServerUrl()
      return
    }

    if (state.status === 'unauthenticated') {
      await signIn()
      return
    }

    if (state.status === 'connected') {
      vscode.window.setStatusBarMessage(`$(rocket) ${describeState(state)}`, 4000)
    }
  }

  async function disconnect(): Promise<void> {
    deps.onDisconnect()
    await manager.disconnect()
  }

  /**
   * Sign in, offering both paths Nest accepts on the same header: a full login,
   * or a pasted `rst_` key. The key path exists for headless/shared setups where
   * a password prompt is the wrong shape.
   */
  async function signIn(): Promise<void> {
    const state = manager.state
    if (state.status === 'disconnected' || state.status === 'discovering') {
      vscode.window.showWarningMessage('Connect to a Redstart Nest first.')
      return
    }

    const method = await vscode.window.showQuickPick(
      [
        { label: '$(account) Username and password', detail: 'Used once: Yellowscript keeps a key for this app instead', id: 'password' },
        { label: '$(key) API key', detail: 'Paste an rst_… key', id: 'apiKey' },
      ],
      { title: 'Sign in to Redstart Nest', placeHolder: 'How do you want to authenticate?' },
    )
    if (!method) return

    const result = method.id === 'password' ? await passwordFlow() : await apiKeyFlow()
    if (!result) return
    reportSignIn(result)
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
      () => manager.signInWithPassword(username, password),
    )
  }

  async function apiKeyFlow(): Promise<ConnectionState | undefined> {
    const key = await vscode.window.showInputBox({
      title: 'Redstart Nest — API key',
      prompt: 'Paste an rst_ API key',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().startsWith('rst_') ? null : 'Redstart API keys start with "rst_".'),
    })
    if (!key) return undefined

    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Verifying key…' },
      () => manager.signInWithApiKey(key),
    )
  }

  async function signOut(): Promise<void> {
    const state = await manager.signOut()
    currentAccountId = null
    if (state) vscode.window.showInformationMessage('Signed out of the Redstart Nest.')
  }

  /** A details view that also offers the next useful action for the state. */
  async function showStatus(): Promise<void> {
    const state = manager.state
    const message = describeState(state)

    const actions: string[] = []
    if (state.status === 'connected') actions.push('Sign Out', 'Disconnect')
    if (state.status === 'unauthenticated') actions.push('Sign In')
    if (state.status === 'error' || state.status === 'disconnected') actions.push('Connect')
    // Always offered: it is the only route to changing or clearing a saved URL,
    // and needing it while connected is the common case.
    actions.push('Enter URL…')

    const choice = await vscode.window.showInformationMessage(message, ...actions)
    switch (choice) {
      case 'Sign In':
        return signIn()
      case 'Sign Out':
        return signOut()
      case 'Connect':
        return connect()
      case 'Disconnect':
        return disconnect()
      case 'Enter URL…':
        return promptForServerUrl()
    }
  }

  /** Manual fallback for a Nest discovery can't see (different subnet, VPN). */
  async function promptForServerUrl(): Promise<void> {
    const entered = await vscode.window.showInputBox({
      title: 'Redstart Nest URL',
      prompt: 'Gateway address, e.g. 192.168.1.20:19080. Clear the box to go back to automatic discovery.',
      value: config().get<string>('serverUrl', ''),
      ignoreFocusOut: true,
      validateInput: (value) => {
        // An empty box is a real choice, not a mistake: it is the only way back
        // to discovery once a URL has been saved. Rejecting it left users editing
        // .vscode/settings.json by hand to undo a decision they made in a dialog.
        if (!value.trim()) return null
        try {
          new URL(normalizeBaseUrl(value))
          return null
        } catch {
          return 'That is not a valid URL.'
        }
      },
    })
    // Dismissed, as opposed to deliberately emptied.
    if (entered === undefined) return
    await applyServerUrl(entered)
  }

  /** Save the Nest's address (empty: back to discovery) and connect. From the
   *  input box above, or the login screen's connection details. */
  async function applyServerUrl(entered: string): Promise<void> {
    if (entered.trim() === '') {
      // `undefined` removes the key rather than storing "", which would still
      // count as an explicit override and keep discovery switched off.
      await config().update('serverUrl', undefined, vscode.ConfigurationTarget.Workspace)
      deps.onSessionChanged()
      vscode.window.setStatusBarMessage('$(search) Yellowscript will discover the Nest automatically', 4000)
      await manager.connect({})
      return
    }

    const url = normalizeBaseUrl(entered)
    try {
      new URL(url)
    } catch {
      return
    }
    await config().update('serverUrl', url, vscode.ConfigurationTarget.Workspace)
    deps.onSessionChanged()
    await manager.connect({ url })
  }

  async function signInFromPanel(message: PanelSignIn): Promise<void> {
    let result: ConnectionState | undefined
    if (message.method === 'password') {
      result = await manager.signInWithPassword(message.username, message.password)
    } else if (message.method === 'apiKey') {
      result = await manager.signInWithApiKey(message.key)
    } else {
      const url = manager.urlForSignIn()
      if (!url) return
      const client = new NestClient(url)
      const existing = manager.activeClient?.getCredential()
      if (existing) client.setCredential(existing)
      result = await manager.signInWithClient(client, 'yellowscript', 'Yellowscript VS Code extension')
    }
    if (!result) return
    reportSignIn(result)
  }

  /**
   * Ask the Nest what model is loaded.
   *
   * A 502 here is not an error worth shouting about: it means the gateway is up
   * but no model is running, which the status bar already conveys. Anything else
   * goes to the log and nowhere else — the user asked to connect, not to hear
   * about /v1/models.
   */
  async function refreshModel(): Promise<void> {
    const client = manager.activeClient
    if (!client) return

    try {
      const models = await client.listModels()
      const id = models.data[0]?.id
      if (id) {
        deps.statusBar.setModel(id)
        deps.onSessionChanged()
      }
    } catch (err) {
      log.debug(`Could not list models: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function onStateChanged(state: ConnectionState): void {
    deps.statusBar.update(state)
    deps.onSessionChanged()

    // The credential never reaches the log — only the state name and the server.
    const target = 'url' in state && state.url ? ` (${state.url})` : ''
    log.info(`connection: ${state.status}${target}`)

    if (state.status === 'connected') {
      // Track the signed-in account so conversation history can be scoped to it.
      const user = 'user' in state ? state.user : undefined
      currentAccountId = user?.username ?? null
      if (currentAccountId) {
        const migrated = deps.conversations.migrateAccountId(currentAccountId)
        if (migrated > 0) {
          log.info(`history: migrated ${migrated} conversation(s) to account "${currentAccountId}"`)
        }
      }
      log.info(`account: ${currentAccountId ?? 'unknown'}`)
      deps.onSignedIn()

      void refreshModel()
      deps.onConnected()
    } else if (state.status === 'disconnected' || state.status === 'unauthenticated') {
      currentAccountId = null
    }
  }

  return {
    account: () => currentAccountId,
    connect,
    disconnect,
    signIn,
    signOut,
    showStatus,
    promptForServerUrl,
    applyServerUrl,
    signInFromPanel,
    autoConnect() {
      if (!config().get<boolean>('autoConnect', true)) return
      // Silent: no scan and no error popup on startup. A user who opens a window
      // with the Nest switched off should see a quiet status bar, not a modal.
      void manager
        .connect({ ...explicitUrl(), noDiscovery: !!explicitUrl().url })
        .catch((err: unknown) => log.error('Auto-connect failed', err))
    },
    onStateChanged,
  }
}

/**
 * The network sweep, with enough logging to diagnose a miss.
 *
 * "No Nest found on this network" is the least actionable message the extension
 * can produce, and the causes are all invisible from the outside: the machine's
 * own subnets were not what you assumed, a VPN or virtual adapter crowded the
 * real LAN out of the scan, or the probes went out and nothing answered. The
 * scan reports which of those happened rather than leaving the user to guess.
 *
 * The interface list is logged because it is the fact that actually decides the
 * outcome — `localSubnets` derives a /24 from each of this machine's addresses
 * and keeps only the first few, so a laptop with Docker, WSL and a VPN can push
 * the real network off the end of the list.
 */
export function loggedDiscovery(log: Log): () => Promise<DiscoveredNest[]> {
  // `discoverNests` is called directly rather than through `createDiscovery`,
  // so the per-sweep failure summary can be captured and logged.
  return async () => {
    const timeoutMs = config().get<number>('discovery.timeoutMs', 400)
    const addresses = localAddresses()
    const subnets = localSubnets()

    log.info(
      `discovery: own addresses [${addresses.join(', ')}] -> scanning ${subnets.length} subnet(s) ` +
        `[${subnets.map((s) => `${s}.1-254`).join(', ')}] at ${timeoutMs}ms per host`,
    )

    const startedAt = Date.now()
    let failures: Record<string, number> = {}
    const found = await discoverNests({
      timeoutMs,
      onFailureSummary: (reasons) => {
        failures = reasons
      },
    })
    const elapsed = Date.now() - startedAt

    if (found.length === 0) {
      // The histogram is the diagnosis. All `timeout` means the probes are
      // being dropped in flight (firewall, VPN, AP client isolation); all
      // `ECONNREFUSED` means the hosts were reached and nothing is listening
      // on the beacon port, which is a different problem entirely.
      const summary =
        Object.entries(failures)
          .sort((a, b) => b[1] - a[1])
          .map(([reason, count]) => `${reason}×${count}`)
          .join(', ') || 'no failures recorded'
      log.warn(
        `discovery: nothing answered on ${subnets.join(', ')} after ${elapsed}ms — ${summary}. ` +
          `If the Nest is on one of those subnets and reachable, the probes are being blocked ` +
          `(firewall, VPN, or AP client isolation); set redstartYellowscript.serverUrl instead.`,
      )
    } else {
      log.info(
        `discovery: found ${found.length} in ${elapsed}ms — ` +
          found.map((nest) => `${nest.url} (running=${nest.running})`).join(', '),
      )
    }

    return found
  }
}
