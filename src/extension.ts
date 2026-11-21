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
import { hostname, tmpdir } from 'node:os'

import { ConnectionManager, describeState, type ConnectionState } from './connection.ts'
import {
  discoverNests,
  localAddresses,
  localSubnets,
  type DiscoveredNest,
} from './nest/discovery.ts'
import { ChatSession } from './chat/session.ts'
import { findBrowser } from './tools/browser-check.ts'
import { buildWorkspaceContext } from './tools/workspace-context.ts'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import { PLAN_DIR, PLAN_FILE, formatPlanFile, hasOpenSteps, parsePlanFile } from './chat/plan-file.ts'
import type { PlanStep } from './agent/agent-core.ts'
import { ContextTracker } from './agent/context-budget.ts'
import { DEFAULT_MAX_ITERATIONS } from './agent/loop.ts'
import {
  EMPTY_CONVERSATION_STATE,
  type ConversationView,
  type HostMessage,
  type PageName,
  type ProjectView,
  type SessionSnapshot,
  type WorkflowView,
  tabLabel,
} from './chat/protocol.ts'
import { NestClient, normalizeBaseUrl, type NestProject } from './nest/client.ts'
import { SecretCredentialStore, WorkspaceStateStore } from './storage.ts'
import { StatusBar } from './ui/status-bar.ts'
import { ChatViewProvider, type Surface } from './ui/chat-view.ts'
import { createToolRegistry, type ToolRegistry } from './tools/registry.ts'
import {
  diagnosticsAfterWrite,
  diagnosticsProvider,
  symbolProvider,
  editorStateProvider,
  resolveRipgrep,
  workspaceRoots,
  approvalStore,
} from './ui/tool-providers.ts'
import { makeApprovalGate, checkpointForWorkspace, shadowKey } from './ui/write-approval.ts'
import { fileBaseline, revertSteps } from './chat/run-log.ts'
import type { PendingCommand, ToolEffect } from './tools/types.ts'
import { classifyCommand, type CommandContext } from './tools/safe-commands.ts'
import { nodeCommandContext } from './tools/command-context.ts'
import { usableReadRoots } from './tools/read-scope.ts'
import { AttentionTracker, LONG_RUN_MS } from './chat/attention.ts'
import { MAX_FILE_LINES, attachmentLabel } from './chat/attachments.ts'
import { formatOutline, outlineOf } from './tools/symbols.ts'
import { secretReason } from './tools/protected-paths.ts'
import { resolveWithinWorkspace } from './tools/workspace-path.ts'
import type { AttachmentView } from './chat/protocol.ts'
import { makeCommandGate } from './ui/run-command.ts'
import { BackgroundProcesses, describeRunning } from './tools/process-runner.ts'
import { McpHost, withProjectMeta, type McpTool } from './nest/mcp-host.ts'
import { approvalInfo, callWithApproval } from './nest/approval.ts'
import { makeNestApprovalDeps, promptInChat } from './ui/nest-approval.ts'
import { AUTH_PROVIDER_ID, RedstartAuthProvider } from './ui/auth-provider.ts'
import { mergeNestTools, type NestToolRef } from './tools/registry.ts'
import type { Checkpoint, StagedFile } from './tools/checkpoint.ts'
import { conversationStore, isBlank, type Conversation, type HistoryEntry } from './ui/conversation-store.ts'

const CONFIG_SECTION = 'redstartYellowscript'

let manager: ConnectionManager | undefined
let statusBar: StatusBar | undefined
let output: vscode.LogOutputChannel | undefined
let chatView: ChatViewProvider | undefined
let tools: ToolRegistry | undefined
let mcpHost: McpHost | null = null
let conversations: ReturnType<typeof conversationStore>
/** A conversation the sidebar should open on once VSCode creates its view
 *  (a command ran before the view existed). */
let pendingSidebarConversation: string | null = null
/** The currently signed-in account username, used to scope conversation history.
 *  Set from `/auth/me` on connect/sign-in; cleared on sign-out/disconnect. */
let currentAccountId: string | null = null
/** Where the workspace's project link is kept (per workspace, like the tabs). */
let workspaceMemento: vscode.Memento | undefined
/** The account's workflows, from the last prompts/list. */
let workflowCache: WorkflowView[] = []
/** One ChatSession per conversation, keyed by conversation id. Tabs own their
 *  own transcript and request lifecycle, so switching tabs is a pure view
 *  change and a running turn keeps streaming in its own tab. */
let sessions = new Map<string, ChatSession>()
/** The merged registry — local ys_* tools + live Nest tools. Rebuilt whenever the
 *  Nest tool set changes (on connect and on re-list). Cached because the agent
 *  loop reads it per turn. */
let mergedTools: ToolRegistry | null = null
/** Last successful write checkpoint per workspace root, for `Revert Last Write`.
 *  Only the most recent is kept — a multistep revert is out of scope for now. */
const lastCheckpoint = new Map<string, { checkpoint: Checkpoint; files: readonly StagedFile[] }>()

/** Per conversation: the running task's trust, and every write it checkpointed. */
interface TaskState {
  trusted: boolean
  checkpoints: Array<{ root: string; checkpoint: Checkpoint; files: readonly StagedFile[] }>
}
const tasks = new Map<string, TaskState>()
/** The conversation whose task wrote last, for Revert Last Task. */
let lastTaskConversation: string | null = null
function taskFor(conversationId: string): TaskState {
  let task = tasks.get(conversationId)
  if (!task) {
    task = { trusted: false, checkpoints: [] }
    tasks.set(conversationId, task)
  }
  return task
}
/** Resolved once — the binary does not move while the window is open, and
 *  probing the filesystem on every search would be wasteful. */
