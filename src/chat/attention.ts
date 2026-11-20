// =============================================================================
// When a run waits on the person, and they are looking elsewhere.
// =============================================================================
// A long run stops at an approval card, a question, or the turn limit, and
// sits there until someone answers. In a window that is not focused nobody
// sees it. This works out, from the conversations' state as the session
// emits it, when one has just started waiting (so it is said once, not on
// every state change), how many are waiting now (the status bar's badge),
// and how long a run took (a long one is worth saying it finished).
//
// Pure: the extension does the notifying. No `vscode`.
// =============================================================================

import type { ConversationState } from './protocol.ts'

export type WaitingFor = 'an approval' | 'an answer' | 'a go-ahead at the turn limit'

/** A run that took longer than this says it finished, when unwatched. */
export const LONG_RUN_MS = 2 * 60_000

export function waitingFor(state: ConversationState): WaitingFor | null {
  if (state.approval) return 'an approval'
  if (state.question) return 'an answer'
  if (state.atTurnLimit) return 'a go-ahead at the turn limit'
  return null
}

export class AttentionTracker {
  private readonly waiting = new Map<string, WaitingFor>()
  private readonly started = new Map<string, number>()

  /** The conversation's new state. Returns what it has just started waiting
   *  for, or null when that is not news. */
  update(conversationId: string, state: ConversationState): WaitingFor | null {
    const now = waitingFor(state)
    const before = this.waiting.get(conversationId) ?? null
    if (now) this.waiting.set(conversationId, now)
    else this.waiting.delete(conversationId)
    return now && now !== before ? now : null
  }

  /** How many conversations wait on the person now. */
  get count(): number {
    return this.waiting.size
  }

  /** The first conversation waiting, for "Show". */
  firstWaiting(): string | null {
    return this.waiting.keys().next().value ?? null
  }

  runStarted(conversationId: string, now = Date.now()): void {
    this.started.set(conversationId, now)
  }

  /** How long the run took, or null when its start was not seen. */
  runEnded(conversationId: string, now = Date.now()): number | null {
    const started = this.started.get(conversationId)
    this.started.delete(conversationId)
    return started === undefined ? null : now - started
  }

  forget(conversationId: string): void {
    this.waiting.delete(conversationId)
    this.started.delete(conversationId)
  }
}
