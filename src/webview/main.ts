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
import { post } from './host.ts'
import { view } from './store.svelte.ts'

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  view.apply(event.data)
})

const target = document.getElementById('app')
if (!target) throw new Error('webview markup is missing #app')
mount(App, { target })

post({ type: 'ready', protocolVersion: PROTOCOL_VERSION })
