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

import { PROTOCOL_VERSION, type ChatMessageView, type HostMessage, type SessionSnapshot, type WebviewMessage } from '../chat/protocol.ts'
import { renderMarkdown } from './markdown.ts'

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
const input = required<HTMLTextAreaElement>('prompt')
const sendButton = required<HTMLButtonElement>('send')
const stopButton = required<HTMLButtonElement>('stop')
const newButton = required<HTMLButtonElement>('new')

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
let session: SessionSnapshot = { connection: 'disconnected', detail: 'Starting…', canSend: false, busy: false }

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTranscript(messages: ChatMessageView[]): void {
  transcript.replaceChildren()
  streams.clear()
  for (const message of messages) transcript.append(buildMessage(message))
  scrollToEnd()
}

function buildMessage(message: ChatMessageView): HTMLElement {
  const article = document.createElement('article')
  article.className = `message ${message.role}`
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
  banner.hidden = !needsAction
  if (needsAction) {
    banner.replaceChildren()
    const text = document.createElement('span')
    text.textContent = next.detail
    banner.append(text)

    const action = actionFor(next.connection)
    if (action) {
      const button = document.createElement('button')
      button.className = 'link'
      button.textContent = action.label
      button.addEventListener('click', () => post({ type: 'runCommand', command: action.command }))
      banner.append(button)
    }
  }

  input.disabled = !next.canSend
  sendButton.hidden = next.busy
  stopButton.hidden = !next.busy
  sendButton.disabled = !next.canSend
  input.placeholder = next.canSend
    ? 'Ask Yellowscript…'
    : next.busy
      ? 'Waiting for the model…'
      : 'Connect to a Redstart Nest to start.'
}

function actionFor(
  connection: SessionSnapshot['connection'],
): { label: string; command: 'connect' | 'signIn' | 'showStatus' } | null {
  switch (connection) {
    case 'disconnected':
    case 'error':
      return { label: 'Connect', command: 'connect' }
    case 'unauthenticated':
      return { label: 'Sign in', command: 'signIn' }
    default:
      return null
  }
}

function showNotice(level: 'info' | 'warning' | 'error', text: string): void {
  const notice = document.createElement('div')
  notice.className = `notice ${level}`
  notice.textContent = text
  transcript.append(notice)
  scrollToEnd()
}

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
      renderSession(message.session)
      renderTranscript(message.messages)
      break

    case 'session':
      renderSession(message.session)
      break

    case 'conversation':
      renderTranscript(message.messages)
      break

    case 'message':
      transcript.append(buildMessage(message.message))
      scrollToEnd(message.message.role === 'user')
      break

    case 'turn/delta': {
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
