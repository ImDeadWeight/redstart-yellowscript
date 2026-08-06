// =============================================================================
// Redstart Yellowscript — extension entry point.
// =============================================================================
// Phase 1: find a Nest, prove who we are, and hold a streaming conversation with
// it in the sidebar. No tools yet — that is Phase 2.
//
// This file is the only place that knows about both `vscode` and the domain
// machinery. Everything below it (connection, discovery, client, chat) is plain
// Node and unit-tested without an extension host, which is what keeps `npm test`
// dependency-free and fast.
// =============================================================================

import * as vscode from 'vscode'

import { ConnectionManager, describeState, type ConnectionState } from './connection.ts'
import {
  discoverNests,
  localAddresses,
  localSubnets,
  type DiscoveredNest,
} from './nest/discovery.ts'
import { ChatSession } from './chat/session.ts'
import type { HostMessage, SessionSnapshot } from './chat/protocol.ts'
import { NestClient, normalizeBaseUrl } from './nest/client.ts'
import { SecretCredentialStore, WorkspaceStateStore } from './storage.ts'
import { StatusBar } from './ui/status-bar.ts'
import { ChatViewProvider } from './ui/chat-view.ts'
import { createToolRegistry, type ToolRegistry } from './tools/registry.ts'
import {
  diagnosticsProvider,
  editorStateProvider,
  resolveRipgrep,
  workspaceRoots,
} from './ui/tool-providers.ts'

const CONFIG_SECTION = 'redstartYellowscript'

let manager: ConnectionManager | undefined
let statusBar: StatusBar | undefined
let output: vscode.LogOutputChannel | undefined
let session: ChatSession | undefined
let chatView: ChatViewProvider | undefined
let tools: ToolRegistry | undefined
/** Resolved once — the binary does not move while the window is open, and
 *  probing the filesystem on every search would be wasteful. */
