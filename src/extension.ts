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
import { hostname } from 'node:os'

import { ConnectionManager } from './connection.ts'
import { NestClient } from './nest/client.ts'
import { SecretCredentialStore, WorkspaceStateStore } from './storage.ts'
import { StatusBar } from './ui/status-bar.ts'
import { ChatViewProvider } from './ui/chat-view.ts'
import { symbolProvider, workspaceRoots } from './ui/tool-providers.ts'
import { AUTH_PROVIDER_ID, RedstartAuthProvider } from './ui/auth-provider.ts'
import { conversationStore } from './ui/conversation-store.ts'
import { createProjects, type Projects } from './host/projects.ts'
import { createTasks, type Tasks } from './host/tasks.ts'
import { FIX_DIAGNOSTIC_COMMAND, createEditorActions, type EditorActions } from './host/editor-actions.ts'
import { createConnectionCommands, loggedDiscovery, type ConnectionCommands } from './host/connection-commands.ts'
import { config } from './host/config.ts'
import { createTooling, type Tooling } from './host/tooling.ts'
import { createSurfaces, type Surfaces } from './host/surfaces.ts'
import { createSessions, type Sessions } from './host/sessions.ts'
import { createAgentSetup } from './host/agent-setup.ts'
import { composeSession } from './agent/compose.ts'

