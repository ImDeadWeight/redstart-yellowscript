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
import { buildWorkspaceContext } from './tools/workspace-context.ts'
import * as nodeFs from 'node:fs'
import { PLAN_DIR, PLAN_FILE } from './chat/plan-file.ts'
import { ContextTracker } from './agent/context-budget.ts'
import { DEFAULT_MAX_ITERATIONS } from './agent/loop.ts'
import type { HostMessage, SessionSnapshot } from './chat/protocol.ts'
import { NestClient } from './nest/client.ts'
import { SecretCredentialStore, WorkspaceStateStore } from './storage.ts'
import { StatusBar } from './ui/status-bar.ts'
import { ChatViewProvider, type Surface } from './ui/chat-view.ts'
import { diagnosticsAfterWrite, symbolProvider, workspaceRoots, approvalStore } from './ui/tool-providers.ts'
import { makeApprovalGate, checkpointForWorkspace } from './ui/write-approval.ts'
import type { PendingCommand } from './tools/types.ts'
import { classifyCommand, type CommandContext } from './tools/safe-commands.ts'
import { nodeCommandContext } from './tools/command-context.ts'
import { usableReadRoots } from './tools/read-scope.ts'
import { AttentionTracker, LONG_RUN_MS } from './chat/attention.ts'
import { attachmentLabel } from './chat/attachments.ts'
import type { AttachmentView } from './chat/protocol.ts'
import { makeCommandGate } from './ui/run-command.ts'
import { describeRunning } from './tools/background-processes.ts'
import { AUTH_PROVIDER_ID, RedstartAuthProvider } from './ui/auth-provider.ts'
import { conversationStore } from './ui/conversation-store.ts'
import { createProjects, type Projects } from './host/projects.ts'
import { createTasks, type Tasks } from './host/tasks.ts'
import { FIX_DIAGNOSTIC_COMMAND, createEditorActions, type EditorActions } from './host/editor-actions.ts'
import { createConnectionCommands, loggedDiscovery, type ConnectionCommands } from './host/connection-commands.ts'
import { config, extraReadRoots } from './host/config.ts'
import { createTooling, type Tooling } from './host/tooling.ts'
import { createSurfaces, type Surfaces } from './host/surfaces.ts'

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
/** One ChatSession per conversation, keyed by conversation id. Tabs own their
 *  own transcript and request lifecycle, so switching tabs is a pure view
 *  change and a running turn keeps streaming in its own tab. */
let sessions = new Map<string, ChatSession>()
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
    send: (from, text, workflow) => sendTo(from, text, workflow),
  })

  tooling = createTooling({
    log: output,
    roots: workspaceRoots,
    broadcast: (message) => chatView?.broadcast(message),
    askerFor: (conversationId) => sessions.get(conversationId)?.askApproval,
    projectId: () => projects.linked()?.id,
  })
  context.subscriptions.push(...tooling.disposables)

  editorActions = createEditorActions({
    roots: workspaceRoots,
    symbols: symbolProvider,
    post: (to, message) => chatView?.postTo(to, message),
    revealTarget: () => surfaces.revealTarget(),
    send: (surface, text, attachments) => sendTo(surface, text, undefined, attachments),
  })

  surfaces = createSurfaces({
    view: () => chatView,
    conversations,
    account: () => connection.account(),
    sessions: {
      find: (id) => sessions.get(id),
      get: getSession,
      snapshot,
      drop: (id) => {
        sessions.get(id)?.abort()
        sessions.delete(id)
      },
    },
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
      void editorActions.resolveAttachments(from, attachments ?? []).then((resolved) => sendTo(from, text, undefined, resolved))
    },
    onSearchFiles: (from, query) => {
      void editorActions.searchFiles(query).then((paths) => chatView?.postTo(from, { type: 'fileMatches', query, paths }))
    },
    onAbort: (from) => {
      if (from.conversationId) getSession(from.conversationId).abort()
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
      if (from.conversationId) getSession(from.conversationId).dismissInterrupted()
    },
    onOpenTaskDiff: (from, turnId, file) => {
      if (from.conversationId) void tasks.openDiff(getSession(from.conversationId).runOf(turnId) ?? [], file)
    },
    onRevertTask: (from, turnId) => {
      if (from.conversationId) void tasks.revert(getSession(from.conversationId).runOf(turnId) ?? [])
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
      const id = attention.firstWaiting()
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
      surfaces.pushSession()
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
        return buildWorkspaceContext(root, undefined, {
          tools: tooling.current().names,
          project: projects.linked()?.name ?? null,
        })
      },
      liveState: () => describeRunning(tooling.processes.list()),
      maxTurns: () => config().get<number>('agent.maxTurns') ?? DEFAULT_MAX_ITERATIONS,
      onContextTrimmed: (report) => {
        output?.info(
          `context: trimmed to fit (~${report.before} → ~${report.after} of ${report.usable ?? '?'} usable tokens; ` +
            `${report.stubbed} old results stubbed, ${report.shrunk} calls shrunk, ${report.capped} messages capped)` +
            (report.overLimit ? '  [STILL OVER the window]' : ''),
        )
      },
      onUnauthorized: () => manager?.handleUnauthorized(),
      tools: () => (workspaceRoots().length > 0 ? tooling.current() : null),
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
        makeCommandGate({
          channel: tooling.commandChannel,
          processes: tooling.processes,
          ask: (request) => getSession(id).askApproval(request),
          classify: (command) => classifyCommand(command.command, commandContextFor(id, command)),
          conversationId: id,
          nonInteractive: () => config().get<boolean>('commands.nonInteractive') !== false,
        })(pending),
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
          if (took !== null && took > LONG_RUN_MS) surfaces.notifyUnwatched(id, `finished after ${Math.round(took / 60_000)} min`)
        } else if (message.type === 'conversationState') {
          const news = attention.update(id, message.state)
          statusBar?.setWaiting(attention.count)
          if (news) surfaces.notifyUnwatched(id, `is waiting for ${news}`)
        }
        // Only the views showing this chat; the others are on their own.
        chatView?.postToConversation(id, message)
        // The tab strip's busy dots and an editor tab's title follow the run.
        if (
          (message.type === 'message' && message.message.role === 'user' && !message.message.pending) ||
          message.type === 'turn/completed' ||
          message.type === 'turn/failed'
        ) {
          surfaces.pushConversations()
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
  if (!surface.conversationId) surfaces.showIn(surface, surfaces.create().id)
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
  surfaces.pushConversations()
  surfaces.pushSession()
  void finished.then(() => {
    surfaces.pushConversations()
    surfaces.pushSession()
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

function titleFor(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, ' ')
  return cleaned.length <= 40 ? cleaned : cleaned.slice(0, 37).trimEnd() + '…'
}

async function openSettingsCommand(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', 'redstartYellowscript')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Which conversations wait on the person, and how long runs take. */
const attention = new AttentionTracker()

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
