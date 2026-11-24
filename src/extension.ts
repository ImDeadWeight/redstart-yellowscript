// =============================================================================
// Redstart Yellowscript — extension entry point.
// =============================================================================
// activate() builds the Host: one object holding every part of the extension,
// each built here from the parts it uses and nothing else. A part that needs
// to tell another one something is given a callback at construction; no part
// reaches for another's state.
//
//   host/connection-commands  the Nest connection, sign-in, the account
//   host/projects             the workspace's Nest project, the workflows
//   host/tooling              the ys_* tools, the Nest's tools, processes
//   host/tasks                each run's checkpoints, reverts, the plan file
//   host/sessions             one ChatSession per conversation
//   host/surfaces             which conversation each view shows
//   host/editor-actions       attachments, Add Selection, Fix with Yellowscript
//   host/chat-handlers        what each message from a view does
//   agent/compose             one chat's agent (host/agent-setup: VS Code's side)
//
// What remains here is building the Host, registering the commands, and
// taking it down in deactivate().
// =============================================================================

import * as vscode from 'vscode'
import { hostname } from 'node:os'

import { composeSession } from './agent/compose.ts'
import { ConnectionManager } from './connection.ts'
import { createAgentSetup } from './host/agent-setup.ts'
import { chatViewHandlers } from './host/chat-handlers.ts'
import { config } from './host/config.ts'
import { createConnectionCommands, loggedDiscovery, type ConnectionCommands } from './host/connection-commands.ts'
import { FIX_DIAGNOSTIC_COMMAND, createEditorActions, type EditorActions } from './host/editor-actions.ts'
import { createProjects, type Projects } from './host/projects.ts'
import { createSessions, type Sessions } from './host/sessions.ts'
import { createSurfaces, type Surfaces } from './host/surfaces.ts'
import { createTasks, type Tasks } from './host/tasks.ts'
import { createTooling, type Tooling } from './host/tooling.ts'
import { NestClient } from './nest/client.ts'
import { SecretCredentialStore, WorkspaceStateStore } from './storage.ts'
import { AUTH_PROVIDER_ID, RedstartAuthProvider } from './ui/auth-provider.ts'
import { ChatViewProvider } from './ui/chat-view.ts'
import { conversationStore, type ConversationStore } from './ui/conversation-store.ts'
import { StatusBar } from './ui/status-bar.ts'
import { symbolProvider, workspaceRoots } from './ui/tool-providers.ts'

/** Every part of the running extension. */
interface Host {
  output: vscode.LogOutputChannel
  statusBar: StatusBar
  manager: ConnectionManager
  conversations: ConversationStore
  connection: ConnectionCommands
  projects: Projects
  tooling: Tooling
  tasks: Tasks
  sessions: Sessions
  surfaces: Surfaces
  editorActions: EditorActions
  chatView: ChatViewProvider
}

