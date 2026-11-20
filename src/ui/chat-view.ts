// =============================================================================
// The sidebar chat view.
// =============================================================================
// Owns the webview's HTML shell and the message pump in both directions. It
// holds no conversation state — ChatSession does — so a view that VSCode
// destroys and rebuilds simply asks for a fresh snapshot.
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

export interface ChatViewHandlers {
  onSend: (text: string, attachments?: AttachmentView[]) => void
  onSearchFiles: (query: string) => void
  onAbort: () => void
  onNewConversation: () => void
  onListConversations: () => void
  onSwitchConversation: (id: string) => void
  onCreateConversation: () => void
  onDeleteConversation: (id: string) => void
  onSaveDraft: (id: string, text: string) => void
  onRunCommand: (command: 'connect' | 'signIn' | 'showStatus') => void
  onSignIn: (message: { method: 'password'; username: string; password: string } | { method: 'apiKey'; key: string } | { method: 'clientKey' }) => void
  /** Called when the webview announces itself, so the host can reply with a
   *  full snapshot. Fires again every time VSCode rebuilds a view it destroyed
   *  while hidden. */
  onReady: () => void
  onOpenHistory: () => void
  onSearchHistory: (query: string) => void
  onDeleteHistory: (id: string) => void
  onRestoreHistory: (id: string) => void
  onOpenPage: (page: PageName) => void
  onLinkProject: (id: string | null) => void
  onCreateProject: (name: string) => void
  onRunWorkflow: (name: string, args: Record<string, string>) => void
  onAnswer: (id: string, answer: AnswerView | null) => void
  onApprove: (id: string, choice: string) => void
  onOpenApprovalDiff: (id: string, index: number) => void
  onClearPlan: () => void
  onContinueAtLimit: (go: boolean) => void
  onOpenTaskDiff: (turnId: string, path: string) => void
  onRevertTask: (turnId: string) => void
  onResumeTask: (restart: boolean) => void
  onDismissInterrupted: () => void
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.WebviewPanelSerializer {
  static readonly viewType = 'redstartYellowscript.chat'
  /** The same chat, opened as an editor tab. */
  static readonly panelType = 'redstartYellowscript.chatPanel'

  private readonly extensionUri: vscode.Uri
  private readonly handlers: ChatViewHandlers
  private view: vscode.WebviewView | undefined
  private panel: vscode.WebviewPanel | undefined
  /** Every live webview (the sidebar view, the editor tab). Each renders the
   *  same host state, so every message goes to all of them. */
  private readonly webviews = new Set<vscode.Webview>()

  constructor(extensionUri: vscode.Uri, handlers: ChatViewHandlers) {
    this.extensionUri = extensionUri
    this.handlers = handlers
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    // Held here, not read back in onDidDispose: `view.webview` throws
    // "Webview is disposed" once the view is gone.
    const webview = view.webview
    this.attach(webview)
    view.onDidDispose(() => {
      this.webviews.delete(webview)
      if (this.view === view) this.view = undefined
    })
  }

  /**
   * Open the chat as an editor tab, or bring the open one forward. One tab at
   * a time: a second would only be the same chat twice.
   */
  openInEditor(): void {
    if (this.panel) {
      try {
        this.panel.reveal()
        return
      } catch {
        // Disposed without our handler hearing about it: open a new one.
        this.panel = undefined
      }
    }
    const panel = vscode.window.createWebviewPanel(
      ChatViewProvider.panelType,
      'Yellowscript',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      // Kept alive while hidden, like the sidebar view: a streaming turn keeps
      // painting in a tab the person has switched away from.
      { retainContextWhenHidden: true },
    )
    this.adoptPanel(panel)
  }

  /** VSCode reopening the tab after a window reload. */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
    this.adoptPanel(panel)
  }

