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
import type { HostMessage, SessionSnapshot, ConversationView } from './chat/protocol.ts'
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
  approvalStore,
} from './ui/tool-providers.ts'
import { makeApprovalGate, checkpointForWorkspace } from './ui/write-approval.ts'
import { makeCommandGate } from './ui/run-command.ts'
import { McpHost, type McpTool } from './nest/mcp-host.ts'
import { openMcpSseStream } from './ui/mcp-stream.ts'
import { mergeNestTools, type NestToolRef } from './tools/registry.ts'
import type { Checkpoint, StagedFile } from './tools/checkpoint.ts'
import { conversationStore, type Conversation } from './ui/conversation-store.ts'

const CONFIG_SECTION = 'redstartYellowscript'

let manager: ConnectionManager | undefined
let statusBar: StatusBar | undefined
let output: vscode.LogOutputChannel | undefined
let chatView: ChatViewProvider | undefined
let tools: ToolRegistry | undefined
let mcpHost: McpHost | null = null
let conversations: ReturnType<typeof conversationStore>
let activeConversationId: string | null = null
/** The currently signed-in account username, used to scope conversation history.
 *  Set from `/auth/me` on connect/sign-in; cleared on sign-out/disconnect. */
let currentAccountId: string | null = null
/** One ChatSession per conversation, keyed by conversation id. Tabs own their
 *  own transcript and request lifecycle, so switching tabs is a pure view
 *  change and a running turn keeps streaming in its own tab. */
let sessions = new Map<string, ChatSession>()
/** The merged registry — local ws_* tools + live Nest tools. Rebuilt whenever the
 *  Nest tool set changes (on connect and on re-list). Cached because the agent
 *  loop reads it per turn. */
let mergedTools: ToolRegistry | null = null
/** Last successful write checkpoint per workspace root, for `Revert Last Write`.
 *  Only the most recent is kept — a multistep revert is out of scope for now. */
const lastCheckpoint = new Map<string, { checkpoint: Checkpoint; files: readonly StagedFile[] }>()
/** Resolved once — the binary does not move while the window is open, and
 *  probing the filesystem on every search would be wasteful. */
