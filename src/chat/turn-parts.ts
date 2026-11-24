// =============================================================================
// An assistant turn, in the order it happened.
// =============================================================================
// One assistant message can hold a whole agent run: think, say a little, call
// three tools, think again, answer. Kept as three flat fields (content,
// reasoning, tools) the panel could only draw them as three piles, and a long
// run read as one wall of thought followed by forty cards. `parts` keeps the
// order: consecutive chunks of one kind join the part before them; a change of
// kind, or a tool call, starts a new one.
//
// Both sides apply the same function to the same stream (the host to the turn
// it records, the webview to the turn it draws), so they agree without the
// host resending the list.
//
// Pure. No `vscode`, no DOM.
// =============================================================================

export type TurnPart =
  | { kind: 'reasoning'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; callId: string }
  /** A line from the host about the run itself: "Changed approach: …". */
  | { kind: 'notice'; text: string }

/** `parts` with a streamed chunk or a tool call added. Never mutates. */
export function appendPart(parts: readonly TurnPart[] | undefined, part: TurnPart): TurnPart[] {
  const list = parts ? [...parts] : []
  if (part.kind === 'tool') {
    if (!list.some((p) => p.kind === 'tool' && p.callId === part.callId)) list.push(part)
    return list
  }
  // Each notice is its own line, never joined to the one before.
  if (part.kind === 'notice') {
    if (part.text) list.push({ kind: 'notice', text: part.text })
    return list
  }
  if (!part.text) return list
  const last = list[list.length - 1]
  if (last && last.kind === part.kind) list[list.length - 1] = { kind: last.kind, text: last.text + part.text }
  else list.push({ kind: part.kind, text: part.text })
  return list
}

/** One thing the panel draws: a thought, some text, or a run of tool calls. */
export type TurnBlock =
  | { kind: 'reasoning'; text: string; key: string }
  | { kind: 'text'; text: string; key: string }
  | { kind: 'tools'; callIds: string[]; key: string }
  | { kind: 'notice'; text: string; key: string }

/** Parts as blocks: consecutive tool calls become one block. Whitespace-only
 *  text (the newline a model writes before a call) is dropped. */
export function turnBlocks(parts: readonly TurnPart[]): TurnBlock[] {
  const blocks: TurnBlock[] = []
  parts.forEach((part, i) => {
    const key = `p${i}`
    if (part.kind === 'tool') {
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'tools') last.callIds.push(part.callId)
      else blocks.push({ kind: 'tools', callIds: [part.callId], key })
      return
    }
    if (!part.text.trim()) return
    blocks.push({ kind: part.kind, text: part.text, key })
  })
  return blocks
}

/**
 * A finished turn split into the work and the answer: the answer is the text
 * after the last tool run (or the last text, when the turn ended thinking).
 * A turn with no tools has no work to fold.
 */
export function splitAnswer(blocks: readonly TurnBlock[]): { work: TurnBlock[]; answer: TurnBlock[] } {
  let lastTools = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]!.kind === 'tools') {
      lastTools = i
      break
    }
  }
  if (lastTools === -1) return { work: [], answer: [...blocks] }
  const after = blocks.slice(lastTools + 1)
  // Reasoning right before the answer stays with the work: the answer is text.
  const firstText = after.findIndex((b) => b.kind === 'text')
  if (firstText === -1) return { work: [...blocks], answer: [] }
  const cut = lastTools + 1 + firstText
  return { work: blocks.slice(0, cut), answer: blocks.slice(cut) }
}