let manager: ConnectionManager | undefined
let statusBar: StatusBar | undefined
let output: vscode.LogOutputChannel | undefined
let chatView: ChatViewProvider | undefined
let conversations: ReturnType<typeof conversationStore>
/** Which conversation each view shows, and keeping the views current. */
let surfaces!: Surfaces
/** Connect, sign in and out, and the signed-in account. */
let connection!: ConnectionCommands
/** This workspace's Nest project, and the account's workflows. */
let projects!: Projects
/** One ChatSession per conversation, and what follows from its runs. */
let sessions!: Sessions
/** The ys_* tools, the Nest's tools, and the processes they start. */
let tooling!: Tooling
/** Each conversation's running task: its trust, its checkpoints, reverting it. */
let tasks!: Tasks
/** Attachments, the @ picker, Add Selection and Fix with Yellowscript. */
let editorActions!: EditorActions

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Redstart Yellowscript', { log: true })
  statusBar = new StatusBar()
  conversations = conversationStore(context.workspaceState)
  tasks = createTasks({ log: output, roots: workspaceRoots })

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
    discover: loggedDiscovery(output),
    // A password sign-in becomes a key Nest issues to this app, named for this
    // machine so it is recognisable in the chat app's list of app keys.
    appKey: { surface: 'yellowscript', label: `Yellowscript on ${hostname()}` },
  })
  connection = createConnectionCommands({
    manager,
    statusBar,
    log: output,
    conversations,
    onSessionChanged: () => surfaces.pushSession(),
    onSignedIn: () => surfaces.followAccount(),
    onConnected: () => {
      const client = manager?.activeClient
      if (client) tooling.connectNest(client)
    },
    onDisconnect: () => tooling.disconnectNest(),
  })
  const authProvider = new RedstartAuthProvider(manager, {
    signIn: async () => {
      // Sign-in happens in the panel; the Accounts menu just opens it there.
      if (manager?.state.status === 'disconnected' || manager?.state.status === 'error') await manager.connect()
      await chatView?.reveal()
    },
    signOut: () => connection.signOut(),
  })
  projects = createProjects({
    connection: manager,
    account: () => connection.account(),
    store: context.workspaceState,
    post: (to, message) => chatView?.postTo(to, message),
    mcp: () => tooling.mcp(),
    onLinkChanged: () => surfaces.pushSession(),
    send: (from, text, workflow) => sessions.send(from, text, workflow),
  })

  tooling = createTooling({
    log: output,
    roots: workspaceRoots,
    broadcast: (message) => chatView?.broadcast(message),
    askerFor: (conversationId) => sessions.find(conversationId)?.askApproval,
    projectId: () => projects.linked()?.id,
  })
  context.subscriptions.push(...tooling.disposables)

  editorActions = createEditorActions({
    roots: workspaceRoots,
    symbols: symbolProvider,
    post: (to, message) => chatView?.postTo(to, message),
    revealTarget: () => surfaces.revealTarget(),
    send: (surface, text, attachments) => sessions.send(surface, text, undefined, attachments),
  })

  // What every chat's agent runs against: the workspace, the tools, the gates.
  const agentSetup = createAgentSetup({ manager, tooling, projects, tasks, log: output })
  sessions = createSessions({
    connection: manager,
    conversations,
    views: {
      post: (conversationId, message) => chatView?.postToConversation(conversationId, message),
      conversationsChanged: () => surfaces.pushConversations(),
      sessionsChanged: () => surfaces.pushSession(),
      conversationOn: (surface) => surfaces.conversationOn(surface),
      needsAttention: (conversationId, what) => surfaces.notifyUnwatched(conversationId, what),
    },
    statusBar,
    tasks,
    log: output,
    project: () => projects.linked(),
    configuredUrl: () => config().get<string>('serverUrl', ''),
    createSession: (conversationId, hooks) => composeSession(agentSetup, conversationId, hooks),
  })
  surfaces = createSurfaces({
    view: () => chatView,
    conversations,
    account: () => connection.account(),
    sessions,
    pages: projects,
    notifier: {
      focused: () => vscode.window.state.focused,
      enabled: () => config().get<boolean>('notifyWhenWaiting') !== false,
      show: (message, action) => vscode.window.showInformationMessage(message, action),
    },
  })

  // A session is created lazily per conversation (see getSession). No singleton
  // here — the tab strip is the source of truth for which conversations exist.

  chatView = new ChatViewProvider(context.extensionUri, {
    onSend: (from, text, attachments) => {
      void editorActions.resolveAttachments(from, attachments ?? []).then((resolved) => sessions.send(from, text, undefined, resolved))
    },
    onSearchFiles: (from, query) => {
      void editorActions.searchFiles(query).then((paths) => chatView?.postTo(from, { type: 'fileMatches', query, paths }))
    },
    onAbort: (from) => {
      if (from.conversationId) sessions.get(from.conversationId).abort()
      surfaces.pushSession()
    },
    onNewConversation: (from) => surfaces.newIn(from),
    onListConversations: () => surfaces.pushConversations(),
    onSwitchConversation: (from, id) => surfaces.switchTo(from, id),
    onDeleteConversation: (_from, id) => surfaces.close(id),
    onSaveDraft: (id, text) => {
      conversations.setDraft(id, text)
    },
    onRunCommand: (command) => {
      void vscode.commands.executeCommand(`redstartYellowscript.${command}`)
    },
    onMoveToSidebar: (from) => surfaces.moveEditorToSidebar(from),
    onMoveToEditor: (id) => surfaces.openInEditor(id),
    onSetServerUrl: (url) => {
      void connection.applyServerUrl(url)
    },
    onSignIn: (message) => {
      void connection.signInFromPanel(message)
    },
    onReady: (from, restoredId) => surfaces.ready(from, restoredId),
    onOpenHistory: (from) => surfaces.openHistory(from),
    onOpenPage: (from, page) => {
      if (page === 'projects') void projects.push(from)
      else void projects.pushWorkflows(from)
    },
    onLinkProject: (from, id) => {
      void projects.link(from, id)
    },
    onCreateProject: (from, name) => {
      void projects.create(from, name)
    },
    onRunWorkflow: (from, name, args) => {
      void projects.runWorkflow(from, name, args)
    },
    onAnswer: (from, id, answer) => {
      if (from.conversationId) sessions.get(from.conversationId).answer(id, answer)
    },
    onApprove: (from, id, choice) => {
      if (from.conversationId) sessions.get(from.conversationId).approve(id, choice)
    },
    onOpenApprovalDiff: (from, id, index) => {
      if (from.conversationId) sessions.get(from.conversationId).openApprovalFile(id, index)
    },
    onClearPlan: (from) => {
      if (from.conversationId) sessions.get(from.conversationId).clearPlan()
    },
    onContinueAtLimit: (from, go) => {
      if (from.conversationId) sessions.get(from.conversationId).continueAtLimit(go)
    },
    onResumeTask: (from, restart) => {
      if (!from.conversationId) return
      const session = sessions.get(from.conversationId)
      // Clicking "Restart and continue" is the person's go-ahead for them.
      const resumed = session.resumeInterrupted()
      if (!resumed) return
      if (restart) {
        for (const p of resumed.processes) {
          try {
            const started = tooling.processes.start(p.command, p.cwd)
            tooling.commandChannel.appendLine(`\n$ ${p.command}    (restarted for an interrupted task as ${started.id})`)
          } catch (err) {
            output?.warn(`could not restart ${p.command}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
      void resumed.sent
    },
    onDismissInterrupted: (from) => {
      if (from.conversationId) sessions.get(from.conversationId).dismissInterrupted()
    },
    onOpenTaskDiff: (from, turnId, file) => {
      if (from.conversationId) void tasks.openDiff(sessions.get(from.conversationId).runOf(turnId) ?? [], file)
    },
    onRevertTask: (from, turnId) => {
      if (from.conversationId) void tasks.revert(sessions.get(from.conversationId).runOf(turnId) ?? [])
    },
    onSearchHistory: (from, query) => surfaces.searchHistory(from, query),
    onDeleteHistory: (from, id) => surfaces.deleteForever(from, id),
    onRestoreHistory: (from, id) => surfaces.restore(from, id),
    onSurfaceClosed: (surface) => surfaces.closed(surface),
  })
  context.subscriptions.push(
    output,
    statusBar,
    manager.onDidChangeState((state) => connection.onStateChanged(state)),
    // The Redstart account in VS Code's Accounts menu.
    authProvider,
    vscode.authentication.registerAuthenticationProvider(AUTH_PROVIDER_ID, 'Redstart', authProvider, {
      supportsMultipleAccounts: false,
    }),
    // Chats opened as editor tabs, restored on their chat after a window reload.
    vscode.window.registerWebviewPanelSerializer(ChatViewProvider.panelType, chatView),
    vscode.commands.registerCommand('redstartYellowscript.openInEditor', () => surfaces.openInEditor(surfaces.create().id)),
    vscode.commands.registerCommand('redstartYellowscript.moveToEditor', () => surfaces.moveSidebarToEditor()),
    vscode.commands.registerCommand('redstartYellowscript.moveToSidebar', () => surfaces.moveEditorToSidebar(chatView?.activeEditor())),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatView, {
      // Keep the transcript alive when the panel is hidden. Without this the
      // webview is torn down and the user loses their place in the conversation
      // every time they switch to the file explorer.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('redstartYellowscript.connect', () => connection.connect()),
    vscode.commands.registerCommand('redstartYellowscript.disconnect', () => connection.disconnect()),
    vscode.commands.registerCommand('redstartYellowscript.signIn', () => connection.signIn()),
    vscode.commands.registerCommand('redstartYellowscript.signOut', () => connection.signOut()),
    vscode.commands.registerCommand('redstartYellowscript.showStatus', () => connection.showStatus()),
    vscode.commands.registerCommand('redstartYellowscript.newChat', () => surfaces.newChat()),
    vscode.commands.registerCommand('redstartYellowscript.openSettings', openSettingsCommand),
    vscode.commands.registerCommand('redstartYellowscript.openHistory', () => surfaces.showHistory()),
    vscode.commands.registerCommand('redstartYellowscript.chooseProject', () => surfaces.showPage('projects')),
    vscode.commands.registerCommand('redstartYellowscript.runWorkflow', () => surfaces.showPage('workflows')),
    vscode.commands.registerCommand('redstartYellowscript.inspectTools', () => tooling.inspect()),
    vscode.commands.registerCommand('redstartYellowscript.revertLastWrite', () => tasks.revertLastWrite()),
    vscode.commands.registerCommand('redstartYellowscript.revertLastTask', () => tasks.revertLastTask()),
    vscode.commands.registerCommand('redstartYellowscript.addSelection', () => editorActions.addSelection()),
    vscode.commands.registerCommand(FIX_DIAGNOSTIC_COMMAND, (uri: vscode.Uri, d: vscode.Diagnostic) => editorActions.fixDiagnostic(uri, d)),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, editorActions.codeActions, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.commands.registerCommand('redstartYellowscript.showWaiting', () => {
      const id = sessions.firstWaiting()
      return id ? surfaces.showConversation(id) : chatView?.reveal()
    }),
  )

  connection.autoConnect()
}

export function deactivate(): void {
  tooling?.stopAll()
  statusBar?.dispose()
  statusBar = undefined
  // Cancel every conversation's in-flight turn before tearing down.
  sessions?.abortAll()
  chatView = undefined
  manager = undefined
}

async function openSettingsCommand(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', 'redstartYellowscript')
}
