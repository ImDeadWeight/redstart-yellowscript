// =============================================================================
// Composer drafts, one per conversation.
// =============================================================================
// What the person has typed and not sent is kept per tab and mirrored to the
// host, so it survives a tab switch, a page change that unmounts the composer,
// and closing the tab (a closed chat with a draft goes to history; one with
// nothing in it is deleted). Saves to the host are debounced; `flushDraft`
// sends a pending one at once, before anything that depends on it.
// =============================================================================

import { post } from './host.ts'

const local = new Map<string, string>()
let pending: { id: string; text: string } | null = null
let timer: ReturnType<typeof setTimeout> | undefined

const SAVE_DELAY_MS = 400

/** The draft for a conversation: this webview's copy, else the host's. */
export function draftFor(id: string, fromHost: string | undefined): string {
  return local.get(id) ?? fromHost ?? ''
}

/** True when this webview has its own copy of a conversation's draft. */
export function hasLocalDraft(id: string): boolean {
  return local.has(id)
}

/** Record a change to a conversation's draft; saved to the host shortly. */
export function setDraft(id: string, text: string): void {
  // Nothing stored counts as empty, so mounting on a blank composer does
  // not overwrite a draft the host has not sent yet.
  if ((local.get(id) ?? '') === text) return
  local.set(id, text)
  if (pending && pending.id !== id) flushDraft()
  pending = { id, text }
  clearTimeout(timer)
  timer = setTimeout(flushDraft, SAVE_DELAY_MS)
}

/** Send any pending save now. */
export function flushDraft(): void {
  clearTimeout(timer)
  if (!pending) return
  const { id, text } = pending
  pending = null
  post({ type: 'saveDraft', id, text })
}
