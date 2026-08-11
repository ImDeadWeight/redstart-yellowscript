// =============================================================================
// SSE stream adapter for McpHost (Phase 4.2).
// =============================================================================
// Turns a real `fetch` response — the SSE stream from GET /sse — into the
// McpSseStream interface the host needs. This is the only `vscode`-aware piece:
// it borrows the gateway fetch (which already carries the bearer header) and
// decodes the byte stream into typed SSE events.
//
// SSE framing rules we rely on:
//  - events are separated by a blank line
//  - `event:` sets the event type (default `message`)
//  - `data:` lines accumulate the payload (space-separated if multiple)
//  - a leading `:` is a comment
//
// =============================================================================

import type { McpSseStream, SseEvent } from '../nest/mcp-host.ts'

/** Open the SSE stream at `url` using the supplied fetch (bound to credentials). */
export async function openMcpSseStream(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
): Promise<McpSseStream> {
  const response = await fetch(url, {
    headers: { Accept: 'text/event-stream' },
  })
  if (!response.ok) {
    throw new Error(`MCP SSE stream: ${response.status} ${response.statusText}`)
  }
  if (!response.body) {
    throw new Error('MCP SSE stream returned an empty body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  const events: SseEvent[] = []
  let buffer = ''
  let closed = false

  const pushEvent = (type: string, data: string) => {
    events.push({ type, data: data.replace(/\n$/, '') })
  }

  // Produce an async iterator that drains `events` as they are parsed from the
  // byte stream. This is consumed by McpHost.runStream via `for await`.
  const iterator: AsyncIterator<SseEvent> = {
    next(): Promise<IteratorResult<SseEvent>> {
      if (events.length > 0) {
        const event = events.shift()!
        return Promise.resolve({ value: event, done: false })
      }
      if (closed) {
        return Promise.resolve({ value: undefined, done: true })
      }
      return new Promise((resolve, reject) => {
        // Schedule a microtask that re-checks after the parser has had a chance
        // to push. If still empty and closed, we're done.
        queueMicrotask(() => {
          if (events.length > 0) {
            const event = events.shift()!
            resolve({ value: event, done: false })
          } else if (closed) {
            resolve({ value: undefined, done: true })
          } else {
            resolve(iterator.next())
          }
        })
      })
    },
  }

  const stream: McpSseStream = {
    events: { [Symbol.asyncIterator](): AsyncIterator<SseEvent> { return iterator } },
    close() {
      closed = true
      void reader.cancel().catch(() => {})
    },
  }

  // Kick off the background parser. It decodes bytes, splits into SSE events,
  // and pushes them into `events` for the consumer to drain.
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // Split on blank lines — each block is a complete SSE event.
        let blockStart = 0
        for (;;) {
          const blockEnd = buffer.indexOf('\n\n', blockStart)
          if (blockEnd === -1) break

          const block = buffer.slice(blockStart, blockEnd)
          buffer = buffer.slice(blockEnd + 2)
          blockStart = 0

          let eventType: string | null = null
          let data: string | null = null
          for (const line of block.split('\n')) {
            const trimmed = line.replace(/\r$/, '')
            if (trimmed.startsWith(':') || trimmed === '') continue
            const colon = trimmed.indexOf(':')
            if (colon === -1) {
              if (trimmed === 'data') {
                data = (data ?? '') + '\n'
              }
            } else {
              const field = trimmed.slice(0, colon)
              const rest = trimmed.slice(colon + 1).replace(/^ /, '')
              if (field === 'event') eventType = rest
              else if (field === 'data') data = (data ?? '') + (data ? '\n' : '') + rest
            }
          }
          if (data !== null) {
            pushEvent(eventType ?? 'message', data)
          }
        }
      }
      // Flush any trailing buffer.
      if (buffer.trim()) {
        let eventType: string | null = null
        let data: string | null = null
        for (const line of buffer.split('\n')) {
          const trimmed = line.replace(/\r$/, '')
          if (trimmed.startsWith(':') || trimmed === '') continue
          const colon = trimmed.indexOf(':')
          if (colon === -1) {
            if (trimmed === 'data') data = (data ?? '') + '\n'
          } else {
            const field = trimmed.slice(0, colon)
            const rest = trimmed.slice(colon + 1).replace(/^ /, '')
            if (field === 'event') eventType = rest
            else if (field === 'data') data = (data ?? '') + (data ? '\n' : '') + rest
          }
        }
        if (data !== null) pushEvent(eventType ?? 'message', data)
      }
    } catch {
      // reader.read threw or was cancelled — signal close.
    } finally {
      closed = true
    }
  })()

  return stream
}
