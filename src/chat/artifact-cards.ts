// =============================================================================
// Artifact cards — what a Nest artifacts tool result shows in the chat.
// =============================================================================
// Every artifacts tool result ends with `[artifact: <id> r<n>|draft]`
// (redstart-project shared/agent-core/artifact-lines.mjs), and the ones that
// name a page add `Open: <url>`, the chat app's page for it as Nest built it
// (artifacts plan D13: Nest builds every link). The card is those two things
// and the first quoted title in the result.
//
// A tool result is Nest's text, but it can quote a model-written title. The
// card treats all of it as data: the id must be an id, the link http(s), and
// the host opens only the link recorded here for that id, never one the
// webview sends (chat-handlers.ts onOpenArtifact).
// =============================================================================

import { parseArtifactLines } from '../agent/agent-core.ts'
import type { ArtifactCardView } from './protocol.ts'

const OPEN = /^Open: (https?:\/\/[^\s]+)$/m
const TITLE = /"([^"\n]{1,120})"/

/** The cards one tool result names (normally one). */
export function artifactCardsFrom(text: string): ArtifactCardView[] {
  if (typeof text !== 'string') return []
  const refs = parseArtifactLines(text)
  if (!refs.length) return []
  const url = OPEN.exec(text)?.[1]
  const title = TITLE.exec(text)?.[1]
  return refs.map((r) => {
    const card: ArtifactCardView = { id: r.id, revision: r.revision }
    if (title) card.title = title
    // The link names its artifact; a result naming two keeps it on the right one.
    if (url && url.endsWith(`/#/artifacts/${r.id}`) && safeUrl(url)) card.url = url
    return card
  })
}

/** Newer cards replace older ones for the same artifact, keeping what they lack. */
export function mergeCards(have: readonly ArtifactCardView[], next: readonly ArtifactCardView[]): ArtifactCardView[] {
  const out = [...have]
  for (const card of next) {
    const i = out.findIndex((c) => c.id === card.id)
    if (i === -1) out.push(card)
    else out[i] = { ...out[i], ...card }
  }
  return out
}

/** http(s) with a host, and nothing else. */
export function safeUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !u.username && !u.password
  } catch {
    return false
  }
}
