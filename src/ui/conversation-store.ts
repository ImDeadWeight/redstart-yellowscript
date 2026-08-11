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
   *  created before account tracking existed (migrated on first auth). */
  accountId: string
  /** Last time the conversation was active (read or written). Used for
   *  history ordering and the 14-day prune. */
  lastAccessedAt: number
  /** True when the tab was closed — the conversation survives in history but
   *  no longer appears in the active tab strip. */
  archived?: boolean
}

export interface HistoryEntry {
  id: string
  title: string
  lastAccessedAt: number
  messageCount: number
}

export interface ConversationStore {
  /** Active (non-archived) conversations, filtered by account when provided. */
  list(accountId?: string): Conversation[]
  /** All conversations for an account, including archived, newest first. */
  history(accountId: string): HistoryEntry[]
  get(id: string): Conversation | undefined
  save(conversation: Conversation): void
  create(title: string, messages?: ChatMessageView[], accountId?: string): Conversation
  delete(id: string): void
  /** Move a conversation to history without destroying it. */
  archive(id: string): void
  /** Bring an archived conversation back to the active tab strip. */
  unarchive(id: string): void
  clear(): void
  prune(olderThanDays: number): number
  search(accountId: string, query: string): Conversation[]
  /** Re-tag all conversations with empty accountId to the given account. */
  migrateAccountId(accountId: string): number
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
      archived: c.archived ?? false,
    }))
  }

  const writeAll = (conversations: Conversation[]): void => {
    void memento.update(STORE_KEY, conversations)
  }

  return {
    list(accountId?: string) {
      const all = readAll()
        .filter((c) => !c.archived)
        .map((c) => (typeof c.order === 'number' ? c : { ...c, order: orderOf(c) }))
        .sort((a, b) => a.order - b.order)
      if (!accountId) return all
      return all.filter((c) => c.accountId === accountId)
    },

    history(accountId: string) {
      return readAll()
        .filter((c) => c.accountId === accountId && c.archived)
        .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
        .map((c) => ({
          id: c.id,
          title: c.title,
          lastAccessedAt: c.lastAccessedAt,
          messageCount: c.messages.length,
        }))
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
      const active = readAll().filter((c) => !c.archived)
      const nextOrder = active.reduce((max, c) => Math.max(max, orderOf(c)), -1) + 1
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

    archive(id: string) {
      const all = readAll()
      const idx = all.findIndex((c) => c.id === id)
      if (idx >= 0) {
        const conv = all[idx]!
        all[idx] = { ...conv, archived: true, lastAccessedAt: Date.now() }
        writeAll(all)
      }
    },

    unarchive(id: string) {
      const all = readAll()
      const idx = all.findIndex((c) => c.id === id)
      if (idx >= 0) {
        const conv = all[idx]!
        all[idx] = { ...conv, archived: false, lastAccessedAt: Date.now() }
        writeAll(all)
      }
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

    migrateAccountId(accountId: string) {
      const all = readAll()
      let count = 0
      const updated = all.map((c) => {
        if (c.accountId === '') {
          count++
          return { ...c, accountId }
        }
        return c
      })
      writeAll(updated)
      return count
    },
  }
}
