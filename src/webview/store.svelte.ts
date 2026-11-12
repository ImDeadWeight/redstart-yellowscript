// The live view state. One $state object, replaced whole by the pure reducer
// in view-model.ts on every host message, so the components stay readers.

import type { HostMessage } from '../chat/protocol.ts'
import { applyHostMessage, initialViewState, type ViewState } from './view-model.ts'

class ViewStore {
  current: ViewState = $state(initialViewState())

  apply(message: HostMessage): void {
    this.current = applyHostMessage(this.current, message)
  }

  closeHistory(): void {
    this.current = { ...this.current, history: { ...this.current.history, open: false } }
  }

  dismissNotice(id: number): void {
    this.current = { ...this.current, notices: this.current.notices.filter((n) => n.id !== id) }
  }
}

export const view = new ViewStore()
