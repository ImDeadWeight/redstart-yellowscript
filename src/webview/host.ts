// The one door to the extension host. The webview never makes a network
// request and never holds a credential (protocol.ts rule 4): it only posts
// what the person did.

import type { WebviewMessage } from '../chat/protocol.ts'

declare function acquireVsCodeApi(): { postMessage(message: unknown): void }

const api = acquireVsCodeApi()

export function post(message: WebviewMessage): void {
  api.postMessage(message)
}