let ripgrepPath: string | null = null
/** Live output of approved commands, and the background processes they started. */
let commandChannel: vscode.OutputChannel | undefined
let backgroundProcesses: BackgroundProcesses | undefined

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Redstart Yellowscript', { log: true })
  commandChannel = vscode.window.createOutputChannel('Yellowscript Commands')
  backgroundProcesses = new BackgroundProcesses((id, chunk) => commandChannel?.append(`[${id}] ${chunk}`))
  context.subscriptions.push(commandChannel, { dispose: () => void backgroundProcesses?.stopAll() })
  statusBar = new StatusBar()
  conversations = conversationStore(context.workspaceState)
  workspaceMemento = context.workspaceState

  const pruned = conversations.prune(14)
  if (pruned > 0) {
    output.info(`history: pruned ${pruned} conversation(s) older than 14 days`)
  }
  // Closed chats that never had anything in them, left over from before
  // closing a blank chat deleted it.
  const blank = conversations.pruneBlank()
  if (blank > 0) output.info(`history: removed ${blank} empty conversation(s)`)

  // Which conversation each view shows is decided when that view announces
  // itself (onReady): the sidebar and every editor tab each have their own.

  manager = new ConnectionManager({
    credentials: new SecretCredentialStore(context.secrets),
    state: new WorkspaceStateStore(context.workspaceState),
    createClient: (baseUrl) => new NestClient(baseUrl),
    discover: loggedDiscovery(),
    // A password sign-in becomes a key Nest issues to this app, named for this
    // machine so it is recognisable in the chat app's list of app keys.
    appKey: { surface: 'yellowscript', label: `Yellowscript on ${hostname()}` },
  })
  const authProvider = new RedstartAuthProvider(manager, {
    signIn: async () => {
      // Sign-in happens in the panel; the Accounts menu just opens it there.
      if (manager?.state.status === 'disconnected' || manager?.state.status === 'error') await manager.connect()
      await chatView?.reveal()
    },
    signOut: () => signOutCommand(),
  })

  // The ys_* tools. Built at activation so a missing ripgrep is a known,
  // reportable state rather than a surprise on the first search — the search
  // tools drop to literal matching and say so in the description the model
  // plans against. Nothing sends these to the Nest yet; that is 2.3.
  ripgrepPath = resolveRipgrep()
  tools = createToolRegistry({
    ripgrepPath,
    diagnostics: diagnosticsProvider,
    symbols: symbolProvider,
    editorState: editorStateProvider,
    processes: backgroundProcesses,
    unifiedDiff: vscode.workspace.getConfiguration('redstartYellowscript').get<boolean>('tools.unifiedDiff') === true,
    browser: {
      // Looked up on use, so a browser installed later is found.
      browser: () => findBrowser(),
      screenshotDir: () => {
        const root = workspaceRoots()[0]
        return root ? nodePath.join(root, PLAN_DIR, 'screenshots') : null
      },
    },
  })
  const roots = workspaceRoots()
  output.info(
    `tools: ${tools.names.length} registered (${tools.names.join(', ')}); ` +
      `search backend: ${ripgrepPath === null ? 'DEGRADED — ripgrep not found' : 'ripgrep'}; ` +
      `workspace folders: ${roots.length}`,
  )
  if (roots.length === 0) {
    // Worth stating plainly. With no folder open every ys_* tool refuses by
    // design, and that reads as a broken extension unless it is spelled out.
    output.warn('No workspace folder is open — every ys_* tool will refuse until one is.')
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
    onSend: (from, text, attachments) => {
      void resolveAttachments(from, attachments ?? []).then((resolved) => sendTo(from, text, undefined, resolved))
    },
    onSearchFiles: (from, query) => {
      void searchWorkspaceFiles(query).then((paths) => chatView?.postTo(from, { type: 'fileMatches', query, paths }))
    },
    onAbort: (from) => {
      if (from.conversationId) getSession(from.conversationId).abort()
      pushSession()
    },
    onNewConversation: (from) => {
      // An editor tab is one chat: a new one gets a tab of its own, like any
      // other editor. The sidebar keeps a strip of them.
      if (from.kind === 'editor') openChatInEditor(createConversation().id)
      else showIn(from, createConversation().id)
    },
    onListConversations: () => pushConversations(),
    onSwitchConversation: (from, id) => {
      const editor = chatView?.editorFor(id)
      if (editor && editor !== from) void chatView?.reveal(editor)
      else showIn(from, id)
    },
    onDeleteConversation: (_from, id) => closeConversation(id),
    onSaveDraft: (id, text) => {
      conversations.setDraft(id, text)
    },
    onRunCommand: (command) => {
      void vscode.commands.executeCommand(`redstartYellowscript.${command}`)
    },
    onMoveToSidebar: (from) => moveEditorChatToSidebar(from),
    onMoveToEditor: (id) => openChatInEditor(id),
    onSetServerUrl: (url) => {
      void applyServerUrl(url)
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
    onReady: (from, restoredId) => {
      if (from.kind === 'editor') {
        // The chat this tab was opened on, or showed before a reload. Gone
        // (deleted meanwhile) means a fresh chat rather than an empty tab.
        let id = from.conversationId ?? restoredId ?? null
        const conv = id ? conversations.get(id) : undefined
        if (!conv) id = createConversation().id
        else if (conv.archived) conversations.unarchive(conv.id)
        from.conversationId = id
        // A chat lives in one place. The sidebar may have picked it up while
        // this tab was still being restored.
        const sidebar = chatView?.sidebar()
        if (sidebar && sidebar.conversationId === id) showIn(sidebar, pickSidebarConversation(null))
      } else {
        from.conversationId = pickSidebarConversation(pendingSidebarConversation ?? restoredId ?? from.conversationId)
        pendingSidebarConversation = null
      }
      const id = from.conversationId!
      const conv = conversations.get(id)
      const session = getSession(id)
      // A saved transcript and nothing streaming: seed the session so the
      // view opens on the right chat.
      if (conv && !session.busy) session.load(conv.messages, conv.plan ?? null, conv.inFlight ?? null)
      chatView?.sendInit(from, snapshot(id), session.snapshot(), session.state())
      pushConversations()
    },
    onOpenHistory: (from) => pushHistoryPanel(from),
    onOpenPage: (from, page) => {
      if (page === 'projects') void pushProjects(from)
      else void pushWorkflows(from)
    },
    onLinkProject: (from, id) => {
      void linkProject(from, id)
    },
    onCreateProject: (from, name) => {
      void createProjectFromPanel(from, name)
    },
    onRunWorkflow: (from, name, args) => {
      void runWorkflow(from, name, args)
    },
    onAnswer: (from, id, answer) => {
      if (from.conversationId) getSession(from.conversationId).answer(id, answer)
    },
    onApprove: (from, id, choice) => {
      if (from.conversationId) getSession(from.conversationId).approve(id, choice)
    },
    onOpenApprovalDiff: (from, id, index) => {
      if (from.conversationId) getSession(from.conversationId).openApprovalFile(id, index)
    },
    onClearPlan: (from) => {
      if (from.conversationId) getSession(from.conversationId).clearPlan()
    },
    onContinueAtLimit: (from, go) => {
      if (from.conversationId) getSession(from.conversationId).continueAtLimit(go)
    },
    onResumeTask: (from, restart) => {
      if (!from.conversationId) return
      const session = getSession(from.conversationId)
      // Clicking "Restart and continue" is the person's go-ahead for them.
      const resumed = session.resumeInterrupted()
      if (!resumed) return
      if (restart && backgroundProcesses) {
        for (const p of resumed.processes) {
          try {
            const started = backgroundProcesses.start(p.command, p.cwd)
            commandChannel?.appendLine(`\n$ ${p.command}    (restarted for an interrupted task as ${started.id})`)
          } catch (err) {
            output?.warn(`could not restart ${p.command}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
      void resumed.sent
    },
    onDismissInterrupted: (from) => {
      if (from.conversationId) getSession(from.conversationId).dismissInterrupted()
    },
    onOpenTaskDiff: (from, turnId, file) => {
      if (from.conversationId) void openTaskDiff(getSession(from.conversationId).runOf(turnId) ?? [], file)
    },
    onRevertTask: (from, turnId) => {
      if (from.conversationId) void revertTask(getSession(from.conversationId).runOf(turnId) ?? [])
    },
    onSearchHistory: (from, query) => {
      const all = historyItems()
      const q = query.trim().toLowerCase()
      const filtered = q ? all.filter((c) => c.title.toLowerCase().includes(q)) : all
      chatView?.postTo(from, { type: 'historyList', conversations: filtered })
    },
    onDeleteHistory: (from, id) => {
      // Permanent, open or not; the history panel has the person confirm
      // first, and says so when the chat is open or still running.
      sessions.get(id)?.abort()
      sessions.delete(id)
      conversations.delete(id)
      vacate(id)
      pushConversations()
      refreshHistory(from)
    },
    onRestoreHistory: (from, id) => {
      const conv = conversations.get(id)
      if (!conv) return
      // Already open somewhere: go there instead of opening it twice.
      const shownIn = chatView?.surfaces().find((s) => s.conversationId === id)
      if (shownIn) {
        void chatView?.reveal(shownIn)
        return
      }
      conversations.unarchive(id)
      if (from.kind === 'editor') openChatInEditor(id)
      else showIn(from, id)
    },
    onSurfaceClosed: (surface) => {
      const id = surface.conversationId
      if (!id) return
      // A run still going is not thrown away with its tab: it carries on in
      // the sidebar's strip, where it can be found.
      if (sessions.get(id)?.busy) {
        pushConversations()
        return
      }
      retire(id)
      pushConversations()
    },
  })
  context.subscriptions.push(
    output,
    statusBar,
    manager.onDidChangeState(onStateChanged),
    // The Redstart account in VS Code's Accounts menu.
    authProvider,
    vscode.authentication.registerAuthenticationProvider(AUTH_PROVIDER_ID, 'Redstart', authProvider, {
      supportsMultipleAccounts: false,
    }),
    // Chats opened as editor tabs, restored on their chat after a window reload.
    vscode.window.registerWebviewPanelSerializer(ChatViewProvider.panelType, chatView),
    vscode.commands.registerCommand('redstartYellowscript.openInEditor', () => openChatInEditor(createConversation().id)),
    vscode.commands.registerCommand('redstartYellowscript.moveToEditor', moveSidebarChatToEditor),
    vscode.commands.registerCommand('redstartYellowscript.moveToSidebar', () => moveEditorChatToSidebar(chatView?.activeEditor())),
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
    vscode.commands.registerCommand('redstartYellowscript.openHistory', openHistoryCommand),
    vscode.commands.registerCommand('redstartYellowscript.chooseProject', () => showPage('projects')),
    vscode.commands.registerCommand('redstartYellowscript.runWorkflow', () => showPage('workflows')),
    vscode.commands.registerCommand('redstartYellowscript.inspectTools', inspectToolsCommand),
    vscode.commands.registerCommand('redstartYellowscript.revertLastWrite', revertLastWriteCommand),
    vscode.commands.registerCommand('redstartYellowscript.revertLastTask', revertLastTaskCommand),
    vscode.commands.registerCommand('redstartYellowscript.addSelection', addSelectionToChat),
    vscode.commands.registerCommand('redstartYellowscript.fixDiagnostic', fixDiagnostic),
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      {
        provideCodeActions: (document, _range, context) =>
          context.diagnostics
            .filter((d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
            .slice(0, 1)
            .map((d) => {
              const action = new vscode.CodeAction('Fix with Yellowscript', vscode.CodeActionKind.QuickFix)
              action.command = { command: 'redstartYellowscript.fixDiagnostic', title: 'Fix with Yellowscript', arguments: [document.uri, d] }
              action.diagnostics = [d]
              return action
            }),
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    vscode.commands.registerCommand('redstartYellowscript.showWaiting', () => {
      const id = attention.firstWaiting()
      return id ? showConversation(id) : chatView?.reveal()
    }),
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
  // A dev server the model started must not outlive the window.
  backgroundProcesses?.stopAll()
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
/**
 * One context tracker per connected client: n_ctx is read from the Nest once
 * (llama-server's /props), and the gateway's overhead is learned from replies.
 * Keyed weakly, so a reconnect (a new client) starts fresh.
 */
const contextTrackers = new WeakMap<NestClient, ContextTracker>()
function contextFor(client: NestClient | null): ContextTracker | null {
  if (!client) return null
  let tracker = contextTrackers.get(client)
  if (!tracker) {
    tracker = new ContextTracker(client)
    contextTrackers.set(client, tracker)
    void tracker.ready().then(() => {
      // Now known whether the model reads images: the composer says so.
      pushSession()
      output?.info(`context: n_ctx ${tracker!.contextSize ?? 'unknown (learned from the first refusal)'}`)
    })
  }
  return tracker
}

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
      context: () => contextFor(manager?.activeClient ?? null),
      diagnosticsAfterWrite,
      onPlanChanged: (steps) => writeWorkspacePlan(steps),
      workspaceContext: () => {
        const root = workspaceRoots()[0]
        if (!root) return null
        // What it is told about keeping notes, plans and memories follows the
        // tools it actually has, and whether the workspace has a project.
        const registry = mergedTools ?? tools
        return buildWorkspaceContext(root, undefined, {
          ...(registry ? { tools: registry.names } : {}),
          project: linkedProject()?.name ?? null,
        })
      },
      liveState: () => (backgroundProcesses ? describeRunning(backgroundProcesses.list()) : null),
      maxTurns: () => config().get<number>('agent.maxTurns') ?? DEFAULT_MAX_ITERATIONS,
      onContextTrimmed: (report) => {
        output?.info(
          `context: trimmed to fit (~${report.before} → ~${report.after} of ${report.usable ?? '?'} usable tokens; ` +
            `${report.stubbed} old results stubbed, ${report.shrunk} calls shrunk, ${report.capped} messages capped)` +
            (report.overLimit ? '  [STILL OVER the window]' : ''),
        )
      },
      onUnauthorized: () => manager?.handleUnauthorized(),
      tools: () => (workspaceRoots().length > 0 ? (mergedTools ?? (tools ?? null)) : null),
      toolContext: () => ({
        workspaceRoots: workspaceRoots(),
        readRoots: extraReadRoots(),
        askRead: async (request) => {
          const outside = request.outsideFolder
          const choice = await getSession(id).askApproval({
            kind: 'tool',
            title: outside ? 'Read outside the workspace' : 'Read a file that may hold secrets',
            subject: request.label,
            detail: outside
              ? `It is outside the workspace. Reading only; nothing there is ever written. "Always" allows reading ${outside}.`
              : `${request.reason}. What it says goes to the model and is saved with this chat.`,
            options: [
              { id: 'read', label: 'Allow this time', kind: 'allow' },
              ...(outside ? [{ id: 'always', label: 'Always for this folder', kind: 'always' as const }] : []),
              { id: 'deny', label: 'Deny', kind: 'deny' },
            ],
          })
          if (choice === 'always' && outside) {
            await config().update('extraReadRoots', [...new Set([...extraReadRoots(), outside])], vscode.ConfigurationTarget.Workspace)
          }
          return choice === 'read' || choice === 'always'
        },
      }),
      approveChange: (pending) => {
        const roots = workspaceRoots()
        if (roots.length === 0) {
          output?.warn('No workspace folder is open, so writes cannot be reviewed or applied.')
          return Promise.resolve(false)
        }
        const gate = makeApprovalGate({
          ask: (request) => getSession(id).askApproval(request),
          checkpoints: checkpointForWorkspace(roots[0]!),
          root: roots[0]!,
          store: approvalStore(),
          recordCheckpoint: (checkpoint, files) => {
            lastCheckpoint.set(roots[0]!, { checkpoint, files })
            taskFor(id).checkpoints.push({ root: roots[0]!, checkpoint, files })
            lastTaskConversation = id
          },
          task: {
            trusted: () => taskFor(id).trusted,
            trust: () => {
              taskFor(id).trusted = true
            },
          },
        })
        return gate(pending)
      },
      approveCommand: (pending) =>
        backgroundProcesses && commandChannel
          ? makeCommandGate({
              channel: commandChannel,
              processes: backgroundProcesses,
              ask: (request) => getSession(id).askApproval(request),
              classify: (command) => classifyCommand(command.command, commandContextFor(id, command)),
              conversationId: id,
              nonInteractive: () => config().get<boolean>('commands.nonInteractive') !== false,
            })(pending)
          : Promise.resolve(null),
      conversationId: id,
      projectId: () => linkedProject()?.id ?? null,
      onPersist: () => persistConversation(id),
      emit: (message) => {
        // A task is one user message's run: it starts when that message runs
        // (not when it queues) and ends with the turn. "Apply all in this
        // task" lasts until then; its checkpoints stay for Revert Last Task.
        if (message.type === 'message' && message.message.role === 'user' && !message.message.pending) {
          tasks.set(id, { trusted: false, checkpoints: [] })
          attention.runStarted(id)
        } else if (message.type === 'turn/completed' || message.type === 'turn/failed') {
          taskFor(id).trusted = false
          const took = attention.runEnded(id)
          if (took !== null && took > LONG_RUN_MS) notifyUnwatched(id, `finished after ${Math.round(took / 60_000)} min`)
        } else if (message.type === 'conversationState') {
          const news = attention.update(id, message.state)
          statusBar?.setWaiting(attention.count)
          if (news) notifyUnwatched(id, `is waiting for ${news}`)
        }
        // Only the views showing this chat; the others are on their own.
        chatView?.postToConversation(id, message)
        // The tab strip's busy dots and an editor tab's title follow the run.
        if (
          (message.type === 'message' && message.message.role === 'user' && !message.message.pending) ||
          message.type === 'turn/completed' ||
          message.type === 'turn/failed'
        ) {
          pushConversations()
        }
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
    if (conv && (conv.messages.length > 0 || conv.plan)) {
      session.load(conv.messages, conv.plan ?? null, conv.inFlight ?? null)
    } else {
      // A fresh conversation carries on the workspace's plan while steps are
      // open (.yellowscript/PLAN.md, kept by onPlanChanged).
      const carried = readWorkspacePlan()
      if (carried) {
        session.load([], carried)
        output?.info(`plan: carried ${carried.length} step(s) from ${PLAN_DIR}/${PLAN_FILE} into a new conversation`)
      }
    }
  }
  return session
}

/**
 * Send to the conversation on a surface (opening one if it has none), and
 * title a new chat from its first prompt, or from the workflow it ran.
 */
function sendTo(surface: Surface, text: string, workflow?: { name: string; title: string }, attachments?: AttachmentView[]): void {
  if (!surface.conversationId) showIn(surface, createConversation().id)
  const conversationId = surface.conversationId!
  // Sent, so no longer a draft. Cleared here rather than trusting the
  // webview's follow-up, which could land after a save below.
  conversations.setDraft(conversationId, '')
  // Title a still-untitled chat now, from what was sent. Waiting for the run
  // to finish left a long run as one more "New chat" tab for its whole length,
  // indistinguishable from the empty ones around it.
  const conv = conversations.get(conversationId)
  if (conv && conv.title === 'New chat') {
    const label = workflow ? workflow.title : text.trim() || (attachments?.[0] ? attachmentLabel(attachments[0]) : '')
    if (label) {
      conv.title = titleFor(label)
      conversations.save(conv)
    }
  }
  const finished = getSession(conversationId).send(text, workflow, attachments)
  pushConversations()
  pushSession()
  void finished.then(() => {
    pushConversations()
    pushSession()
  })
}

/** Persist a conversation's transcript from its session to the store. */
function persistConversation(id: string): void {
  const session = sessions.get(id)
  const conv = conversations.get(id)
  if (!session || !conv) return
  conv.messages = session.snapshot()
  const plan = session.planSnapshot()
  if (plan) conv.plan = plan
  else delete conv.plan
  const inFlight = session.inFlightSnapshot()
  if (inFlight) conv.inFlight = inFlight
  else delete conv.inFlight
  conversations.save(conv)
}

/** Paint a surface's conversation: its transcript and what sits around it. */
function postConversation(surface: Surface): void {
  const id = surface.conversationId
  if (!id) return
  const session = getSession(id)
  chatView?.postTo(surface, { type: 'conversation', conversationId: id, messages: session.snapshot(), state: session.state() })
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
  const project = connected ? linkedProject() : null
  if (project) base.project = { id: project.id, name: project.name }
  const tracker = connected ? contextFor(manager?.activeClient ?? null) : null
  if (tracker) base.vision = tracker.vision
  const configured = config().get<string>('serverUrl', '').trim()
  if (configured) base.configuredUrl = configured
  return base
}

// ---------------------------------------------------------------------------
// Projects — this workspace's link to a Nest project
// ---------------------------------------------------------------------------
// Conversations stay in the workspace; the PROJECT is what is shared with the
// other Redstart apps: its instructions and memories reach the model because
// every request names it (`redstart_project`), and Nest checks the caller may
// read it. The link is kept per workspace and is only valid for the server and
// account it was made with: another Nest, or another account, starts unlinked.

const PROJECT_LINK_KEY = 'redstartYellowscript.projectLink'

interface ProjectLink {
  server: string
  account: string
  id: string
  name: string
}

function linkScope(): { server: string; account: string } | null {
  const state = manager?.state
  if (!state || state.status !== 'connected' || !('url' in state) || !state.url) return null
  return { server: state.url, account: currentAccountId ?? '' }
}

function linkedProject(): ProjectLink | null {
  const scope = linkScope()
  const link = workspaceMemento?.get<ProjectLink>(PROJECT_LINK_KEY)
  if (!scope || !link) return null
  return link.server === scope.server && link.account === scope.account ? link : null
}

async function pushProjects(to: Surface): Promise<void> {
  const client = manager?.activeClient
  const linkedId = linkedProject()?.id ?? null
  chatView?.postTo(to, { type: 'projects', projects: null, linkedId })
  if (!client) {
    chatView?.postTo(to, { type: 'projects', projects: [], linkedId, error: 'Not connected to a Nest.' })
    return
  }
  try {
    const { projects } = await client.listProjects()
    // A linked project that is gone (deleted in the chat app) is unlinked
    // here, so the panel does not claim a project the requests no longer get.
    if (linkedId && !projects.some((p) => p.id === linkedId)) {
      await workspaceMemento?.update(PROJECT_LINK_KEY, undefined)
      pushSession()
    }
    chatView?.postTo(to, {
      type: 'projects',
      projects: projects.map(toProjectView),
      linkedId: linkedProject()?.id ?? null,
    })
  } catch (err) {
    chatView?.postTo(to, { type: 'projects', projects: [], linkedId, error: describeError(err, 'Could not load projects') })
  }
}

function toProjectView(p: NestProject): ProjectView {
  const view: ProjectView = { id: p.id, name: p.name }
  const instructions = p.instructions?.trim()
  if (instructions) view.instructions = instructions.length > 160 ? `${instructions.slice(0, 159)}…` : instructions
  if (p.folder) view.folder = p.folder
  return view
}

async function linkProject(from: Surface, id: string | null): Promise<void> {
  const scope = linkScope()
  if (!scope) return
  if (id === null) {
    await workspaceMemento?.update(PROJECT_LINK_KEY, undefined)
  } else {
    const client = manager?.activeClient
    const project = client ? (await client.listProjects().catch(() => ({ projects: [] as NestProject[] }))).projects.find((p) => p.id === id) : undefined
    if (!project) {
      chatView?.postTo(from, { type: 'notice', level: 'error', message: 'That project is no longer on the Nest.' })
      return
    }
    const link: ProjectLink = { ...scope, id: project.id, name: project.name }
    await workspaceMemento?.update(PROJECT_LINK_KEY, link)
  }
  pushSession()
  await pushProjects(from)
}

async function createProjectFromPanel(from: Surface, name: string): Promise<void> {
  const client = manager?.activeClient
  if (!client) return
  try {
    const project = await client.createProject(name)
    await linkProject(from, project.id)
  } catch (err) {
    chatView?.postTo(from, { type: 'notice', level: 'error', message: describeError(err, 'Could not create the project') })
    await pushProjects(from)
  }
}

// ---------------------------------------------------------------------------
// Workflows — the account's saved instructions, run from `/` or the page
// ---------------------------------------------------------------------------

async function pushWorkflows(to: Surface): Promise<void> {
  if (!mcpHost) {
    chatView?.postTo(to, { type: 'workflows', workflows: [], error: 'Workflows need the Nest connection. Try reconnecting.' })
    return
  }
  try {
    workflowCache = (await mcpHost.listPrompts()).map((p) => ({ ...p, arguments: p.arguments.map((a) => ({ ...a })) }))
    chatView?.postTo(to, { type: 'workflows', workflows: workflowCache })
  } catch (err) {
    chatView?.postTo(to, { type: 'workflows', workflows: [], error: describeError(err, 'Could not load workflows') })
  }
}

async function runWorkflow(from: Surface, name: string, args: Record<string, string>): Promise<void> {
  if (!mcpHost) return
  try {
    // Nest composes the text from its own copy of the workflow.
    const text = await mcpHost.getPrompt(name, args)
    const title = workflowCache.find((w) => w.name === name)?.title ?? name
    sendTo(from, text, { name, title })
  } catch (err) {
    chatView?.postTo(from, { type: 'notice', level: 'error', message: describeError(err, `Could not run the workflow "${name}"`) })
  }
}

function describeError(err: unknown, lead: string): string {
  return `${lead}: ${err instanceof Error ? err.message : String(err)}`
}

// ---------------------------------------------------------------------------
// Surfaces — the sidebar and the editor tabs, each on its own conversation
// ---------------------------------------------------------------------------
// A chat lives in one place at a time. An editor tab is one chat (VSCode's own
// tabs, movable between groups and windows); the sidebar has a strip of every
// other open chat. Switching in one never moves another.

/** Each view's snapshot: busy, queued and model are its own chat's. */
function pushSession(): void {
  for (const surface of chatView?.surfaces() ?? []) {
    chatView?.postTo(surface, { type: 'session', session: snapshot(surface.conversationId) })
  }
}

/** The sidebar's tab strip: open chats of this account not in an editor tab. */
function sidebarConversations(): Conversation[] {
  return conversations.list(currentAccountId ?? undefined).filter((c) => !chatView?.editorFor(c.id))
}

/** Each view's tab list, and every editor tab's title. */
function pushConversations(): void {
  for (const surface of chatView?.surfaces() ?? []) {
    if (surface.kind === 'sidebar') {
      chatView?.postTo(surface, { type: 'conversationList', conversations: toViews(sidebarConversations()), activeId: surface.conversationId })
      continue
    }
    const own = surface.conversationId ? conversations.get(surface.conversationId) : undefined
    chatView?.postTo(surface, { type: 'conversationList', conversations: own ? toViews([own]) : [], activeId: surface.conversationId })
    if (own) chatView?.setTitle(surface, editorTitle(own))
  }
}

/** An editor tab is named for its chat, so a row of them can be told apart. */
function editorTitle(conv: Conversation): string {
  return tabLabel(conv.title)
}

function createConversation(): Conversation {
  return conversations.create('New chat', [], currentAccountId ?? undefined)
}

/**
 * The chat the sidebar should show: `preferred` when it is open, this
 * account's and not in an editor tab; else the first of the strip; else a new one.
 */
function pickSidebarConversation(preferred: string | null | undefined): string {
  const candidates = sidebarConversations()
  if (preferred) {
    const conv = conversations.get(preferred)
    if (conv && !chatView?.editorFor(preferred) && (!currentAccountId || !conv.accountId || conv.accountId === currentAccountId)) {
      if (conv.archived) conversations.unarchive(preferred)
      return preferred
    }
  }
  return candidates[0]?.id ?? createConversation().id
}

/** Put a conversation on a surface. A pure view change: whatever it is doing
 *  (streaming, waiting on a question) carries on untouched. */
function showIn(surface: Surface, id: string): void {
  surface.conversationId = id
  // activeConversationChanged FIRST so the webview takes the transcript that
  // follows (it drops one for any chat other than its own).
  chatView?.postTo(surface, { type: 'activeConversationChanged', id })
  postConversation(surface)
  chatView?.postTo(surface, { type: 'session', session: snapshot(id) })
  pushConversations()
}

/** A chat in a new editor tab, or the tab it is already in. */
function openChatInEditor(id: string): void {
  const existing = chatView?.editorFor(id)
  if (existing) {
    void chatView?.reveal(existing)
    return
  }
  const conv = conversations.get(id)
  if (!conv || !chatView) return
  if (conv.archived) conversations.unarchive(id)
  // Off the sidebar first, so it is never on screen in two places.
  const sidebar = chatView.sidebar()
  chatView.openEditor(id, editorTitle(conv))
  if (sidebar && sidebar.conversationId === id) showIn(sidebar, pickSidebarConversation(null))
  pushConversations()
}

/** The sidebar's chat, moved to an editor tab of its own. */
function moveSidebarChatToEditor(): void {
  const sidebar = chatView?.sidebar()
  openChatInEditor(sidebar?.conversationId ?? createConversation().id)
}

/** An editor tab's chat, moved back into the sidebar's strip. The tab closes
 *  without that counting as closing the chat: a run carries on. */
function moveEditorChatToSidebar(surface: Surface | undefined): void {
  if (!surface || surface.kind !== 'editor' || !chatView) return
  const id = surface.conversationId
  chatView.closeEditor(surface)
  if (!id) return
  const sidebar = chatView.sidebar()
  if (sidebar) showIn(sidebar, id)
  else pendingSidebarConversation = id
  void chatView.revealSidebar()
}

/** Close a chat: to history, or deleted outright when there was nothing in it. */
function retire(id: string): void {
  const closing = conversations.get(id)
  if (closing && isBlank(closing)) conversations.delete(id)
  else conversations.archive(id)
}

/** The tab-strip close: stop its run, retire it, and take it off every view. */
function closeConversation(id: string): void {
  sessions.get(id)?.abort()
  sessions.delete(id)
  retire(id)
  vacate(id)
  pushConversations()
  for (const surface of chatView?.surfaces() ?? []) refreshHistory(surface)
}

/** A chat is gone from the strip: an editor tab on it closes, the sidebar moves on. */
function vacate(id: string): void {
  for (const surface of chatView?.surfaces() ?? []) {
    if (surface.conversationId !== id) continue
    if (surface.kind === 'editor') chatView?.closeEditor(surface)
    else showIn(surface, pickSidebarConversation(null))
  }
}

/** Every chat of this account, open ones included, newest first. Open chats
 *  are listed too, so one is never somewhere the person cannot find it. */
function historyItems(): Array<HistoryEntry & { running: boolean }> {
  if (!currentAccountId) return []
  return conversations.history(currentAccountId).map((h) => ({ ...h, running: sessions.get(h.id)?.busy === true }))
}

function pushHistoryPanel(to: Surface): void {
  chatView?.postTo(to, { type: 'showHistoryPanel', conversations: historyItems() })
}

/** Refresh the history list without opening it. */
function refreshHistory(to: Surface): void {
  chatView?.postTo(to, { type: 'historyList', conversations: historyItems() })
}

/** Where a command lands when it did not come from a view. */
function targetSurface(): Surface | undefined {
  return chatView?.focused() ?? chatView?.sidebar()
}

function toViews(list: Conversation[]): ConversationView[] {
  return list.map((c) => {
    const session = sessions.get(c.id)
    return { id: c.id, title: c.title, busy: session?.busy === true, queued: session?.queued ?? 0, draft: c.draft ?? '' }
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

/** A new chat in the sidebar's strip (the editor's bird button opens one in a tab). */
async function newChatCommand(): Promise<void> {
  const id = createConversation().id
  const sidebar = chatView?.sidebar()
  if (sidebar) showIn(sidebar, id)
  else pendingSidebarConversation = id
  await chatView?.revealSidebar()
}

async function openSettingsCommand(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', 'redstartYellowscript')
}

/** Reveal the panel on a page, and load its data. */
function showPage(page: PageName): void {
  const to = targetSurface()
  void chatView?.reveal(to).then(() => {
    const target = to ?? chatView?.sidebar()
    if (!target) return
    chatView?.postTo(target, { type: 'showPage', page })
    if (page === 'projects') void pushProjects(target)
    else void pushWorkflows(target)
  })
}

function openHistoryCommand(): void {
  const to = targetSurface()
  void chatView?.reveal(to).then(() => {
    const target = to ?? chatView?.sidebar()
    if (target) pushHistoryPanel(target)
  })
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
      { label: '$(account) Username and password', detail: 'Used once: Yellowscript keeps a key for this app instead', id: 'password' },
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
 * Run a ys_* tool by hand and show what the model would receive.
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
  // that cannot be made from a unit test: ys_diagnostics and ys_editor_context
  // read live VSCode state through the providers, and this is the only place
  // that wiring gets exercised outside an agent turn.
  const probes: Array<{ name: string; args: string }> = [
    { name: 'ys_editor_context', args: '{}' },
    { name: 'ys_diagnostics', args: '{}' },
    { name: 'ys_list_directory', args: '{"path":"."}' },
    { name: 'ys_glob', args: '{"pattern":"**/*.ts"}' },
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

/** The workspace plan's path, or null with no folder open. */
function workspacePlanPath(): string | null {
  const root = workspaceRoots()[0]
  return root ? nodePath.join(root, PLAN_DIR, PLAN_FILE) : null
}

/** The open plan in the workspace, or null (no file, or every step closed). */
function readWorkspacePlan(): PlanStep[] | null {
  const file = workspacePlanPath()
  if (!file) return null
  try {
    const steps = parsePlanFile(nodeFs.readFileSync(file, 'utf8'))
    return hasOpenSteps(steps) ? steps : null
  } catch {
    return null
  }
}

/** Keep the plan on disk; a cleared plan removes the file. Never fails a turn. */
function writeWorkspacePlan(steps: PlanStep[] | null): void {
  const file = workspacePlanPath()
  if (!file) return
  try {
    if (steps && steps.length > 0) {
      nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true })
      nodeFs.writeFileSync(file, formatPlanFile(steps), 'utf8')
    } else {
      nodeFs.rmSync(file, { force: true })
    }
  } catch (err) {
    output?.warn(`plan: could not write ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Undo every write the last task made, newest first, so a file written twice
 * ends at its state before the task. Files the task created are removed.
 */
async function revertLastTaskCommand(): Promise<void> {
  const task = lastTaskConversation ? tasks.get(lastTaskConversation) : undefined
  if (!task || task.checkpoints.length === 0) {
    vscode.window.showInformationMessage('Yellowscript: nothing to revert — the last task made no checkpointed writes.')
    return
  }
  const files = [...new Set(task.checkpoints.flatMap((c) => c.files.map((f) => f.workspaceAbsolute)))]
  const choice = await vscode.window.showWarningMessage(
    `Revert the last Yellowscript task? It made ${task.checkpoints.length} write${task.checkpoints.length === 1 ? '' : 's'}; ` +
      `${files.length} file${files.length === 1 ? '' : 's'} go back to how they were before it (files it created are deleted):`,
    { modal: true, detail: files.join('\n') },
    'Revert task',
  )
  if (choice !== 'Revert task') return

  try {
    for (const entry of [...task.checkpoints].reverse()) {
      await checkpointForWorkspace(entry.root).revert(entry.checkpoint, entry.files)
    }
    output?.info(`revert: undid ${task.checkpoints.length} write(s) of the last task (${files.length} file(s))`)
    task.checkpoints = []
    lastCheckpoint.clear()
    vscode.window.showInformationMessage(`Yellowscript: reverted the last task (${files.length} file${files.length === 1 ? '' : 's'}).`)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    vscode.window.showErrorMessage(`Could not revert the last task: ${reason}`)
    output?.error('task revert failed', err)
  }
}

/**
 * The task summary's file link: the file now, against its state before the
 * run first wrote it (from the checkpoint stored with the run, so it works
 * after a reload too).
 */
async function openTaskDiff(run: readonly ToolEffect[], file: string): Promise<void> {
  const base = fileBaseline(run, file)
  if (!base) {
    vscode.window.showInformationMessage(`Yellowscript: there is no checkpoint for ${file} in this task.`)
    return
  }
  try {
    const before = base.wasAbsent ? '' : await checkpointForWorkspace(base.root).show(base.revision, shadowKey(base.absolutePath))
    const beforeFile = nodePath.join(tmpdir(), `ys-before-${Date.now()}-${nodePath.basename(base.absolutePath)}`)
    await nodeFs.promises.writeFile(beforeFile, before, 'utf8')
    const now = nodeFs.existsSync(base.absolutePath) ? vscode.Uri.file(base.absolutePath) : vscode.Uri.parse(`untitled:${file} (deleted)`)
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(beforeFile), now, `Yellowscript: ${file} since the task`, { preview: true })
  } catch (err) {
    vscode.window.showErrorMessage(`Could not open the diff for ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** The task summary's Revert: undo the run's writes, newest first. */
async function revertTask(run: readonly ToolEffect[]): Promise<void> {
  const steps = revertSteps(run)
  if (steps.length === 0) {
    vscode.window.showInformationMessage('Yellowscript: this task made no checkpointed writes, so there is nothing to revert.')
    return
  }
  const files = [...new Set(steps.flatMap((s) => s.files.map((f) => f.absolutePath)))]
  const choice = await vscode.window.showWarningMessage(
    `Revert this Yellowscript task? ${files.length} file${files.length === 1 ? '' : 's'} go back to how they were before it ` +
      '(files it created are deleted). Later changes to these files are lost too.',
    { modal: true, detail: files.join('\n') },
    'Revert task',
  )
  if (choice !== 'Revert task') return
  try {
    for (const step of steps) {
      await checkpointForWorkspace(step.root).revert(
        { revision: step.revision, label: '' },
        step.files.map((f) => ({ workspaceAbsolute: f.absolutePath, relativePath: shadowKey(f.absolutePath), content: '', wasAbsent: f.wasAbsent })),
      )
    }
    output?.info(`revert: undid ${steps.length} write(s) of a task (${files.length} file(s))`)
    vscode.window.showInformationMessage(`Yellowscript: reverted the task (${files.length} file${files.length === 1 ? '' : 's'}).`)
  } catch (err) {
    vscode.window.showErrorMessage(`Could not revert the task: ${err instanceof Error ? err.message : String(err)}`)
    output?.error('task revert failed', err)
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
    pushSession()
    vscode.window.setStatusBarMessage('$(search) Yellowscript will discover the Nest automatically', 4000)
    await manager?.connect({})
    return
  }

  const url = normalizeBaseUrl(entered)
  try {
    new URL(url)
  } catch {
    return
  }
  await config().update('serverUrl', url, vscode.ConfigurationTarget.Workspace)
  pushSession()
  await manager?.connect({ url })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A message's @file attachments, read now: the content (up to 300 lines) or
 * the outline of a longer file. Files outside the workspace or that may hold
 * secrets are not attached; a notice says so.
 */
async function resolveAttachments(from: Surface, list: readonly AttachmentView[]): Promise<AttachmentView[]> {
  const roots = workspaceRoots()
  const out: AttachmentView[] = []
  for (const a of list) {
    if (a.kind !== 'file') {
      out.push(a)
      continue
    }
    let absolute: string
    try {
      absolute = resolveWithinWorkspace(roots, a.path)
    } catch {
      chatView?.postTo(from, { type: 'notice', level: 'warning', message: `${a.path} is outside the workspace, so it was not attached.` })
      continue
    }
    if (secretReason(absolute)) {
      chatView?.postTo(from, { type: 'notice', level: 'warning', message: `${a.path} may hold secrets, so it was not attached.` })
      continue
    }
    try {
      const text = (await nodeFs.promises.readFile(absolute, 'utf8')).replace(/\r\n/g, '\n')
      const lines = text.split('\n')
      if (lines.length <= MAX_FILE_LINES) {
        out.push({ kind: 'file', path: a.path, content: text.trimEnd(), lines: lines.length })
      } else {
        const { symbols } = await outlineOf(symbolProvider, absolute, text)
        out.push({ kind: 'file', path: a.path, content: formatOutline(symbols, 150).text || '(no symbols found)', lines: lines.length, outline: true })
      }
    } catch {
      out.push({ kind: 'file', path: a.path })
    }
  }
  return out
}

/** The @ picker: workspace files whose path contains `query`, shortest first. */
async function searchWorkspaceFiles(query: string): Promise<string[]> {
  const cleaned = query.replace(/[\\*?{}[\]]/g, '').trim()
  const pattern = cleaned ? `**/*${cleaned}*` : '**/*'
  const found = await vscode.workspace.findFiles(pattern, '{**/node_modules/**,**/.git/**,**/.yellowscript/**,**/dist/**,**/out/**}', 200)
  return found
    .map((uri) => vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/'))
    .filter((p) => !secretReason(p))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, 30)
}

/** The editor's selection, as a chip in the composer. */
async function addSelectionToChat(): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.uri.scheme !== 'file') return
  const selection = editor.selection.isEmpty ? editor.document.lineAt(editor.selection.active.line).range : editor.selection
  const startLine = selection.start.line + 1
  const endLine = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line : selection.end.line + 1
  const range = new vscode.Range(startLine - 1, 0, endLine - 1, editor.document.lineAt(endLine - 1).text.length)
  const to = targetSurface()
  await chatView?.reveal(to)
  const target = to ?? chatView?.sidebar()
  if (!target) return
  chatView?.postTo(target, {
    type: 'addAttachment',
    attachment: { kind: 'selection', path: vscode.workspace.asRelativePath(editor.document.uri, false).replace(/\\/g, '/'), startLine, endLine, text: editor.document.getText(range) },
  })
}

/** "Fix with Yellowscript" on a diagnostic: the problem, and the lines around it. */
async function fixDiagnostic(uri: vscode.Uri, diagnostic: vscode.Diagnostic): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri)
  const first = Math.max(0, diagnostic.range.start.line - 8)
  const last = Math.min(document.lineCount - 1, diagnostic.range.end.line + 8)
  const path = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/')
  const source = diagnostic.source ? ` (${diagnostic.source}${diagnostic.code !== undefined ? ` ${typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code}` : ''})` : ''
  const text = document.getText(new vscode.Range(first, 0, last, document.lineAt(last).text.length))
  const to = targetSurface()
  await chatView?.reveal(to)
  const target = to ?? chatView?.sidebar()
  if (!target) return
  sendTo(target, `Fix this problem in ${path} at line ${diagnostic.range.start.line + 1}: ${diagnostic.message}${source}`, undefined, [
    { kind: 'selection', path, startLine: first + 1, endLine: last + 1, text },
  ])
}

/** Which conversations wait on the person, and how long runs take. */
const attention = new AttentionTracker()

/**
 * Say so when a run needs the person, or a long one finished, and the window
 * is not focused (when it is, the card is already on screen). Show brings
 * that conversation to the front.
 */
function notifyUnwatched(conversationId: string, what: string): void {
  if (vscode.window.state.focused) return
  if (config().get<boolean>('notifyWhenWaiting') === false) return
  const title = conversations.get(conversationId)?.title ?? 'A chat'
  void vscode.window.showInformationMessage(`Yellowscript: "${title}" ${what}.`, 'Show').then((choice) => {
    if (choice === 'Show') void showConversation(conversationId)
  })
}

/** Reveal the chat with this conversation in front. */
async function showConversation(conversationId: string): Promise<void> {
  // Wherever it is on screen; else it comes up in the sidebar.
  const shownIn = chatView?.surfaces().find((s) => s.conversationId === conversationId)
  if (shownIn) {
    await chatView?.reveal(shownIn)
    return
  }
  const conv = conversations.get(conversationId)
  if (!conv) return
  if (conv.archived) conversations.unarchive(conversationId)
  const sidebar = chatView?.sidebar()
  if (sidebar) showIn(sidebar, conversationId)
  else pendingSidebarConversation = conversationId
  await chatView?.revealSidebar()
}

/** What the command classifier needs to know about this workspace and run. */
function commandContextFor(conversationId: string, pending: PendingCommand): CommandContext {
  return nodeCommandContext({
    cwd: pending.cwd,
    roots: workspaceRoots().map((root) => {
      try {
        return nodeFs.realpathSync.native(root)
      } catch {
        return root
      }
    }),
    readRoots: usableReadRoots(extraReadRoots()),
    builtInSafe: config().get<boolean>('commands.builtInSafe') !== false,
    projectChecks: config().get<boolean>('commands.autoRunProjectChecks') !== false,
    background: pending.background === true,
    // package.json as this run's first checkpoint of it holds it.
    packageJsonBeforeRun: (file) => {
      const key = file.toLowerCase()
      for (const entry of tasks.get(conversationId)?.checkpoints ?? []) {
        const staged = entry.files.find((f) => f.workspaceAbsolute.toLowerCase() === key)
        if (staged) return staged.wasAbsent ? '' : staged.content
      }
      return null
    },
  })
}

/** Folders outside the workspace the person allowed the read tools. */
function extraReadRoots(): string[] {
  const value = config().get<string[]>('extraReadRoots')
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim() !== '') : []
}

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
    if (currentAccountId) {
      const migrated = conversations.migrateAccountId(currentAccountId)
      if (migrated > 0) {
        output?.info(`history: migrated ${migrated} conversation(s) to account "${currentAccountId}"`)
      }
    }
    output?.info(`account: ${currentAccountId ?? 'unknown'}`)
    // The strip is per account: a view still on another account's chat moves
    // to one of this account's.
    for (const surface of chatView?.surfaces() ?? []) {
      const conv = surface.conversationId ? conversations.get(surface.conversationId) : undefined
      if (surface.kind === 'sidebar' && conv && currentAccountId && conv.accountId && conv.accountId !== currentAccountId) {
        showIn(surface, pickSidebarConversation(null))
      }
    }
    pushConversations()

    void refreshModel()
    void connectMcpHost()
  } else if (state.status === 'disconnected' || state.status === 'unauthenticated') {
    currentAccountId = null
  }
}

/**
 * Bring up the MCP host against the connected Nest. Phase 4.2/4.3: discovers the
 * built-in MCP server via /redstart/mcp-servers, opens the SSE stream, lists
 * tools, and merges them with the local ys_* set under a disjointness assertion.
 *
 * Re-run on every (re)connect — the tool set follows the active profile, so a
 * cached list is stale the moment an operator switches profiles without the
 * connection dropping. On failure the extension still works with just the local
 * ys_* tools — the MCP host is a bonus, not a hard dependency.
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
  // Approvals for Nest's own tools: per connection, because the grant cache
  // belongs to the account this client is signed in as.
  const approvals = makeNestApprovalDeps(client, (m) => output?.warn(m))
  const host = new McpHost(
    {
      baseUrl: client.baseUrl,
      listMcpServers: (signal) => client.listMcpServers(signal),
      fetch: (input, init) => fetch(input, init),
      getCredential: () => client.getCredential(),
    },
    {
      onTools: (mcpTools: readonly McpTool[]) => {
        const refs: NestToolRef[] = mcpTools
          .filter((t) => !currentDisabled.has(t.name))
          .map((t) => {
            const ref: NestToolRef = {
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              execute: async (args: unknown, context) => {
                // Ask on the card of the conversation that made the call.
                const asker = context.conversationId ? sessions.get(context.conversationId) : undefined
                return (
                  await callWithApproval(t.name, args, approvalInfo(t.meta), {
                    ...approvals,
                    ...(asker ? { prompt: (request) => promptInChat(request, asker.askApproval) } : {}),
                    call: (meta) => host.callToolResult(t.name, args, withProjectMeta(meta, linkedProject()?.id)),
                  })
                ).text
              },
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
            `mcp: merged ${refs.length} Nest tools with ${base.names.length} local ys_* tools`,
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
  chatView?.broadcast({ type: 'tools', names: current.names })
}
