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
  type ChatMessageView,
  type HostMessage,
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
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'redstartYellowscript.chat'

  private readonly extensionUri: vscode.Uri
  private readonly handlers: ChatViewHandlers
  private view: vscode.WebviewView | undefined

  constructor(extensionUri: vscode.Uri, handlers: ChatViewHandlers) {
    this.extensionUri = extensionUri
    this.handlers = handlers
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media'), vscode.Uri.joinPath(this.extensionUri, 'dist')],
    }

    view.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseWebviewMessage(raw)
      if (!message) return
      this.dispatch(message)
    })

    view.webview.html = this.buildHtml(view.webview)

    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined
    })
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
    }
  }

  /** Post to the webview. A no-op when the panel has never been opened, which
   *  is the common case — the extension activates long before the user looks
   *  at the sidebar. */
  post(message: HostMessage): void {
    void this.view?.webview.postMessage(message)
  }

  /** Bring the panel into focus (used by the "new chat" command). */
  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show(true)
      return
    }
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`)
  }

  sendInit(session: SessionSnapshot, messages: ChatMessageView[], conversationId: string | null): void {
    this.post({ type: 'init', protocolVersion: PROTOCOL_VERSION, session, messages, conversationId })
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = makeNonce()
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'))
    const styles = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'))

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
<title>Yellowscript</title>
</head>
<body>
<div id="tab-strip" class="tab-strip"></div>
<div id="banner" hidden></div>
<div id="transcript"></div>
<div id="login-screen" hidden></div>
<div id="composer">
  <textarea id="prompt" rows="2" placeholder="Connect to a Redstart Nest to start." disabled></textarea>
  <div id="actions">
    <button id="new" type="button" title="Start a new conversation">New</button>
    <button id="stop" type="button" hidden>Stop</button>
    <button id="send" type="button" disabled>Send</button>
  </div>
</div>
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
