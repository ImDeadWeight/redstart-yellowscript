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

import { ConnectionManager, describeState } from './connection.ts'
import { ChatSession } from './chat/session.ts'
import { findBrowser } from './browser/cdp.ts'
import { buildWorkspaceContext } from './tools/workspace-context.ts'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import { PLAN_DIR, PLAN_FILE } from './chat/plan-file.ts'
import { ContextTracker } from './agent/context-budget.ts'
import { DEFAULT_MAX_ITERATIONS } from './agent/loop.ts'
import {
  EMPTY_CONVERSATION_STATE,
  type ConversationView,
  type HostMessage,
  type PageName,
  type SessionSnapshot,
  tabLabel,
} from './chat/protocol.ts'
import { NestClient } from './nest/client.ts'
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
import { makeApprovalGate, checkpointForWorkspace } from './ui/write-approval.ts'
import type { PendingCommand } from './tools/types.ts'
import { classifyCommand, type CommandContext } from './tools/safe-commands.ts'
import { nodeCommandContext } from './tools/command-context.ts'
import { usableReadRoots } from './tools/read-scope.ts'
import { AttentionTracker, LONG_RUN_MS } from './chat/attention.ts'
import { attachmentLabel } from './chat/attachments.ts'
import type { AttachmentView } from './chat/protocol.ts'
import { makeCommandGate } from './ui/run-command.ts'
import { BackgroundProcesses, describeRunning } from './tools/background-processes.ts'
import { McpHost, withProjectMeta, type McpTool } from './nest/mcp-host.ts'
import { approvalInfo, callWithApproval } from './nest/approval.ts'
import { makeNestApprovalDeps, promptInChat } from './ui/nest-approval.ts'
import { AUTH_PROVIDER_ID, RedstartAuthProvider } from './ui/auth-provider.ts'
import { mergeNestTools, type NestToolRef } from './tools/registry.ts'
import { conversationStore, isBlank, type Conversation, type HistoryEntry } from './ui/conversation-store.ts'
import { createProjects, type Projects } from './host/projects.ts'
import { createTasks, type Tasks } from './host/tasks.ts'
import { FIX_DIAGNOSTIC_COMMAND, createEditorActions, type EditorActions } from './host/editor-actions.ts'
import { createConnectionCommands, loggedDiscovery, type ConnectionCommands } from './host/connection-commands.ts'
import { config, extraReadRoots } from './host/config.ts'

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
/** Connect, sign in and out, and the signed-in account. */
let connection!: ConnectionCommands
/** This workspace's Nest project, and the account's workflows. */
let projects!: Projects
/** One ChatSession per conversation, keyed by conversation id. Tabs own their
 *  own transcript and request lifecycle, so switching tabs is a pure view
 *  change and a running turn keeps streaming in its own tab. */
let sessions = new Map<string, ChatSession>()
/** The merged registry — local ys_* tools + live Nest tools. Rebuilt whenever the
 *  Nest tool set changes (on connect and on re-list). Cached because the agent
 *  loop reads it per turn. */
