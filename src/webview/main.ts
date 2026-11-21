// =============================================================================
// The chat webview — entry point.
// =============================================================================
// A renderer, not a source of truth (protocol.ts rule 1). VSCode destroys a
// hidden view's DOM and rebuilds it on reveal, so this holds nothing it cannot
// be handed again: on `ready` the host replies with `init` and the panel
// redraws from it. The state logic is view-model.ts (tested under node); the
// Svelte components only read it and post what the person did.
//
// Runs in a browser context with no Node APIs, bundled separately from the
// extension entry (see esbuild.mjs).
// =============================================================================

import { mount } from 'svelte'

import { PROTOCOL_VERSION, type HostMessage } from '../chat/protocol.ts'
import App from './components/App.svelte'
import { post, saveConversationId, savedConversationId } from './host.ts'
import { view } from './store.svelte.ts'

// A streaming turn sends a message per token. Rendering each one on its own
// kept the page busy enough that scrolling and clicks queued behind it, so
// they are applied together, at most once a frame.
let saved: string | null | undefined = savedConversationId()
let queued: HostMessage[] = []
let frame = 0

function flush(): void {
  frame = 0
  const batch = queued
  queued = []
  view.applyAll(batch)
  const id = view.current.conversationId
  if (id !== saved) {
    saved = id
    saveConversationId(id)
  }
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  queued.push(event.data)
  // A hidden webview gets no animation frames; a timer still runs there.
  if (!frame) frame = document.hidden ? (setTimeout(flush, 50) as unknown as number) : requestAnimationFrame(flush)
})

const target = document.getElementById('app')
if (!target) throw new Error('webview markup is missing #app')
mount(App, { target })

const restored = savedConversationId()
post(restored ? { type: 'ready', protocolVersion: PROTOCOL_VERSION, conversationId: restored } : { type: 'ready', protocolVersion: PROTOCOL_VERSION })
