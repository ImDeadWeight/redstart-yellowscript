// The one door to the extension host. The webview never makes a network
// request and never holds a credential (protocol.ts rule 4): it only posts
// what the person did.

import type { WebviewMessage } from '../chat/protocol.ts'

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

const api = acquireVsCodeApi()

export function post(message: WebviewMessage): void {
  api.postMessage(message)
}

/** The conversation this view showed last. VSCode keeps it across the view
 *  being rebuilt and across a window reload, which is how an editor tab
 *  reopens on its own chat. */
export function savedConversationId(): string | undefined {
  const state = api.getState()
  const id = state && typeof state === 'object' ? (state as { conversationId?: unknown }).conversationId : undefined
  return typeof id === 'string' ? id : undefined
}

export function saveConversationId(conversationId: string | null): void {
  api.setState(conversationId ? { conversationId } : {})
}
