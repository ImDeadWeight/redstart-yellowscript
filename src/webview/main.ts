// =============================================================================
// The chat webview.
// =============================================================================
// A renderer, not a source of truth. VSCode destroys a hidden view's DOM and
// rebuilds it on reveal, so this holds no state it cannot be handed again: on
// `ready` the host replies with a full snapshot and everything below redraws
// from it. Anything accumulated here is a cache of what the host already knows.
//
// Runs in a browser context with no Node APIs, bundled separately from the
// extension entry (see esbuild.mjs).
// =============================================================================

import { PROTOCOL_VERSION, type ChatMessageView, type ConversationView, type HostMessage, type SessionSnapshot, type WebviewMessage } from '../chat/protocol.ts'
import { renderMarkdown } from './markdown.ts'
import { renderLoginScreen } from './login-screen.ts'

declare function acquireVsCodeApi(): { postMessage(message: unknown): void }

const vscode = acquireVsCodeApi()

function post(message: WebviewMessage): void {
  vscode.postMessage(message)
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

const transcript = required<HTMLDivElement>('transcript')
const banner = required<HTMLDivElement>('banner')
const loginScreen = required<HTMLDivElement>('login-screen')
const input = required<HTMLTextAreaElement>('prompt')
const sendButton = required<HTMLButtonElement>('send')
const stopButton = required<HTMLButtonElement>('stop')
const newButton = required<HTMLButtonElement>('new')
const composer = required<HTMLDivElement>('composer')
const tabStrip = required<HTMLDivElement>('tab-strip')

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`webview markup is missing #${id}`)
  return element as T
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Live text per streaming turn, so a delta is an append rather than a redraw
 *  of the whole transcript. */
const streams = new Map<string, { content: string; reasoning: string }>()
let session: SessionSnapshot = { connection: 'disconnected', detail: 'Starting…', canSend: false, busy: false, queued: 0 }
let conversations: ConversationView[] = []
let activeConversationId: string | null = null

// History panel state
let historyOpen = false
let historyQuery = ''
let historyItems: readonly { id: string; title: string; lastAccessedAt: number; messageCount: number }[] = []
let historySearchDebounce: ReturnType<typeof setTimeout> | undefined

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTranscript(messages: ChatMessageView[]): void {
  transcript.replaceChildren()
  streams.clear()
  for (const message of messages) transcript.append(buildMessage(message))
  scrollToEnd()
}

/** Add a message, or replace an existing one with the same id. Used when a
 *  queued prompt flips from `pending` to active — the id is stable so the
 *  greyed bubble becomes a real one without duplicating. */
function upsertMessage(message: ChatMessageView): void {
  const existing = findArticle(message.id)
  const node = buildMessage(message)
  if (existing) existing.replaceWith(node)
  else transcript.append(node)
  scrollToEnd(message.role === 'user')
}

function buildMessage(message: ChatMessageView): HTMLElement {
  const article = document.createElement('article')
  article.className = `message ${message.role}` + (message.pending ? ' pending' : '')
  article.dataset.id = message.id

  const header = document.createElement('header')
  header.textContent = message.role === 'user' ? 'You' : 'Yellowscript'
  article.append(header)

  // Reasoning sits above the answer and starts collapsed: it is usually far
  // longer than the answer, and burying the answer under it is the fastest way
  // to make the panel useless.
  const reasoning = document.createElement('details')
  reasoning.className = 'reasoning'
  const summary = document.createElement('summary')
  summary.textContent = 'Thinking'
  const reasoningBody = document.createElement('div')
  reasoningBody.className = 'reasoning-body'
  reasoning.append(summary, reasoningBody)
  reasoning.hidden = !message.reasoning
  article.append(reasoning)

  const body = document.createElement('div')
  body.className = 'body'
  article.append(body)

  const footer = document.createElement('footer')
  article.append(footer)

  streams.set(message.id, { content: message.content, reasoning: message.reasoning ?? '' })
  paint(article, message.content, message.reasoning ?? '')
  paintStatus(article, message)
  return article
}

/** User text is never markdown-rendered — it is shown exactly as typed. */
function paint(article: HTMLElement, content: string, reasoning: string): void {
  const body = article.querySelector<HTMLElement>('.body')
  if (body) {
    if (article.classList.contains('user')) body.textContent = content
    else body.innerHTML = renderMarkdown(content)
  }

  const details = article.querySelector<HTMLDetailsElement>('.reasoning')
  const reasoningBody = article.querySelector<HTMLElement>('.reasoning-body')
  if (details && reasoningBody) {
    details.hidden = reasoning.length === 0
    reasoningBody.textContent = reasoning
  }
}

