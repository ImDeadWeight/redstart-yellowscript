// =============================================================================
// Local conversation store — workspace-scoped, survives panel teardown.
// =============================================================================
// VSCode destroys a hidden webview's DOM on hide and rebuilds on reveal. The
// conversation list must outlive that, so it lives in workspace state rather
// than in the webview or in ChatSession.
//
// Backed by `vscode.Memento` so it is per-workspace: a trusted repo and a
// throwaway scratch folder never share tabs.
// =============================================================================

import type * as vscode from 'vscode'
import type { ChatMessageView } from '../chat/protocol.ts'

/** A record's effective tab position. Records written before `order` existed
 *  fall back to `createdAt`; anything still without that sorts to the bottom. */
function orderOf(conversation: { order?: unknown; createdAt?: number }): number {
  return typeof conversation.order === 'number'
    ? conversation.order
    : typeof conversation.createdAt === 'number'
      ? conversation.createdAt
      : 0
}

const STORE_KEY = 'redstartYellowscript.conversations'

export interface Conversation {
  id: string
  title: string
  messages: ChatMessageView[]
  createdAt: number
  /** Tab position. Stable across switches so tabs don't reorder on activation;
   *  drag-and-drop will mutate this later. */
  order: number
}

export interface ConversationStore {
  list(): Conversation[]
  get(id: string): Conversation | undefined
  save(conversation: Conversation): void
  create(title: string, messages?: ChatMessageView[]): Conversation
  delete(id: string): void
  clear(): void
}

export function conversationStore(memento: vscode.Memento): ConversationStore {
  const readAll = (): Conversation[] => {
    const raw = memento.get<Conversation[]>(STORE_KEY)
    return Array.isArray(raw) ? raw : []
  }

  const writeAll = (conversations: Conversation[]): void => {
    void memento.update(STORE_KEY, conversations)
  }

  return {
    list() {
      return readAll()
        .map((c) => (typeof c.order === 'number' ? c : { ...c, order: orderOf(c) }))
        .sort((a, b) => a.order - b.order)
    },

    get(id: string) {
      return readAll().find((c) => c.id === id)
    },

    save(conversation) {
      const all = readAll()
      const idx = all.findIndex((c) => c.id === conversation.id)
      if (idx >= 0) {
        all[idx] = { ...conversation }
      } else {
        all.push({ ...conversation })
      }
      writeAll(all)
    },

    create(title: string, messages: ChatMessageView[] = []) {
      const nextOrder = readAll().reduce((max, c) => Math.max(max, orderOf(c)), -1) + 1
      const conversation: Conversation = {
        id: `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        title,
        messages,
        createdAt: Date.now(),
        order: nextOrder,
      }
      writeAll([...readAll(), conversation])
      return conversation
    },

    delete(id: string) {
      writeAll(readAll().filter((c) => c.id !== id))
    },

    clear() {
      writeAll([])
    },
  }
}
