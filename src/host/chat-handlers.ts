// =============================================================================
// What each message from a chat view does: the routing from the webview to
// the modules that own the answer.
// =============================================================================
// Every handler is told which surface the message came from; one that acts on
// a chat acts on that surface's conversation. Nothing is decided here beyond
// which module to call.
//
// No `vscode` import.
// =============================================================================

import type { HostMessage } from '../chat/protocol.ts'
import type { ChatViewHandlers, Surface } from '../ui/chat-view.ts'
import type { ConversationStore } from '../ui/conversation-store.ts'
import type { ConnectionCommands } from './connection-commands.ts'
import type { EditorActions } from './editor-actions.ts'
import type { Projects } from './projects.ts'
import type { Sessions } from './sessions.ts'
import type { Settings } from './settings.ts'
import type { Surfaces } from './surfaces.ts'
import type { Tasks } from './tasks.ts'
import type { Tooling } from './tooling.ts'

export interface ChatHandlersDeps {
  sessions: Pick<Sessions, 'get' | 'send'>
  surfaces: Pick<
    Surfaces,
    | 'pushSession'
    | 'pushConversations'
    | 'newIn'
    | 'switchTo'
    | 'close'
    | 'openInEditor'
    | 'ready'
    | 'openHistory'
    | 'searchHistory'
    | 'deleteForever'
    | 'restore'
    | 'closed'
  >
  projects: Pick<Projects, 'push' | 'pushWorkflows' | 'link' | 'create' | 'runWorkflow'>
  connection: Pick<ConnectionCommands, 'applyServerUrl' | 'signInFromPanel'>
  editorActions: Pick<EditorActions, 'resolveAttachments' | 'searchFiles'>
  tasks: Pick<Tasks, 'openDiff' | 'revert'>
  settings: Pick<Settings, 'push' | 'update'>
  tooling: Pick<Tooling, 'restart'>
  conversations: Pick<ConversationStore, 'setDraft'>
  post: (to: Surface, message: HostMessage) => void
  /** Run one of the extension's commands (the login screen's buttons). */
  runCommand: (command: 'connect' | 'signIn' | 'showStatus') => void
}

export function chatViewHandlers(deps: ChatHandlersDeps): ChatViewHandlers {
  const { sessions, surfaces, projects, tasks } = deps
  /** The session of the chat on the surface a message came from. */
  const sessionOn = (from: Surface) => (from.conversationId ? sessions.get(from.conversationId) : undefined)

  return {
    onSend: (from, text, attachments) => {
      void deps.editorActions.resolveAttachments(from, attachments ?? []).then((resolved) => sessions.send(from, text, undefined, resolved))
    },
    onSearchFiles: (from, query) => {
      void deps.editorActions.searchFiles(query).then((paths) => deps.post(from, { type: 'fileMatches', query, paths }))
    },
    onAbort: (from) => {
      sessionOn(from)?.abort()
      surfaces.pushSession()
    },
    onNewConversation: (from) => surfaces.newIn(from),
    onListConversations: () => surfaces.pushConversations(),
    onSwitchConversation: (from, id) => surfaces.switchTo(from, id),
    onDeleteConversation: (_from, id) => surfaces.close(id),
    onSaveDraft: (id, text) => {
      deps.conversations.setDraft(id, text)
    },
    onRunCommand: (command) => deps.runCommand(command),
    onSetServerUrl: (url) => {
      void deps.connection.applyServerUrl(url)
    },
    onSignIn: (message) => {
      void deps.connection.signInFromPanel(message)
    },
    onReady: (from, restoredId) => surfaces.ready(from, restoredId),
    onOpenHistory: (from) => surfaces.openHistory(from),
    onOpenPage: (from, page) => {
      if (page === 'projects') void projects.push(from)
      else if (page === 'settings') deps.settings.push(from)
      else void projects.pushWorkflows(from)
    },
    onUpdateSetting: (from, key, value) => {
      void deps.settings.update(from, key, value)
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
      sessionOn(from)?.answer(id, answer)
    },
    onApprove: (from, id, choice) => {
      sessionOn(from)?.approve(id, choice)
    },
    onOpenApprovalDiff: (from, id, index) => {
      sessionOn(from)?.openApprovalFile(id, index)
    },
    onClearPlan: (from) => {
      sessionOn(from)?.clearPlan()
    },
    onContinueAtLimit: (from, go) => {
      sessionOn(from)?.continueAtLimit(go)
    },
    onResumeTask: (from, restart) => {
      const session = sessionOn(from)
      if (!session) return
      // Clicking "Restart and continue" is the person's go-ahead for them.
      const resumed = session.resumeInterrupted()
      if (!resumed) return
      if (restart) for (const p of resumed.processes) deps.tooling.restart(p)
      void resumed.sent
    },
    onDismissInterrupted: (from) => {
      sessionOn(from)?.dismissInterrupted()
    },
    onOpenTaskDiff: (from, turnId, file) => {
      const session = sessionOn(from)
      if (session) void tasks.openDiff(session.runOf(turnId) ?? [], file)
    },
    onRevertTask: (from, turnId) => {
      const session = sessionOn(from)
      if (session) void tasks.revert(session.runOf(turnId) ?? [])
    },
    onSearchHistory: (from, query) => surfaces.searchHistory(from, query),
    onDeleteHistory: (from, id) => surfaces.deleteForever(from, id),
    onRestoreHistory: (from, id) => surfaces.restore(from, id),
    onSurfaceClosed: (surface) => surfaces.closed(surface),
  }
}
