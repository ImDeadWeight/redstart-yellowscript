// The live view state. One $state object, replaced whole by the pure reducer
// in view-model.ts on every host message, so the components stay readers.

import type { AttachmentView, HostMessage } from '../chat/protocol.ts'
import { applyHostMessage, initialViewState, type ViewState } from './view-model.ts'

class ViewStore {
  current: ViewState = $state(initialViewState())
  /** A workflow the Workflows page should open on (picked from `/` with inputs). */
  workflowFocus: string | null = $state(null)

  apply(message: HostMessage): void {
    this.current = applyHostMessage(this.current, message)
  }

  /** Several host messages, one state change: one render for all of them. */
  applyAll(messages: readonly HostMessage[]): void {
    let next = this.current
    for (const message of messages) next = applyHostMessage(next, message)
    this.current = next
  }

  closeHistory(): void {
    this.current = { ...this.current, history: { ...this.current.history, open: false } }
  }

  openPage(page: 'projects' | 'workflows'): void {
    this.current = {
      ...this.current,
      page,
      history: { ...this.current.history, open: false },
      // Show "loading" until the host answers.
      ...(page === 'projects' ? { projects: { ...this.current.projects, items: null } } : {}),
    }
  }

  closePage(): void {
    this.current = { ...this.current, page: null }
    this.workflowFocus = null
  }

  /** Hand the composer the chips the host sent, once. */
  takeInbox(): AttachmentView[] {
    const taken = this.current.inbox
    if (taken.length) this.current = { ...this.current, inbox: [] }
    return taken
  }

  dismissNotice(id: number): void {
    this.current = { ...this.current, notices: this.current.notices.filter((n) => n.id !== id) }
  }
}

export const view = new ViewStore()