function paintStatus(article: HTMLElement, message: ChatMessageView): void {
  const footer = article.querySelector<HTMLElement>('footer')
  if (!footer) return
  footer.replaceChildren()

  if (message.error) {
    const error = document.createElement('div')
    error.className = 'error'
    error.textContent = message.error
    footer.append(error)
  }

  if (message.aborted) {
    const note = document.createElement('span')
    note.className = 'note'
    note.textContent = 'Stopped'
    footer.append(note)
  }

  const stats = message.stats
  if (stats?.tokensPerSecond) {
    const note = document.createElement('span')
    note.className = 'note'
    const parts = [`${stats.tokensPerSecond.toFixed(1)} tok/s`]
    if (stats.completionTokens) parts.push(`${stats.completionTokens} tokens`)
    // 'length' means the model ran out of room, which looks like an arbitrary
    // truncation unless it is called out.
    if (stats.finishReason === 'length') parts.push('hit the context limit')
    note.textContent = parts.join(' · ')
    footer.append(note)
  }

  article.classList.toggle('streaming', message.streaming === true)
}

function findArticle(id: string): HTMLElement | null {
  return transcript.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)
}

/** Only auto-scroll when the user is already at the bottom — yanking the view
 *  down while they are reading earlier output is worse than not following. */
function scrollToEnd(force = false): void {
  const distance = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight
  if (force || distance < 80) transcript.scrollTop = transcript.scrollHeight
}

function renderSession(next: SessionSnapshot): void {
  session = next

  const needsAction = next.connection !== 'connected'
  banner.hidden = true
  if (needsAction) {
    loginScreen.hidden = false
    loginScreen.replaceChildren(renderLoginScreen(post, next))
  } else {
    loginScreen.hidden = true
  }

  transcript.hidden = needsAction
  input.hidden = needsAction
  // Sending is allowed while a turn runs — the prompt just queues behind it.
  input.disabled = !next.canSend
  sendButton.hidden = needsAction
  stopButton.hidden = !next.busy
  sendButton.disabled = !next.canSend
  composer.hidden = needsAction
  input.placeholder = !next.canSend
    ? 'Connect to a Redstart Nest to start.'
    : next.queued > 0
      ? `Queued — ${next.queued} prompt${next.queued === 1 ? '' : 's'} waiting…`
      : next.busy
        ? 'Generating — type to queue another prompt…'
        : 'Ask Yellowscript…'
}

function renderConversationList(list: ConversationView[], activeId: string | null): void {
  conversations = list
  activeConversationId = activeId
  tabStrip.replaceChildren()
  for (const conv of list) {
    const tab = document.createElement('button')
    tab.className =
      'tab' + (conv.id === activeId ? ' active' : '') + (conv.busy ? ' busy' : '')
    tab.dataset.id = conv.id

    const label = document.createElement('span')
    label.className = 'tab-label'
    label.textContent = conv.title
    tab.appendChild(label)

    // A small badge shows the conversation is generating and, if anything is
    // queued behind it, how many prompts are waiting.
    if (conv.busy || conv.queued > 0) {
      const badge = document.createElement('span')
      badge.className = 'tab-badge'
      badge.textContent = conv.queued > 0 ? `●${conv.queued}` : '●'
      tab.appendChild(badge)
    }

    const close = document.createElement('button')
    close.className = 'tab-close'
    close.textContent = '×'
    close.title = 'Close conversation'
    close.addEventListener('click', (event) => {
      event.stopPropagation()
      post({ type: 'deleteConversation', id: conv.id })
    })
    tab.appendChild(close)

    tab.addEventListener('click', () => {
      if (conv.id !== activeConversationId) {
        post({ type: 'switchConversation', id: conv.id })
      }
    })

    tabStrip.appendChild(tab)
  }

  const historyButton = document.createElement('button')
  historyButton.className = 'tab tab-history'
  historyButton.textContent = '🕒'
  historyButton.title = 'Conversation history'
  historyButton.addEventListener('click', () => {
    historyOpen = !historyOpen
    historyButton.classList.toggle('active', historyOpen)
    if (historyOpen) {
      post({ type: 'openHistory' })
    } else {
      historyPanel.hidden = true
    }
  })
  tabStrip.appendChild(historyButton)
}

function showNotice(level: 'info' | 'warning' | 'error', text: string): void {
  const notice = document.createElement('div')
  notice.className = `notice ${level}`
  notice.textContent = text
  transcript.append(notice)
  scrollToEnd()
}

// ---------------------------------------------------------------------------
// History panel (combobox dropdown)
// ---------------------------------------------------------------------------

const historyPanel = document.createElement('div')
historyPanel.className = 'history-panel'
historyPanel.hidden = true
tabStrip.after(historyPanel)

const historySearch = document.createElement('input')
historySearch.className = 'history-search'
historySearch.type = 'text'
historySearch.placeholder = 'Search history…'
historySearch.addEventListener('input', () => {
  historyQuery = historySearch.value
  clearTimeout(historySearchDebounce)
  historySearchDebounce = setTimeout(() => {
    post({ type: 'searchHistory', query: historyQuery })
  }, 150)
})
historyPanel.appendChild(historySearch)

const historyList = document.createElement('div')
historyList.className = 'history-list'
historyPanel.appendChild(historyList)