let ripgrepPath: string | null = null

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Redstart Yellowscript', { log: true })
  statusBar = new StatusBar()
  conversations = conversationStore(context.workspaceState)

  const pruned = conversations.prune(14)
  if (pruned > 0) {
    output.info(`history: pruned ${pruned} conversation(s) older than 14 days`)
  }

  // The panel always has a conversation open, so the first chat is a real tab
  // from the start — not an untracked transcript that vanishes on the first
  // switch. Reuse the oldest existing conversation in a restored workspace;
  // otherwise open a fresh "New chat" that participates in the tab strip.
  const existing = conversations.list(currentAccountId ?? undefined)[0]
  activeConversationId = existing?.id ?? conversations.create('New chat', [], currentAccountId ?? undefined).id

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

  // A session is created lazily per conversation (see getSession). No singleton
  // here — the tab strip is the source of truth for which conversations exist.

  chatView = new ChatViewProvider(context.extensionUri, {
    onSend: (text) => {
      let id = activeConversationId
      // If there is no open tab, create one so the prompt has somewhere to go.
      if (!id) {
        const conv = conversations.create('New chat', [], currentAccountId ?? undefined)
        id = conv.id
        activeConversationId = id
        pushConversations()
        pushActiveConversation()
      }
      const conv = conversations.get(id)
      const finished = getSession(id).send(text)
      pushSession()
      // Auto-title a still-untitled conversation from its first prompt, then
      // keep the tab strip in sync. Title only reads the transcript once the
      // turn (or its queue) is underway.
      void finished?.then(() => {
        if (conv && conv.title === 'New chat') {
          const firstUser = getSession(id).transcript.find((m) => m.role === 'user')
          if (firstUser) {
            conv.title = titleFor(firstUser.content)
            conversations.save(conv)
            pushConversations()
          }
        }
        pushSession()
      })
    },
    onAbort: () => {
      if (activeConversationId) getSession(activeConversationId).abort()
      pushSession()
    },
    onNewConversation: () => {
      const conv = conversations.create('New chat', [], currentAccountId ?? undefined)
      activeConversationId = conv.id
      // Tell the webview which tab is active BEFORE reset emits the empty
      // transcript, otherwise the conversation message is dropped because the
      // webview's activeConversationId hasn't been updated yet.
      pushActiveConversation()
      getSession(conv.id).reset()
      pushConversations()
      pushSession()
    },
    onListConversations: () => {
      chatView?.post({
        type: 'conversationList',
        conversations: toViews(conversations.list(currentAccountId ?? undefined)),
        activeId: activeConversationId,
      })
    },
    onSwitchConversation: (id) => {
      switchConversation(id)
    },
    onCreateConversation: () => {
      const conv = conversations.create('New chat', [], currentAccountId ?? undefined)
      activeConversationId = conv.id
      // A fresh session — no transcript to load, so nothing aborts.
      pushConversations()
      pushActiveConversation()
      // Send the empty transcript so the webview clears the old conversation
      // from the screen. Without this, the previous tab's text lingers until
      // the user switches away and back.
      chatView?.post({ type: 'conversation', conversationId: conv.id, messages: [] })
      pushSession()
    },
    onDeleteConversation: (id) => {
      sessions.get(id)?.abort()
      sessions.delete(id)
      conversations.delete(id)
      if (activeConversationId === id) {
        const remaining = conversations.list(currentAccountId ?? undefined)
        activeConversationId = remaining[0]?.id ?? null
        // Paint the new active conversation's transcript so the webview does
        // not keep showing the conversation that was just closed.
        if (activeConversationId) {
          const session = getSession(activeConversationId)
          chatView?.post({ type: 'conversation', conversationId: activeConversationId, messages: session.snapshot() })
        }
        pushActiveConversation()
        pushSession()
      }
      pushConversations()
    },
    onRunCommand: (command) => {
      void vscode.commands.executeCommand(`redstartYellowscript.${command}`)
    },
    onSignIn: async (message) => {
      if (!manager) return
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
      if (result.status === 'connected') {
        vscode.window.showInformationMessage(describeState(result))
      } else if (result.status === 'unauthenticated' && result.reason === 'rejected') {
        vscode.window.showErrorMessage('Sign-in failed. Check the credentials and try again.')
      } else if (result.status === 'error') {
        vscode.window.showErrorMessage(result.message)
      }
    },
    // Fires on first open AND every time VSCode rebuilds a view it destroyed
    // while hidden — so this must be a complete handoff, not a delta.
    onReady: () => {
      pushConversations()
      pushActiveConversation()
      if (activeConversationId) {
        const conv = conversations.get(activeConversationId)
        const session = getSession(activeConversationId)
        // If the active conversation has a saved transcript and nothing is
        // streaming, seed the session so the panel opens on the right chat.
        if (conv && !session.busy) session.load(conv.messages)
        chatView?.sendInit(snapshot(activeConversationId), session.snapshot(), activeConversationId)
      } else {
        chatView?.sendInit(snapshot(null), [], null)
      }
    },
    onOpenHistory: () => {
      pushHistory()
    },
    onSearchHistory: (query) => {
      const results = currentAccountId
        ? conversations.search(currentAccountId, query)
        : []
      chatView?.post({
        type: 'historyList',
        conversations: results.map((c) => ({
          id: c.id,
          title: c.title,
          lastAccessedAt: c.lastAccessedAt,
          messageCount: c.messages.length,
        })),
      })
    },
    onDeleteHistory: (id) => {
      conversations.delete(id)
      sessions.get(id)?.abort()
      sessions.delete(id)
      if (activeConversationId === id) {
        const remaining = conversations.list(currentAccountId ?? undefined)
        activeConversationId = remaining[0]?.id ?? null
        if (activeConversationId) {
          const session = getSession(activeConversationId)
          chatView?.post({ type: 'conversation', conversationId: activeConversationId, messages: session.snapshot() })
        }
        pushActiveConversation()
        pushSession()
      }
      pushConversations()
      pushHistory()
    },
    onRestoreHistory: (id) => {
      const conv = conversations.get(id)
      if (!conv) return
      activeConversationId = id
      const session = getSession(id)
      session.load(conv.messages)
      pushConversations()
      pushActiveConversation()
      chatView?.post({ type: 'conversation', conversationId: id, messages: session.snapshot() })
      pushSession()
      chatView?.reveal()
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
    vscode.commands.registerCommand('redstartYellowscript.openSettings', openSettingsCommand),
    vscode.commands.registerCommand('redstartYellowscript.inspectTools', inspectToolsCommand),
    vscode.commands.registerCommand('redstartYellowscript.revertLastWrite', revertLastWriteCommand),
  )

  if (config().get<boolean>('autoConnect', true)) {
    // Silent: no scan and no error popup on startup. A user who opens a window
    // with the Nest switched off should see a quiet status bar, not a modal.
    void manager
      .connect({ ...explicitUrl(), noDiscovery: !!explicitUrl().url })
      .catch((err: unknown) => output?.error('Auto-connect failed', err))
  }
}

export function deactivate(): void {
  mcpHost?.stop()
  statusBar?.dispose()
  statusBar = undefined
  // Cancel every conversation's in-flight turn before tearing down.
  for (const session of sessions.values()) session.abort()
  sessions.clear()
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
// Per-conversation sessions
// ---------------------------------------------------------------------------

/**
 * The ChatSession for a conversation, created on demand and cached. Each tab
 * owns its transcript, its AbortController, and its prompt queue, so switching
 * tabs never touches another tab's running turn.
 */
function getSession(id: string): ChatSession {
  let session = sessions.get(id)
  if (!session) {
    session = new ChatSession({
      getClient: () => manager?.activeClient ?? null,
      onUnauthorized: () => manager?.handleUnauthorized(),
      tools: () => (workspaceRoots().length > 0 ? (mergedTools ?? (tools ?? null)) : null),
      toolContext: () => ({ workspaceRoots: workspaceRoots() }),
      approveChange: (pending) => {
        const roots = workspaceRoots()
        if (roots.length === 0) {
          output?.warn('No workspace folder is open, so writes cannot be reviewed or applied.')
          return Promise.resolve(false)
        }
        const gate = makeApprovalGate({
          checkpoints: checkpointForWorkspace(roots[0]!),
          store: approvalStore(),
          recordCheckpoint: (checkpoint, files) => {
            lastCheckpoint.set(roots[0]!, { checkpoint, files })
          },
        })
        return gate(pending)
      },
      approveCommand: (pending) => makeCommandGate()(pending),
      conversationId: id,
      onPersist: () => persistConversation(id),
      emit: (message) => {
        chatView?.post(message)
        if (message.type === 'turn/completed' && message.stats?.tokensPerSecond) {
          statusBar?.setModel(getSession(message.conversationId).currentModel ?? null, message.stats.tokensPerSecond)
        }
        logToolActivity(message)
      },
    })
    sessions.set(id, session)

    // Lazy-load the transcript from the store so background tabs fully restore
    // when clicked. The host already seeded the active tab on init; this covers
    // every other tab the user opens later.
    const conv = conversations.get(id)
    if (conv && conv.messages.length > 0) {
      session.load(conv.messages)
    }
  }
  return session
}

/** Persist a conversation's transcript from its session to the store. */
function persistConversation(id: string): void {
  const session = sessions.get(id)
  const conv = conversations.get(id)
  if (!session || !conv) return
  conv.messages = session.snapshot()
  conversations.save(conv)
}

// ---------------------------------------------------------------------------
// Session snapshot — the projection the webview renders around the transcript
// ---------------------------------------------------------------------------

/** Snapshot for one conversation: `connected` gates sending; `busy` and
 *  `queued` describe that conversation's own turn, not a global one. */
function snapshot(id: string | null): SessionSnapshot {
  const state = manager?.state ?? { status: 'disconnected' as const }
  const connected = state.status === 'connected'
  const session = id ? sessions.get(id) : undefined
  const busy = session?.busy === true
  const queued = session?.queued ?? 0

  const base: SessionSnapshot = {
    connection: state.status,
    detail: describeState(state),
    // Sending only needs a connection — a queued turn is allowed while busy.
    canSend: connected,
    busy,
    queued,
  }
  if ('url' in state && state.url) base.serverUrl = state.url
  const model = session?.currentModel
  if (model) base.model = model
  return base
}

function pushSession(): void {
  chatView?.post({ type: 'session', session: snapshot(activeConversationId) })
}

function pushConversations(): void {
  chatView?.post({ type: 'conversationList', conversations: toViews(conversations.list(currentAccountId ?? undefined)), activeId: activeConversationId })
}

function pushActiveConversation(): void {
  chatView?.post({ type: 'activeConversationChanged', id: activeConversationId })
}

function pushHistory(): void {
  const items = currentAccountId
    ? conversations.list(currentAccountId).map((c) => ({
        id: c.id,
        title: c.title,
        lastAccessedAt: c.lastAccessedAt,
        messageCount: c.messages.length,
      }))
    : []
  chatView?.post({ type: 'historyList', conversations: items })
}

/** Save the active conversation's transcript to the store. Pure bookkeeping
 *  now — it never aborts a turn, because switching tabs doesn't. */
function saveCurrentConversation(): void {
  if (!activeConversationId) return
  persistConversation(activeConversationId)
}

/** Switch the visible tab. A pure view change: the target session is left
 *  exactly as it is (streaming or idle), and we just hand its transcript to the
 *  webview. The previously active session keeps running untouched. */
function switchConversation(id: string): void {
  const conv = conversations.get(id)
  if (!conv || id === activeConversationId) return
  activeConversationId = id
  const session = getSession(id)
  // Send activeConversationChanged FIRST so the webview's activeConversationId
  // is updated before the conversation message arrives. Otherwise the
  // conversation message is dropped (conversationId !== activeConversationId).
  pushActiveConversation()
  chatView?.post({ type: 'conversation', conversationId: id, messages: session.snapshot() })
  pushSession()
}

function toViews(list: Conversation[]): ConversationView[] {
  return list.map((c) => {
    const session = sessions.get(c.id)
    return { id: c.id, title: c.title, busy: session?.busy === true, queued: session?.queued ?? 0 }
  })
}

function titleFor(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, ' ')
  return cleaned.length <= 40 ? cleaned : cleaned.slice(0, 37).trimEnd() + '…'
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
  const conv = conversations.create('New chat', [], currentAccountId ?? undefined)
  activeConversationId = conv.id
  getSession(conv.id).reset()
  pushConversations()
  pushActiveConversation()
  pushSession()
  await chatView?.reveal()
}

async function openSettingsCommand(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', 'redstartYellowscript')
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
  mcpHost?.stop()
  mcpHost = null
  mergedTools = null
  pushTools()
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
      { label: '$(plug) Yellowscript connector key', detail: 'Issue a key bound to this client (shows the Yellowscript identity)', id: 'clientKey' },
    ],
    { title: 'Sign in to Redstart Nest', placeHolder: 'How do you want to authenticate?' },
  )
  if (!method) return

  const result =
    method.id === 'password'
      ? await passwordFlow()
      : method.id === 'apiKey'
        ? await apiKeyFlow()
        : await clientKeyFlow()
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