let host: Host | undefined

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Redstart Yellowscript', { log: true })
  const statusBar = new StatusBar()
  const conversations = conversationStore(context.workspaceState)
  const tasks = createTasks({ log: output, roots: workspaceRoots })

  const pruned = conversations.prune(14)
  if (pruned > 0) {
    output.info(`history: pruned ${pruned} conversation(s) older than 14 days`)
  }
  // Closed chats that never had anything in them, left over from before
  // closing a blank chat deleted it.
  const blank = conversations.pruneBlank()
  if (blank > 0) output.info(`history: removed ${blank} empty conversation(s)`)

  // Created last, once everything its handlers call exists; until then (and
  // only then) the parts below see no view.
  let chatView: ChatViewProvider | undefined

  const manager = new ConnectionManager({
    credentials: new SecretCredentialStore(context.secrets),
    state: new WorkspaceStateStore(context.workspaceState),
    createClient: (baseUrl) => new NestClient(baseUrl),
    discover: loggedDiscovery(output),
    // A password sign-in becomes a key Nest issues to this app, named for this
    // machine so it is recognisable in the chat app's list of app keys.
    appKey: { surface: 'yellowscript', label: `Yellowscript on ${hostname()}` },
  })
  const connection = createConnectionCommands({
    manager,
    statusBar,
    log: output,
    conversations,
    onSessionChanged: () => surfaces.pushSession(),
    onSignedIn: () => surfaces.followAccount(),
    onConnected: () => {
      const client = manager.activeClient
      if (client) tooling.connectNest(client)
    },
    onDisconnect: () => tooling.disconnectNest(),
  })
  const authProvider = new RedstartAuthProvider(manager, {
    signIn: async () => {
      // Sign-in happens in the panel; the Accounts menu just opens it there.
      if (manager.state.status === 'disconnected' || manager.state.status === 'error') await manager.connect()
      await chatView?.reveal()
    },
    signOut: () => connection.signOut(),
  })
  const projects = createProjects({
    connection: manager,
    account: () => connection.account(),
    store: context.workspaceState,
    post: (to, message) => chatView?.postTo(to, message),
    mcp: () => tooling.mcp(),
    onLinkChanged: () => surfaces.pushSession(),
    send: (from, text, workflow) => sessions.send(from, text, workflow),
  })
  const tooling = createTooling({
    log: output,
    roots: workspaceRoots,
    broadcast: (message) => chatView?.broadcast(message),
    askerFor: (conversationId) => sessions.find(conversationId)?.askApproval,
    projectId: () => projects.linked()?.id,
  })

  // What every chat's agent runs against: the workspace, the tools, the gates.
  const agentSetup = createAgentSetup({ manager, tooling, projects, tasks, log: output })
  // A session is created lazily per conversation. No singleton: the tab strip
  // is the source of truth for which conversations exist.
  const sessions = createSessions({
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
  // Which conversation each view shows is decided when that view announces
  // itself (onReady): the sidebar and every editor tab each have their own.
  const surfaces = createSurfaces({
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
  const editorActions = createEditorActions({
    roots: workspaceRoots,
    symbols: symbolProvider,
    post: (to, message) => chatView?.postTo(to, message),
    revealTarget: () => surfaces.revealTarget(),
    send: (surface, text, attachments) => sessions.send(surface, text, undefined, attachments),
  })

  const view = new ChatViewProvider(
    context.extensionUri,
    chatViewHandlers({
      sessions,
      surfaces,
      projects,
      connection,
      editorActions,
      tasks,
      tooling,
      conversations,
      post: (to, message) => view.postTo(to, message),
      runCommand: (command) => void vscode.commands.executeCommand(`redstartYellowscript.${command}`),
    }),
  )
  chatView = view
  host = { output, statusBar, manager, conversations, connection, projects, tooling, tasks, sessions, surfaces, editorActions, chatView: view }

  const command = (name: string, run: (...args: never[]) => unknown) => vscode.commands.registerCommand(`redstartYellowscript.${name}`, run)
  context.subscriptions.push(
    ...tooling.disposables,
    output,
    statusBar,
    manager.onDidChangeState((state) => connection.onStateChanged(state)),
    // The Redstart account in VS Code's Accounts menu.
    authProvider,
    vscode.authentication.registerAuthenticationProvider(AUTH_PROVIDER_ID, 'Redstart', authProvider, {
      supportsMultipleAccounts: false,
    }),
    // Chats opened as editor tabs, restored on their chat after a window reload.
    vscode.window.registerWebviewPanelSerializer(ChatViewProvider.panelType, view),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, view, {
      // Keep the transcript alive when the panel is hidden. Without this the
      // webview is torn down and the user loses their place in the conversation
      // every time they switch to the file explorer.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    command('openInEditor', () => surfaces.openInEditor(surfaces.create().id)),
    command('moveToEditor', () => surfaces.moveSidebarToEditor()),
    command('moveToSidebar', () => surfaces.moveEditorToSidebar(view.activeEditor())),
    command('connect', () => connection.connect()),
    command('disconnect', () => connection.disconnect()),
    command('signIn', () => connection.signIn()),
    command('signOut', () => connection.signOut()),
    command('showStatus', () => connection.showStatus()),
    command('newChat', () => surfaces.newChat()),
    command('openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'redstartYellowscript')),
    command('openHistory', () => surfaces.showHistory()),
    command('chooseProject', () => surfaces.showPage('projects')),
    command('runWorkflow', () => surfaces.showPage('workflows')),
    command('inspectTools', () => tooling.inspect()),
    command('revertLastWrite', () => tasks.revertLastWrite()),
    command('revertLastTask', () => tasks.revertLastTask()),
    command('addSelection', () => editorActions.addSelection()),
    vscode.commands.registerCommand(FIX_DIAGNOSTIC_COMMAND, (uri: vscode.Uri, d: vscode.Diagnostic) => editorActions.fixDiagnostic(uri, d)),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, editorActions.codeActions, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    command('showWaiting', () => {
      const id = sessions.firstWaiting()
      return id ? surfaces.showConversation(id) : view.reveal()
    }),
  )

  connection.autoConnect()
}

export function deactivate(): void {
  // A dev server the model started must not outlive the window.
  host?.tooling.stopAll()
  host?.statusBar.dispose()
  // Cancel every conversation's in-flight turn before tearing down.
  host?.sessions.abortAll()
  host = undefined
}