function renderHistoryList(items: readonly { id: string; title: string; lastAccessedAt: number; messageCount: number }[]): void {
  historyItems = items
  historyList.replaceChildren()
  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'history-empty'
    empty.textContent = historyQuery ? 'No matches' : 'No history yet'
    historyList.appendChild(empty)
    return
  }
  for (const item of items) {
    const row = document.createElement('div')
    row.className = 'history-item'

    const info = document.createElement('div')
    info.className = 'history-item-info'
    const title = document.createElement('span')
    title.className = 'history-item-title'
    title.textContent = item.title || 'Untitled'
    const meta = document.createElement('span')
    meta.className = 'history-item-meta'
    const date = new Date(item.lastAccessedAt)
    meta.textContent = `${date.toLocaleDateString()} · ${item.messageCount} messages`
    info.append(title, meta)
    row.appendChild(info)

    const actions = document.createElement('div')
    actions.className = 'history-item-actions'

    const restoreBtn = document.createElement('button')
    restoreBtn.className = 'history-restore'
    restoreBtn.textContent = 'Open'
    restoreBtn.title = 'Open in a new tab'
    restoreBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      post({ type: 'restoreHistory', id: item.id })
    })
    actions.appendChild(restoreBtn)

    const deleteBtn = document.createElement('button')
    deleteBtn.className = 'history-delete'
    deleteBtn.textContent = '×'
    deleteBtn.title = 'Delete from history'
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      post({ type: 'deleteHistory', id: item.id })
    })
    actions.appendChild(deleteBtn)

    row.appendChild(actions)
    row.addEventListener('click', () => {
      post({ type: 'restoreHistory', id: item.id })
    })
    historyList.appendChild(row)
  }
}

document.addEventListener('click', (event) => {
  if (!historyOpen) return
  const target = event.target as HTMLElement
  if (historyPanel.contains(target) || target.closest('.tab-history')) return
  historyOpen = false
  document.querySelector('.tab-history')?.classList.remove('active')
  historyPanel.hidden = true
})

// ---------------------------------------------------------------------------
// Host messages
// ---------------------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data
  switch (message.type) {
    case 'init':
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        showNotice(
          'error',
          'Yellowscript was updated but this panel is running an older version. Reload the window.',
        )
        return
      }
      // The init handoff names which conversation it is rendering, so a reload
      // that reopened on a different tab still lines up.
      if (message.conversationId !== null) activeConversationId = message.conversationId
      renderSession(message.session)
      renderTranscript(message.messages)
      break

    case 'session':
      renderSession(message.session)
      break

    case 'conversation':
      // Only redraw when the host swapped in the conversation we're viewing. A
      // switch is a pure view change; deltas for other tabs are dropped.
      if (message.conversationId !== activeConversationId) break
      renderTranscript(message.messages)
      break

    case 'conversationList':
      renderConversationList(message.conversations, message.activeId)
      break

    case 'activeConversationChanged':
      activeConversationId = message.id
      tabStrip.querySelectorAll('.tab').forEach((tab) => {
        tab.classList.toggle('active', (tab as HTMLElement).dataset.id === message.id)
      })
      break

    case 'message':
      // Transcript messages for a background tab are ignored here; that tab's
      // transcript is persisted by the host and repainted on switch.
      if (message.conversationId !== activeConversationId) break
      upsertMessage(message.message)
      break

    case 'turn/delta': {
      if (message.conversationId !== activeConversationId) break
      const stream = streams.get(message.id)
      const article = findArticle(message.id)
      if (!stream || !article) return
      if (message.channel === 'content') stream.content += message.text
      else stream.reasoning += message.text
      paint(article, stream.content, stream.reasoning)
      scrollToEnd()
      break
    }

    case 'turn/completed': {
      if (message.conversationId !== activeConversationId) break
      const article = findArticle(message.id)
      const stream = streams.get(message.id)
      if (!article) return
      paintStatus(article, {
        id: message.id,
        role: 'assistant',
        content: stream?.content ?? '',
        streaming: false,
        ...(message.aborted ? { aborted: true } : {}),
        ...(message.stats ? { stats: message.stats } : {}),
      })
      break
    }

    case 'turn/failed': {
      if (message.conversationId !== activeConversationId) break
      const article = findArticle(message.id)
      const stream = streams.get(message.id)
      if (!article) return
      paintStatus(article, {
        id: message.id,
        role: 'assistant',
        content: stream?.content ?? '',
        streaming: false,
        error: message.message,
      })
      break
    }

    case 'notice':
      showNotice(message.level, message.message)
      break
    case 'historyList':
      renderHistoryList(message.conversations)
      historyPanel.hidden = !historyOpen
      break
  }
})

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function submit(): void {
  const text = input.value.trim()
  if (!text || !session.canSend) return
  post({ type: 'send', text })
  input.value = ''
  resize()
}

sendButton.addEventListener('click', submit)
stopButton.addEventListener('click', () => post({ type: 'abort' }))
newButton.addEventListener('click', () => post({ type: 'newConversation' }))

input.addEventListener('keydown', (event) => {
  // Enter sends; Shift+Enter is a newline. Matches every chat client the user
  // already has muscle memory for.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    submit()
  }
})

/** Grow the box with its content, up to a point. */
function resize(): void {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`
}
input.addEventListener('input', resize)

post({ type: 'ready', protocolVersion: PROTOCOL_VERSION })
