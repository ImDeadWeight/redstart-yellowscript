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
  /** Account this conversation belongs to. Empty string for conversations
   *  created before account tracking existed (migrated on first read). */
  accountId: string
  /** Last time the conversation was active (read or written). Used for
   *  history ordering and the 14-day prune. */
  lastAccessedAt: number
}

export interface ConversationStore {
  list(accountId?: string): Conversation[]
  get(id: string): Conversation | undefined
  save(conversation: Conversation): void
  create(title: string, messages?: ChatMessageView[], accountId?: string): Conversation
  delete(id: string): void
  clear(): void
  prune(olderThanDays: number): number
  search(accountId: string, query: string): Conversation[]
}

export function conversationStore(memento: vscode.Memento): ConversationStore {
  const readAll = (): Conversation[] => {
    const raw = memento.get<Conversation[]>(STORE_KEY)
    if (!Array.isArray(raw)) return []
    return raw.map((c) => ({
      ...c,
      accountId: c.accountId ?? '',
      lastAccessedAt: c.lastAccessedAt ?? c.createdAt ?? Date.now(),
      order: typeof c.order === 'number' ? c.order : orderOf(c),
    }))
  }

  const writeAll = (conversations: Conversation[]): void => {
    void memento.update(STORE_KEY, conversations)
  }

  return {
    list(accountId?: string) {
      const all = readAll()
        .map((c) => (typeof c.order === 'number' ? c : { ...c, order: orderOf(c) }))
        .sort((a, b) => a.order - b.order)
      if (!accountId) return all
      return all.filter((c) => c.accountId === accountId)
    },

    get(id: string) {
      return readAll().find((c) => c.id === id)
    },

    save(conversation) {
      const all = readAll()
      const idx = all.findIndex((c) => c.id === conversation.id)
      const entry = { ...conversation, lastAccessedAt: Date.now() }
      if (idx >= 0) {
        all[idx] = entry
      } else {
        all.push(entry)
      }
      writeAll(all)
    },

    create(title: string, messages: ChatMessageView[] = [], accountId = '') {
      const nextOrder = readAll().reduce((max, c) => Math.max(max, orderOf(c)), -1) + 1
      const now = Date.now()
      const conversation: Conversation = {
        id: `conv_${now}_${Math.random().toString(36).slice(2, 8)}`,
        title,
        messages,
        createdAt: now,
        order: nextOrder,
        accountId,
        lastAccessedAt: now,
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

    prune(olderThanDays: number) {
      const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000
      const before = readAll()
      const after = before.filter((c) => c.lastAccessedAt >= cutoff)
      writeAll(after)
      return before.length - after.length
    },

    search(accountId: string, query: string) {
      const q = query.trim().toLowerCase()
      if (!q) return this.list(accountId)
      return this.list(accountId).filter((c) => c.title.toLowerCase().includes(q))
    },
  }
}
