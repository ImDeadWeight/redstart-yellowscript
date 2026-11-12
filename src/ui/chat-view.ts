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
  type ChatMessageView,
  type ConversationState,
  type HostMessage,
  type PageName,
  type SessionSnapshot,
  type WebviewMessage,
} from '../chat/protocol.ts'

export interface ChatViewHandlers {
  onSend: (text: string) => void
  onAbort: () => void
  onNewConversation: () => void
  onListConversations: () => void
  onSwitchConversation: (id: string) => void
  onCreateConversation: () => void
  onDeleteConversation: (id: string) => void
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
  onClearPlan: () => void
  onContinueAtLimit: (go: boolean) => void
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
    this.attach(view.webview)
    view.onDidDispose(() => {
      this.webviews.delete(view.webview)
      if (this.view === view) this.view = undefined
    })
  }

  /**
   * Open the chat as an editor tab, or bring the open one forward. One tab at
   * a time: a second would only be the same chat twice.
   */
  openInEditor(): void {
    if (this.panel) {
      this.panel.reveal()
      return
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
    this.panel?.dispose()
    this.panel = panel
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'yellowscript.svg')
    this.attach(panel.webview)
    panel.onDidDispose(() => {
      this.webviews.delete(panel.webview)
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
        this.handlers.onSend(message.text)
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
      case 'clearPlan':
        this.handlers.onClearPlan()
        break
      case 'continueAtLimit':
        this.handlers.onContinueAtLimit(message.go)
        break
    }
  }

  /** Post to every open webview. A no-op when none is open, which is the
   *  common case: the extension activates long before anyone looks at it. */
  post(message: HostMessage): void {
    for (const webview of this.webviews) void webview.postMessage(message)
  }

  /** Bring the chat into view: the editor tab when one is open, else the sidebar. */
  async reveal(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(undefined, false)
      return
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