let ripgrepPath: string | null = null

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Redstart Yellowscript', { log: true })
  statusBar = new StatusBar()

  manager = new ConnectionManager({
    credentials: new SecretCredentialStore(context.secrets),
    state: new WorkspaceStateStore(context.workspaceState),
    createClient: (baseUrl) => new NestClient(baseUrl),
    discover: loggedDiscovery(),
  })

  // The ws_* tools. Built at activation so a missing ripgrep is a known,
  // reportable state rather than a surprise on the first search — the search
  // tools drop to literal matching and say so in the description the model
  // plans against. Nothing sends these to the Nest yet; that is 2.3.
  ripgrepPath = resolveRipgrep()
  tools = createToolRegistry({
    ripgrepPath,
    diagnostics: diagnosticsProvider,
    editorState: editorStateProvider,
  })
  const roots = workspaceRoots()
  output.info(
    `tools: ${tools.names.length} registered (${tools.names.join(', ')}); ` +
      `search backend: ${ripgrepPath === null ? 'DEGRADED — ripgrep not found' : 'ripgrep'}; ` +
      `workspace folders: ${roots.length}`,
  )
  if (roots.length === 0) {
    // Worth stating plainly. With no folder open every ws_* tool refuses by
    // design, and that reads as a broken extension unless it is spelled out.
    output.warn('No workspace folder is open — every ws_* tool will refuse until one is.')
  }
  if (ripgrepPath === null) {
    // Worth a log line with the appRoot: the layout has changed between VSCode
    // versions before, and this is the fact needed to add the new one.
    output.warn(`ripgrep was not found under appRoot ${vscode.env.appRoot}`)
  } else {
    output.debug(`ripgrep: ${ripgrepPath}`)
  }

  session = new ChatSession({
    getClient: () => manager?.activeClient ?? null,
    onUnauthorized: () => manager?.handleUnauthorized(),
    // Resolved per turn, not captured once: a user can add or remove a folder
    // mid-conversation, and with no folder open the tools are withheld
    // entirely rather than offered in a state where they can only refuse.
    tools: () => (workspaceRoots().length > 0 ? (tools ?? null) : null),
    toolContext: () => ({ workspaceRoots: workspaceRoots() }),
    emit: (message) => {
      chatView?.post(message)
      // The status bar shows the generation rate of the most recent turn — the
      // number that tells you at a glance whether the Nest is healthy.
      if (message.type === 'turn/completed' && message.stats?.tokensPerSecond) {
        statusBar?.setModel(session?.currentModel ?? null, message.stats.tokensPerSecond)
      }
      logToolActivity(message)
    },
  })

  chatView = new ChatViewProvider(context.extensionUri, {
    onSend: (text) => {
      const finished = session?.send(text)
      // `send` marks itself busy synchronously before its first await, so this
      // observes busy=true and the webview can swap Send for Stop immediately
      // rather than after the whole turn.
      pushSession()
      void finished?.then(pushSession)
    },
    onAbort: () => {
      session?.abort()
      pushSession()
    },
    onNewConversation: () => {
      session?.reset()
      pushSession()
    },
    onRunCommand: (command) => {
      void vscode.commands.executeCommand(`redstartYellowscript.${command}`)
    },
    // Fires on first open AND every time VSCode rebuilds a view it destroyed
    // while hidden — so this must be a complete handoff, not a delta.
    onReady: () => {
      chatView?.sendInit(snapshot(), session?.snapshot() ?? [])
    },
  })

  context.subscriptions.push(
    output,
    statusBar,
    manager.onDidChangeState(onStateChanged),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatView, {
      // Keep the transcript alive when the panel is hidden. Without this the
      // webview is torn down and the user loses their place in the conversation
      // every time they switch to the file explorer.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('redstartYellowscript.connect', connectCommand),
    vscode.commands.registerCommand('redstartYellowscript.disconnect', disconnectCommand),
    vscode.commands.registerCommand('redstartYellowscript.signIn', signInCommand),
    vscode.commands.registerCommand('redstartYellowscript.signOut', signOutCommand),
    vscode.commands.registerCommand('redstartYellowscript.showStatus', showStatusCommand),
    vscode.commands.registerCommand('redstartYellowscript.newChat', newChatCommand),
    vscode.commands.registerCommand('redstartYellowscript.inspectTools', inspectToolsCommand),
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
  session?.abort()
  session = undefined
  chatView = undefined
  manager = undefined
}

/**
 * Record what the model actually did with its tools.
 *
 * `recovered` is the fact worth having. It says the model did NOT emit a
 * structured `tool_calls` field and the call had to be salvaged out of its text
 * or its reasoning — which is the difference between llama.cpp parsing this
 * model's chat template correctly and the fallback carrying the whole feature.
 * That is a per-model property, invisible from the panel, and the thing to check
 * first when switching models or when the agent starts behaving oddly.
 *
 * Arguments are logged trimmed: they are model-authored and can be a whole file
 * of content on a Phase 3 write call.
 */
function logToolActivity(message: HostMessage): void {
  if (message.type === 'tool/call') {
    const args = message.arguments.length > 300 ? `${message.arguments.slice(0, 300)}…` : message.arguments
    output?.info(
      `tool call: ${message.name}(${args})` +
        (message.recovered ? '  [RECOVERED from text — no structured tool_calls]' : ''),
    )
  } else if (message.type === 'tool/result') {
    output?.info(
      `tool result: ${message.name} -> ${message.isError ? 'ERROR' : 'ok'}` +
        `${message.truncated ? ', truncated' : ''} — ${message.summary}`,
    )
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
function loggedDiscovery(): () => Promise<DiscoveredNest[]> {
  // `discoverNests` is called directly rather than through `createDiscovery`,
  // so the per-sweep failure summary can be captured and logged.
  return async () => {
    const timeoutMs = config().get<number>('discovery.timeoutMs', 400)
    const addresses = localAddresses()
    const subnets = localSubnets()

    output?.info(
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
      output?.warn(
        `discovery: nothing answered on ${subnets.join(', ')} after ${elapsed}ms — ${summary}. ` +
          `If the Nest is on one of those subnets and reachable, the probes are being blocked ` +
          `(firewall, VPN, or AP client isolation); set redstartYellowscript.serverUrl instead.`,
      )
    } else {
      output?.info(
        `discovery: found ${found.length} in ${elapsed}ms — ` +
          found.map((nest) => `${nest.url} (running=${nest.running})`).join(', '),
      )
    }

    return found
  }
}

// ---------------------------------------------------------------------------
// Session snapshot — the projection the webview renders around the transcript
// ---------------------------------------------------------------------------

function snapshot(): SessionSnapshot {
  const state = manager?.state ?? { status: 'disconnected' as const }
  const busy = session?.busy === true
  const connected = state.status === 'connected'

  const base: SessionSnapshot = {
    connection: state.status,
    detail: describeState(state),
    // Sending needs a connection AND no turn already running.
    canSend: connected && !busy,
    busy,
  }
  if ('url' in state && state.url) base.serverUrl = state.url
  const model = session?.currentModel
  if (model) base.model = model
  return base
}

function pushSession(): void {
  chatView?.post({ type: 'session', session: snapshot() })
}

// ---------------------------------------------------------------------------
// Model discovery — fills the status bar with what is actually loaded
// ---------------------------------------------------------------------------

/**
 * Ask the Nest what model is loaded.
 *
 * A 502 here is not an error worth shouting about: it means the gateway is up
 * but no model is running, which the status bar already conveys. Anything else
 * goes to the log and nowhere else — the user asked to connect, not to hear
 * about /v1/models.
 */
async function refreshModel(): Promise<void> {
  const client = manager?.activeClient
  if (!client) return

  try {
    const models = await client.listModels()
    const id = models.data[0]?.id
    if (id) {
      statusBar?.setModel(id)
      pushSession()
    }
  } catch (err) {
    output?.debug(`Could not list models: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function newChatCommand(): Promise<void> {
  session?.reset()
  pushSession()
  await chatView?.reveal()
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
  if (state.status === 'error' || state.status === 'disconnected') actions.push('Connect')
  // Always offered: it is the only route to changing or clearing a saved URL,
  // and needing it while connected is the common case.
  actions.push('Enter URL…')

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

/**
 * Run a ws_* tool by hand and show what the model would receive.
 *
 * This is the only way to exercise the VSCode-backed providers — diagnostics
 * and editor context — outside an agent turn, since unit tests cannot reach the
 * real `vscode` API. It doubles as the answer to "what can the agent actually
 * see in this workspace?", which is a fair question for a user to ask about a
 * tool that reads their files.
 */
async function inspectToolsCommand(): Promise<void> {
  // Show the channel FIRST. Every failure below is then visible in it, rather
  // than the command appearing to do nothing — which is exactly what an earlier
  // version of this did when it returned early without saying so.
  output?.show(true)
  output?.info('--- Inspect Workspace Tools ---')

  if (!tools) {
    output?.error('The tool registry was never built. The extension did not activate cleanly.')
    vscode.window.showErrorMessage('Yellowscript: tools are not available — see the output channel.')
    return
  }

  const roots = workspaceRoots()
  output?.info(`workspace folders: ${roots.length > 0 ? roots.join(', ') : '(none open)'}`)
  output?.info(`search backend: ${ripgrepPath === null ? 'DEGRADED — ripgrep not found' : ripgrepPath}`)
  output?.info(`registered: ${tools.names.join(', ')}`)

  if (roots.length === 0) {
    output?.warn('No folder is open, so every tool will refuse. Open a folder and run this again.')
    return
  }

  // Run the zero-argument tools and one filesystem probe. These are the checks
  // that cannot be made from a unit test: ws_diagnostics and ws_editor_context
  // read live VSCode state through the providers, and this is the only place
  // that wiring gets exercised outside an agent turn.
  const probes: Array<{ name: string; args: string }> = [
    { name: 'ws_editor_context', args: '{}' },
    { name: 'ws_diagnostics', args: '{}' },
    { name: 'ws_list_directory', args: '{"path":"."}' },
    { name: 'ws_glob', args: '{"pattern":"**/*.ts"}' },
  ]

  for (const probe of probes) {
    try {
      const result = await tools.execute(probe.name, probe.args, { workspaceRoots: roots })
      const status = result.isError ? 'ERROR' : 'ok'
      output?.info(
        `\n=== ${probe.name}(${probe.args}) -> ${status}${result.truncated ? ', truncated' : ''} ===\n${result.content}`,
      )
    } catch (err) {
      // A tool throwing is a bug — the contract says failures come back as
      // results. Surface it loudly rather than swallowing it.
      output?.error(`${probe.name} THREW (this is a bug, not a refusal)`, err)
    }
  }

  output?.info('\n--- done ---')
  vscode.window.showInformationMessage('Yellowscript: tool report written to the output channel.')
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

  if (entered.trim() === '') {
    // `undefined` removes the key rather than storing "", which would still
    // count as an explicit override and keep discovery switched off.
    await config().update('serverUrl', undefined, vscode.ConfigurationTarget.Workspace)
    vscode.window.setStatusBarMessage('$(search) Yellowscript will discover the Nest automatically', 4000)
    await manager?.connect({})
    return
  }

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
  pushSession()

  // The credential never reaches the log — only the state name and the server.
  const target = 'url' in state && state.url ? ` (${state.url})` : ''
  output?.info(`connection: ${state.status}${target}`)

  // Re-ask on every (re)connect rather than caching: the Nest operator can swap
  // the loaded model without the connection ever dropping.
  if (state.status === 'connected') void refreshModel()
}
