// =============================================================================
// The chat views: chats opened as editor tabs.
// =============================================================================
// Owns the webviews' HTML shell and the message pump in both directions. Each
// webview is a Surface with its own conversation on screen, so two of them
// never mirror each other. It holds no transcript — ChatSession does — so a
// view that VSCode destroys and rebuilds simply asks for a fresh snapshot.
//
// The webview is locked down: a strict nonce-based CSP, no external origins of
// any kind, and `localResourceRoots` limited to our own media directory. The
// panel renders model output, so it is treated as a hostile document.
// =============================================================================

import * as vscode from 'vscode'
import { randomBytes } from 'node:crypto'

import {
  PROTOCOL_VERSION,
  parseWebviewMessage,
  type AnswerView,
  type AttachmentView,
  type ChatMessageView,
  type ConversationState,
  type HostMessage,
  type PageName,
  type SessionSnapshot,
  type WebviewMessage,
} from '../chat/protocol.ts'

/**
 * One place the chat is drawn: a chat opened as an editor tab. It is a real VSCode editor: it can be dragged to another
 * group, split, or moved to its own window, and it reopens on its chat after a
 * reload.
 */
export interface Surface {
  readonly id: string
  /** The conversation on screen here. */
  conversationId: string | null
}

/** Every handler that acts on a chat is told which surface the message came from. */
export interface ChatViewHandlers {
  onSend: (from: Surface, text: string, attachments?: AttachmentView[]) => void
  onSearchFiles: (from: Surface, query: string) => void
  onAbort: (from: Surface) => void
  onNewConversation: (from: Surface) => void
  onListConversations: (from: Surface) => void
  onSwitchConversation: (from: Surface, id: string) => void
  onDeleteConversation: (from: Surface, id: string) => void
  onSaveDraft: (id: string, text: string) => void
  onRunCommand: (command: 'connect' | 'signIn' | 'showStatus') => void
  onSetServerUrl: (url: string) => void
  onSignIn: (message: { method: 'password'; username: string; password: string } | { method: 'apiKey'; key: string } | { method: 'clientKey' }) => void
  /** Called when a webview announces itself, so the host can reply with a full
   *  snapshot. Fires again every time VSCode rebuilds a view it destroyed while
   *  hidden. `restoredId` is the conversation it showed before. */
  onReady: (from: Surface, restoredId: string | undefined) => void
  onOpenHistory: (from: Surface) => void
  onSearchHistory: (from: Surface, query: string) => void
  onDeleteHistory: (from: Surface, id: string) => void
  onRestoreHistory: (from: Surface, id: string) => void
  onOpenPage: (from: Surface, page: PageName) => void
  onLinkProject: (from: Surface, id: string | null) => void
  onCreateProject: (from: Surface, name: string) => void
  onRunWorkflow: (from: Surface, name: string, args: Record<string, string>) => void
  onUpdateSetting: (from: Surface, key: string, value: unknown) => void
  onAnswer: (from: Surface, id: string, answer: AnswerView | null) => void
  onApprove: (from: Surface, id: string, choice: string) => void
  onOpenApprovalDiff: (from: Surface, id: string, index: number) => void
  onClearPlan: (from: Surface) => void
  onContinueAtLimit: (from: Surface, go: boolean) => void
  onOpenTaskDiff: (from: Surface, turnId: string, path: string) => void
  /** Open in Redstart on an artifact card: the link Nest put in the result. */
  onOpenArtifact: (from: Surface, turnId: string, id: string) => void
  onRevertTask: (from: Surface, turnId: string) => void
  onResumeTask: (from: Surface, restart: boolean) => void
  onDismissInterrupted: (from: Surface) => void
  /** The person closed an editor tab. */
  onSurfaceClosed: (surface: Surface) => void
}

interface Live {
  surface: Surface
  webview: vscode.Webview
  /** Set for editor tabs. */
  panel?: vscode.WebviewPanel
  /** Last time it was focused or used, to pick where a command lands. */
  touchedAt: number
  /** Its page has said `ready`. Until then what is posted waits in `queue`:
   *  a webview drops messages sent before its script listens, and a command
   *  (Open Settings, Add Selection) can open a tab and post to it at once. */
  loaded: boolean
  queue: HostMessage[]
}

export class ChatViewProvider implements vscode.WebviewPanelSerializer {
  /** A chat opened as an editor tab. */
  static readonly panelType = 'redstartYellowscript.chatPanel'

  private readonly extensionUri: vscode.Uri
  private readonly handlers: ChatViewHandlers
  private readonly live = new Map<string, Live>()
  private nextId = 0