  private adoptPanel(panel: vscode.WebviewPanel): void {
    const previous = this.panel
    this.panel = panel
    if (previous) {
      try {
        previous.dispose()
      } catch {
        // Already gone; its own onDidDispose has tidied up.
      }
    }
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'yellowscript.svg')
    // Held here, not read back in onDidDispose: `panel.webview` throws
    // "Webview is disposed" once the panel is closed, which used to abort this
    // handler before `this.panel` was cleared — so the next open revealed a
    // dead panel and failed with the same error.
    const webview = panel.webview
    this.attach(webview)
    panel.onDidDispose(() => {
      this.webviews.delete(webview)
      if (this.panel === panel) this.panel = undefined
    })
  }

  /** Lock a webview down, give it the page, and route what it posts. */
  private attach(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media'), vscode.Uri.joinPath(this.extensionUri, 'dist')],
    }
    webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseWebviewMessage(raw)
      if (!message) return
      this.dispatch(message)
    })
    webview.html = this.buildHtml(webview)
    this.webviews.add(webview)
  }

  private dispatch(message: WebviewMessage): void {
    switch (message.type) {
      case 'ready':
        this.handlers.onReady()
        break
      case 'send':
        this.handlers.onSend(message.text, message.attachments)
        break
      case 'searchFiles':
        this.handlers.onSearchFiles(message.query)
        break
      case 'abort':
        this.handlers.onAbort()
        break
      case 'newConversation':
        this.handlers.onNewConversation()
        break
      case 'listConversations':
        this.handlers.onListConversations()
        break
      case 'switchConversation':
        this.handlers.onSwitchConversation(message.id)
        break
      case 'createConversation':
        this.handlers.onCreateConversation()
        break
      case 'deleteConversation':
        this.handlers.onDeleteConversation(message.id)
        break
      case 'saveDraft':
        this.handlers.onSaveDraft(message.id, message.text)
        break
      case 'runCommand':
        this.handlers.onRunCommand(message.command)
        break
      case 'signIn':
        this.handlers.onSignIn(message)
        break
      case 'openHistory':
        this.handlers.onOpenHistory()
        break
      case 'searchHistory':
        this.handlers.onSearchHistory(message.query)
        break
      case 'deleteHistory':
        this.handlers.onDeleteHistory(message.id)
        break
      case 'restoreHistory':
        this.handlers.onRestoreHistory(message.id)
        break
      case 'loadPage':
        this.handlers.onOpenPage(message.page)
        break
      case 'linkProject':
        this.handlers.onLinkProject(message.id)
        break
      case 'createProject':
        this.handlers.onCreateProject(message.name)
        break
      case 'runWorkflow':
        this.handlers.onRunWorkflow(message.name, message.args)
        break
      case 'answer':
        this.handlers.onAnswer(message.id, message.answer)
        break
      case 'approve':
        this.handlers.onApprove(message.id, message.choice)
        break
      case 'openApprovalDiff':
        this.handlers.onOpenApprovalDiff(message.id, message.index)
        break
      case 'clearPlan':
        this.handlers.onClearPlan()
        break
      case 'continueAtLimit':
        this.handlers.onContinueAtLimit(message.go)
        break
      case 'openTaskDiff':
        this.handlers.onOpenTaskDiff(message.turnId, message.path)
        break
      case 'revertTask':
        this.handlers.onRevertTask(message.turnId)
        break
      case 'resumeTask':
        this.handlers.onResumeTask(message.restart)
        break
      case 'dismissInterrupted':
        this.handlers.onDismissInterrupted()
        break
    }
  }

  /** Post to every open webview. A no-op when none is open, which is the
   *  common case: the extension activates long before anyone looks at it. */
  post(message: HostMessage): void {
    for (const webview of this.webviews) {
      // A webview disposed between its close and our onDidDispose handler
      // rejects (or throws); drop it rather than surface the error.
      try {
        void Promise.resolve(webview.postMessage(message)).catch(() => this.webviews.delete(webview))
      } catch {
        this.webviews.delete(webview)
      }
    }
  }

  /** Bring the chat into view: the editor tab when one is open, else the sidebar. */
  async reveal(): Promise<void> {
    if (this.panel) {
      try {
        this.panel.reveal(undefined, false)
        return
      } catch {
        this.panel = undefined
      }
    }
    if (this.view) {
      this.view.show(true)
      return
    }
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`)
  }

  sendInit(session: SessionSnapshot, messages: ChatMessageView[], conversationId: string | null, state: ConversationState): void {
    this.post({ type: 'init', protocolVersion: PROTOCOL_VERSION, session, messages, conversationId, state })
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