/**
 * Issue a connector key bound to the `yellowscript` surface.
 *
 * The point of this path is the surface: a key issued here carries `surface:
 * "yellowscript"`, which the Nest gateway reads from the credential (never a
 * header) and uses to inject the Yellowscript identity block into the system
 * context. It requires an already-authenticated account — the key is minted
 * against whoever is signed in — so this is only offered from the sign-in
 * picker, and only meaningful once a session or apiKey credential exists.
 */
async function clientKeyFlow(): Promise<ConnectionState | undefined> {
  const state = manager?.state
  if (
    state?.status !== 'connected' &&
    state?.status !== 'unauthenticated' &&
    state?.status !== 'connecting' &&
    state?.status !== 'error'
  ) {
    vscode.window.showWarningMessage('Connect and sign in to a Redstart Nest first.')
    return undefined
  }

  const url = manager?.urlForSignIn?.()
  if (!url) return undefined

  const client = new NestClient(url)
  // Reuse the existing session/apiKey so the request to issue a key is itself
  // authenticated; signInWithClient re-points the live client at the new key.
  const existing = manager?.activeClient?.getCredential()
  if (existing) client.setCredential(existing)

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Issuing Yellowscript connector key…' },
    () => manager!.signInWithClient(client, 'yellowscript', 'Yellowscript VS Code extension'),
  )

  if (result.status === 'connected') {
    vscode.window.showInformationMessage('Yellowscript connector key issued — the Nest now knows this is Yellowscript.')
  } else if (result.status === 'error') {
    vscode.window.showErrorMessage(result.message)
  } else if (result.status === 'unauthenticated' && result.reason === 'rejected') {
    vscode.window.showErrorMessage('Could not issue a connector key. Sign in with a username/password or API key first.')
  }
  return result
}