  constructor(extensionUri: vscode.Uri, handlers: ChatViewHandlers) {
    this.extensionUri = extensionUri
    this.handlers = handlers
  }

  // ---- surfaces -------------------------------------------------------------

  surfaces(): Surface[] {
    return [...this.live.values()].map((l) => l.surface)
  }

  /** The editor tab showing this conversation, if one is. */
  editorFor(conversationId: string): Surface | undefined {
    for (const l of this.live.values()) {
      if (l.surface.conversationId === conversationId) return l.surface
    }
    return undefined
  }

  /** The editor tab in front, if it is one of ours. */
  activeEditor(): Surface | undefined {
    for (const l of this.live.values()) {
      try {
        if (l.panel?.active) return l.surface
      } catch {
        // Disposed.
      }
    }
    return undefined
  }

  /** Where a command with no surface of its own lands: the chat used last. */
  focused(): Surface | undefined {
    let best: Live | undefined
    for (const l of this.live.values()) if (!best || l.touchedAt > best.touchedAt) best = l
    return best?.surface
  }

  /** Open a conversation in a new editor tab. */
  openEditor(conversationId: string, title: string): Surface {
    const panel = vscode.window.createWebviewPanel(
      ChatViewProvider.panelType,
      title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      // Kept alive while hidden: a streaming turn keeps
      // painting in a tab the person has switched away from.
      { retainContextWhenHidden: true },
    )
    return this.adoptPanel(panel, conversationId)
  }