let mergedTools: ToolRegistry | null = null
/** Each conversation's running task: its trust, its checkpoints, reverting it. */
let tasks!: Tasks
/** Attachments, the @ picker, Add Selection and Fix with Yellowscript. */
let editorActions!: EditorActions
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
    onSessionChanged: () => pushSession(),
    onSignedIn: () => followAccount(),
    onConnected: () => connectMcpHost(),
    onDisconnect: () => {
      mcpHost?.stop()
      mcpHost = null
      mergedTools = null
      pushTools()
    },
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
    mcp: () => mcpHost,
    onLinkChanged: () => pushSession(),
    send: (from, text, workflow) => sendTo(from, text, workflow),
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

  editorActions = createEditorActions({
    roots: workspaceRoots,
    symbols: symbolProvider,
    post: (to, message) => chatView?.postTo(to, message),
    revealTarget,
    send: (surface, text, attachments) => sendTo(surface, text, undefined, attachments),
  })

  // A session is created lazily per conversation (see getSession). No singleton
  // here — the tab strip is the source of truth for which conversations exist.

  chatView = new ChatViewProvider(context.extensionUri, {
    onSend: (from, text, attachments) => {
      void editorActions.resolveAttachments(from, attachments ?? []).then((resolved) => sendTo(from, text, undefined, resolved))
    },
    onSearchFiles: (from, query) => {
      void editorActions.searchFiles(query).then((paths) => chatView?.postTo(from, { type: 'fileMatches', query, paths }))
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
      void connection.applyServerUrl(url)
    },
    onSignIn: (message) => {
      void connection.signInFromPanel(message)
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
      if (from.conversationId) void tasks.openDiff(getSession(from.conversationId).runOf(turnId) ?? [], file)
    },
    onRevertTask: (from, turnId) => {
      if (from.conversationId) void tasks.revert(getSession(from.conversationId).runOf(turnId) ?? [])
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
    manager.onDidChangeState((state) => connection.onStateChanged(state)),
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
    vscode.commands.registerCommand('redstartYellowscript.connect', () => connection.connect()),
    vscode.commands.registerCommand('redstartYellowscript.disconnect', () => connection.disconnect()),
    vscode.commands.registerCommand('redstartYellowscript.signIn', () => connection.signIn()),
    vscode.commands.registerCommand('redstartYellowscript.signOut', () => connection.signOut()),
    vscode.commands.registerCommand('redstartYellowscript.showStatus', () => connection.showStatus()),
    vscode.commands.registerCommand('redstartYellowscript.newChat', newChatCommand),
    vscode.commands.registerCommand('redstartYellowscript.openSettings', openSettingsCommand),
    vscode.commands.registerCommand('redstartYellowscript.openHistory', openHistoryCommand),
    vscode.commands.registerCommand('redstartYellowscript.chooseProject', () => showPage('projects')),
    vscode.commands.registerCommand('redstartYellowscript.runWorkflow', () => showPage('workflows')),
    vscode.commands.registerCommand('redstartYellowscript.inspectTools', inspectToolsCommand),
    vscode.commands.registerCommand('redstartYellowscript.revertLastWrite', () => tasks.revertLastWrite()),
    vscode.commands.registerCommand('redstartYellowscript.revertLastTask', () => tasks.revertLastTask()),
    vscode.commands.registerCommand('redstartYellowscript.addSelection', () => editorActions.addSelection()),
    vscode.commands.registerCommand(FIX_DIAGNOSTIC_COMMAND, (uri: vscode.Uri, d: vscode.Diagnostic) => editorActions.fixDiagnostic(uri, d)),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, editorActions.codeActions, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.commands.registerCommand('redstartYellowscript.showWaiting', () => {
      const id = attention.firstWaiting()
      return id ? showConversation(id) : chatView?.reveal()
    }),
  )

  connection.autoConnect()
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
      onPlanChanged: (steps) => tasks.writePlan(steps),
      workspaceContext: () => {
        const root = workspaceRoots()[0]
        if (!root) return null
        // What it is told about keeping notes, plans and memories follows the
        // tools it actually has, and whether the workspace has a project.
        const registry = mergedTools ?? tools
        return buildWorkspaceContext(root, undefined, {
          ...(registry ? { tools: registry.names } : {}),
          project: projects.linked()?.name ?? null,
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
          recordCheckpoint: (checkpoint, files) => tasks.recordCheckpoint(id, roots[0]!, checkpoint, files),
          task: {
            trusted: () => tasks.trusted(id),
            trust: () => tasks.trust(id),
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
      projectId: () => projects.linked()?.id ?? null,
      onPersist: () => persistConversation(id),
      emit: (message) => {
        // A task is one user message's run: it starts when that message runs
        // (not when it queues) and ends with the turn. "Apply all in this
        // task" lasts until then; its checkpoints stay for Revert Last Task.
        if (message.type === 'message' && message.message.role === 'user' && !message.message.pending) {
          tasks.start(id)
          attention.runStarted(id)
        } else if (message.type === 'turn/completed' || message.type === 'turn/failed') {
          tasks.end(id)
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
      const carried = tasks.readPlan()
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
  const project = connected ? projects.linked() : null
  if (project) base.project = { id: project.id, name: project.name }
  const tracker = connected ? contextFor(manager?.activeClient ?? null) : null
  if (tracker) base.vision = tracker.vision
  const configured = config().get<string>('serverUrl', '').trim()
  if (configured) base.configuredUrl = configured
  return base
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
  return conversations.list(connection.account() ?? undefined).filter((c) => !chatView?.editorFor(c.id))
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
  return conversations.create('New chat', [], connection.account() ?? undefined)
}

/**
 * The chat the sidebar should show: `preferred` when it is open, this
 * account's and not in an editor tab; else the first of the strip; else a new one.
 */
function pickSidebarConversation(preferred: string | null | undefined): string {
  const candidates = sidebarConversations()
  const account = connection.account()
  if (preferred) {
    const conv = conversations.get(preferred)
    if (conv && !chatView?.editorFor(preferred) && (!account || !conv.accountId || conv.accountId === account)) {
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
  const account = connection.account()
  if (!account) return []
  return conversations.history(account).map((h) => ({ ...h, running: sessions.get(h.id)?.busy === true }))
}

function pushHistoryPanel(to: Surface): void {
  chatView?.postTo(to, { type: 'showHistoryPanel', conversations: historyItems() })
}

/** Refresh the history list without opening it. */
function refreshHistory(to: Surface): void {
  chatView?.postTo(to, { type: 'historyList', conversations: historyItems() })
}

/**
 * Signed in: the strip is per account, so a view still on another account's
 * chat moves to one of this account's.
 */
function followAccount(): void {
  const account = connection.account()
  for (const surface of chatView?.surfaces() ?? []) {
    const conv = surface.conversationId ? conversations.get(surface.conversationId) : undefined
    if (surface.kind === 'sidebar' && conv && account && conv.accountId && conv.accountId !== account) {
      showIn(surface, pickSidebarConversation(null))
    }
  }
  pushConversations()
}

/** Where a command lands when it did not come from a view. */
function targetSurface(): Surface | undefined {
  return chatView?.focused() ?? chatView?.sidebar()
}

/** Bring the chat a command lands in to the front. */
async function revealTarget(): Promise<Surface | undefined> {
  const to = targetSurface()
  await chatView?.reveal(to)
  return to ?? chatView?.sidebar()
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
    if (page === 'projects') void projects.push(target)
    else void projects.pushWorkflows(target)
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      for (const entry of tasks.checkpoints(conversationId)) {
        const staged = entry.files.find((f) => f.workspaceAbsolute.toLowerCase() === key)
        if (staged) return staged.wasAbsent ? '' : staged.content
      }
      return null
    },
  })
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
                    call: (meta) => host.callToolResult(t.name, args, withProjectMeta(meta, projects.linked()?.id)),
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