async function signOutCommand(): Promise<void> {
  const state = await manager?.signOut()
  currentAccountId = null
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

/**
 * Restore the files from the most recent approved write via the shadow git
 * checkpoint. This is the safety net Phase 3 promised: every write is snapshotted
 * before it touches disk, so a bad edit or a confused model can be undone.
 *
 * Only the LAST checkpoint is tracked (a multi-step undo history is out of
 * scope). If no write has happened this session, or the checkpoint was never
 * created (e.g. git was unavailable), we say so rather than guessing.
 */
async function revertLastWriteCommand(): Promise<void> {
  const roots = workspaceRoots()
  if (roots.length === 0) {
    vscode.window.showWarningMessage('Open a workspace folder before reverting a write.')
    return
  }
  const root = roots[0]!
  const last = lastCheckpoint.get(root)
  if (!last) {
    vscode.window.showInformationMessage('Yellowscript: nothing to revert — no write has been checkpointed yet.')
    return
  }

  const files = last.files.map((f) => f.workspaceAbsolute)
  const choice = await vscode.window.showWarningMessage(
    `Revert the last Yellowscript write? This restores ${files.length} file${files.length === 1 ? '' : 's'} to their pre-write state:`,
    { modal: true, detail: files.join('\n') },
    'Revert',
  )
  if (choice !== 'Revert') return

  try {
    const manager = checkpointForWorkspace(root)
    await manager.revert(last.checkpoint, last.files)
    lastCheckpoint.delete(root)
    vscode.window.showInformationMessage(`Yellowscript: reverted the last write (${files.length} file${files.length === 1 ? '' : 's'}).`)
    output?.info(`revert: restored ${files.length} file(s) from checkpoint ${last.checkpoint.revision.slice(0, 12)}`)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    vscode.window.showErrorMessage(`Could not revert the last write: ${reason}`)
    output?.error('revert failed', err)
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

  if (state.status === 'connected') {
    // Track the signed-in account so conversation history can be scoped to it.
    const user = 'user' in state ? state.user : undefined
    currentAccountId = user?.username ?? null
    output?.info(`account: ${currentAccountId ?? 'unknown'}`)

    void refreshModel()
    void connectMcpHost()
  } else if (state.status === 'disconnected' || state.status === 'unauthenticated') {
    currentAccountId = null
  }
}

/**
 * Bring up the MCP host against the connected Nest. Phase 4.2/4.3: discovers the
 * built-in MCP server via /redstart/mcp-servers, opens the SSE stream, lists
 * tools, and merges them with the local ws_* set under a disjointness assertion.
 *
 * Re-run on every (re)connect — the tool set follows the active profile, so a
 * cached list is stale the moment an operator switches profiles without the
 * connection dropping. On failure the extension still works with just the local
 * ws_* tools — the MCP host is a bonus, not a hard dependency.
 */
function connectMcpHost(): void {
  const client = manager?.activeClient
  if (!client) return

  // Drop any previous session: a reconnect means a new SSE stream and a fresh
  // tool set.
  mcpHost?.stop()
  mcpHost = null
  mergedTools = null
  let currentDisabled = new Set<string>()
  pushTools()
  const host = new McpHost(
    {
      baseUrl: client.baseUrl,
      listMcpServers: (signal) => client.listMcpServers(signal),
      fetch: (input, init) => fetch(input, init),
      getCredential: () => client.getCredential(),
    },
    {
      openStream: (url: string) => openMcpSseStream((input, init) => fetch(input, init), url),
      onTools: (mcpTools: readonly McpTool[]) => {
        const refs: NestToolRef[] = mcpTools
          .filter((t) => !currentDisabled.has(t.name))
          .map((t) => {
            const ref: NestToolRef = {
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              execute: (args: unknown) => host.callTool(t.name, args),
            }
            if (t.meta) ref.meta = t.meta
            return ref
          })
        const base = tools ?? mergedTools
        if (!base) {
          output?.warn('mcp: local tools not ready, dropping Nest tools')
          return
        }
        try {
          mergedTools = mergeNestTools(base, refs)
          output?.info(
            `mcp: merged ${refs.length} Nest tools with ${base.names.length} local ws_* tools`,
          )
          pushTools()
        } catch (err) {
          output?.error(`mcp: merge rejected — ${(err as Error).message}`)
        }
      },
      onConnection: (conn) => {
        output?.info(
          `mcp: connected to ${conn.servers[0]?.name ?? 'unknown'} (${conn.servers.length} server(s))`,
        )
        // Track server-banned tool names for UX greying (HANDOFF 4.4). The
        // gateway also strips them server-side — this is the visibility layer.
        currentDisabled = new Set(conn.disabledTools)
      },
      onError: (err) => {
        output?.error(`mcp: ${err.message}`)
        // A dead MCP host should not brick the extension — clear the merged set
        // so the model sees only local tools, and let the next reconnect retry.
        mergedTools = null
        pushTools()
      },
    },
  )

  mcpHost = host
  void host.connect().catch((err: unknown) => {
    output?.error('mcp: connect failed', err)
  })
}

/** Push the current tool set to the webview so the picker and cards reflect it. */
function pushTools(): void {
  const current = mergedTools ?? tools
  if (!current) return
  chatView?.post({ type: 'tools', names: current.names })
}