  /** VSCode reopening an editor tab after a window reload. `state` is what the
   *  webview saved with setState: the conversation it was showing. */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const saved = state && typeof state === 'object' ? (state as { conversationId?: unknown }).conversationId : undefined
    this.adoptPanel(panel, typeof saved === 'string' ? saved : null)
  }

  private adoptPanel(panel: vscode.WebviewPanel, conversationId: string | null): Surface {
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'yellowscript.svg')
    // Held here, not read back in onDidDispose: `panel.webview` throws
    // "Webview is disposed" once the panel is closed.
    const webview = panel.webview
    const surface: Surface = { id: `editor-${++this.nextId}`, conversationId }
    const entry: Live = { surface, webview, panel, touchedAt: Date.now(), loaded: false, queue: [] }
    this.attach(entry)
    panel.onDidChangeViewState(() => {
      if (panel.active) entry.touchedAt = Date.now()
    })
    panel.onDidDispose(() => {
      // Closed by closeEditor: the caller has already dealt with its chat.
      if (this.live.get(surface.id) !== entry) return
      this.live.delete(surface.id)
      this.handlers.onSurfaceClosed(surface)
    })
    return surface
  }

  /** Close an editor tab without the close counting as the person's (its chat
   *  was deleted). */
  closeEditor(surface: Surface): void {
    const entry = this.live.get(surface.id)
    if (!entry?.panel) return
    this.live.delete(surface.id)
    try {
      entry.panel.dispose()
    } catch {
      // Already gone.
    }
  }

  setTitle(surface: Surface, title: string): void {
    const panel = this.live.get(surface.id)?.panel
    if (!panel) return
    try {
      if (panel.title !== title) panel.title = title
    } catch {
      // Disposed under us.
    }
  }

  /** Lock a webview down, give it the page, and route what it posts. */
  private attach(entry: Live): void {
    const { webview } = entry
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media'), vscode.Uri.joinPath(this.extensionUri, 'dist')],
    }
    webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseWebviewMessage(raw)
      if (!message) return
      // Anything the person did here makes this the chat in use.
      if (message.type !== 'ready' && message.type !== 'saveDraft') entry.touchedAt = Date.now()
      if (message.type === 'ready') {
        // init goes first (onReady sends it), then what waited for the page.
        entry.loaded = true
        this.dispatch(entry.surface, message)
        const waiting = entry.queue
        entry.queue = []
        for (const queued of waiting) this.send(entry, queued)
        return
      }
      this.dispatch(entry.surface, message)
    })
    webview.html = this.buildHtml(webview)
    this.live.set(entry.surface.id, entry)
  }

  private dispatch(from: Surface, message: WebviewMessage): void {
    const h = this.handlers
    switch (message.type) {
      case 'ready':
        h.onReady(from, message.conversationId)
        break
      case 'send':
        h.onSend(from, message.text, message.attachments)
        break
      case 'searchFiles':
        h.onSearchFiles(from, message.query)
        break
      case 'abort':
        h.onAbort(from)
        break
      case 'newConversation':
      case 'createConversation':
        h.onNewConversation(from)
        break
      case 'listConversations':
        h.onListConversations(from)
        break
      case 'switchConversation':
        h.onSwitchConversation(from, message.id)
        break
      case 'deleteConversation':
        h.onDeleteConversation(from, message.id)
        break
      case 'saveDraft':
        h.onSaveDraft(message.id, message.text)
        break
      case 'runCommand':
        h.onRunCommand(message.command)
        break
      case 'setServerUrl':
        h.onSetServerUrl(message.url)
        break
      case 'signIn':
        h.onSignIn(message)
        break
      case 'openHistory':
        h.onOpenHistory(from)
        break
      case 'searchHistory':
        h.onSearchHistory(from, message.query)
        break
      case 'deleteHistory':
        h.onDeleteHistory(from, message.id)
        break
      case 'restoreHistory':
        h.onRestoreHistory(from, message.id)
        break
      case 'loadPage':
        h.onOpenPage(from, message.page)
        break
      case 'linkProject':
        h.onLinkProject(from, message.id)
        break
      case 'createProject':
        h.onCreateProject(from, message.name)
        break
      case 'runWorkflow':
        h.onRunWorkflow(from, message.name, message.args)
        break
      case 'updateSetting':
        h.onUpdateSetting(from, message.key, message.value)
        break
      case 'answer':
        h.onAnswer(from, message.id, message.answer)
        break
      case 'approve':
        h.onApprove(from, message.id, message.choice)
        break
      case 'openApprovalDiff':
        h.onOpenApprovalDiff(from, message.id, message.index)
        break
      case 'clearPlan':
        h.onClearPlan(from)
        break
      case 'continueAtLimit':
        h.onContinueAtLimit(from, message.go)
        break
      case 'openTaskDiff':
        h.onOpenTaskDiff(from, message.turnId, message.path)
        break
      case 'revertTask':
        h.onRevertTask(from, message.turnId)
        break
      case 'openArtifact':
        h.onOpenArtifact(from, message.turnId, message.id)
        break
      case 'resumeTask':
        h.onResumeTask(from, message.restart)
        break
      case 'dismissInterrupted':
        h.onDismissInterrupted(from)
        break
    }
  }

  // ---- posting --------------------------------------------------------------

  /** Post to one surface. */
  postTo(surface: Surface, message: HostMessage): void {
    const entry = this.live.get(surface.id)
    if (entry) this.send(entry, message)
  }

  /** Post to every surface showing this conversation. */
  postToConversation(conversationId: string, message: HostMessage): void {
    for (const entry of this.live.values()) {
      if (entry.surface.conversationId === conversationId) this.send(entry, message)
    }
  }

  /** Post to every surface. A no-op when none is open, which is the common
   *  case: the extension activates long before anyone looks at it. */
  broadcast(message: HostMessage): void {
    for (const entry of this.live.values()) this.send(entry, message)
  }

  private send(entry: Live, message: HostMessage): void {
    if (!entry.loaded) {
      entry.queue.push(message)
      return
    }
    // A webview disposed between its close and our onDidDispose handler
    // rejects (or throws). Its dispose handler tidies up; nothing to surface.
    try {
      void Promise.resolve(entry.webview.postMessage(message)).catch(() => undefined)
    } catch {
      // Disposed.
    }
  }

  /** Bring a surface into view; with none given, the chat used last. */
  async reveal(surface?: Surface): Promise<void> {
    const target = surface ?? this.focused()
    const panel = target ? this.live.get(target.id)?.panel : undefined
    try {
      panel?.reveal(undefined, false)
    } catch {
      // Disposed without our handler hearing about it.
    }
  }

  sendInit(surface: Surface, session: SessionSnapshot, messages: ChatMessageView[], state: ConversationState): void {
    this.postTo(surface, {
      type: 'init',
      protocolVersion: PROTOCOL_VERSION,
      session,
      messages,
      conversationId: surface.conversationId,
      state,
    })
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = makeNonce()
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'))
    const styles = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'))
    // The Svelte components' styles, compiled to a file (see esbuild.mjs).
    const componentStyles = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'))

    // `default-src 'none'` then re-grant only what is needed. The script must
    // carry the nonce, which is why the bundle is a separate file rather than
    // inline — an inline script plus a nonce works, but a file keeps the CSP
    // honest and the bundle cacheable.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      // Attached images are data: URLs, made in the webview itself.
      'img-src data:',
    ].join('; ')

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styles}" rel="stylesheet">
<link href="${componentStyles}" rel="stylesheet">
<title>Yellowscript</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`
  }
}

/** A CSP nonce is a security token — it must not be guessable, so it comes from
 *  the CSPRNG rather than Math.random. */
function makeNonce(): string {
  return randomBytes(24).toString('base64url')
}
