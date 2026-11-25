// =============================================================================
// A reply that narrates a tool call instead of making one.
// =============================================================================
// Seen in the redstart-website chats (Qwen 3.6 35B-A3B, 2026-11-25): a reply
// with no tool calls that reads like a run.
//
//   Let me find the exact line:
//
//   [What this run did]
//   changed src/routes/+page.svelte
//
// Or longer: "Let me view the relevant section of Hero.svelte.\n\nThere it
// is. The <img> …", where the model wrote the call's result itself and went on
// from it. Nothing ran, and the person was told it had. Ten replies did this
// across eight chats, none in a form the fallback parser could recover: there
// is no call syntax in them to recover, only prose.
//
// The run log (chat/run-log.ts) is a header only Yellowscript writes, so a
// reply that contains it copied it. A stray </think> means the model wrote
// past its own turn. Both are certain; the announcement checks are worded
// narrowly ("let me know", "let me explain" are not calls) and were checked
// against every final reply in those chats (phantom-call.test.ts).
//
// Pure: the loop asks once per run and drops the reply (loop.ts), and the
// session cuts the copied tail off before replaying it (session.ts).
// =============================================================================

import { RUN_LOG_HEADER } from '../chat/run-log.ts'

/** Why a reply looks like a narrated call, or null. */
export type PhantomReason = 'run-log' | 'think-tag' | 'dangling' | 'narrated'

/** Verbs that announce a tool call ("Let me check …"), not a thought. */
const CALL_VERBS =
  'check|read|re-read|look|view|open|find|search|grep|inspect|verify|confirm|run|re-run|rerun|test|build|install|' +
  'fix|update|edit|change|apply|replace|swap|add|remove|delete|create|write|copy|move|rename|commit|push|pull|' +
  'start|restart|stop|list|load|fetch|reload|refresh|scan|patch|set|make|do|try|get'

/** "Let me check X", "Now I'll read Y", "I'll update Z", "Next, let me …". */
const ANNOUNCE = new RegExp(
  `^(?:(?:ok(?:ay)?|good|great|now|next|first|then|so|alright|right)[,.!]?\\s+)*` +
    `(?:let me|let's|i'll|i will|i'm going to|i need to)\\s+(?:also\\s+|quickly\\s+|now\\s+|first\\s+)*(?:${CALL_VERBS})\\b`,
  'i',
)

/** The marks a reply can only have copied from what Yellowscript sends. */
const COPIED_MARKS = [RUN_LOG_HEADER, '[Earlier run:']
const THINK_TAG = /<\/?think>/

/** Paragraphs, trimmed, without the empty ones. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
}

/** A short paragraph that says it is about to call a tool. */
function announces(paragraph: string): boolean {
  return paragraph.length <= 240 && !paragraph.includes('\n') && ANNOUNCE.test(paragraph)
}

/**
 * Why a reply with NO tool calls looks like it narrated one, or null.
 * `ranTools`: this run has made real calls already. Then a copied run log
 * alone is only a bad habit (the work happened; the session cuts it off), not
 * a reason to ask again.
 */
export function phantomCall(content: string, ranTools: boolean): PhantomReason | null {
  if (THINK_TAG.test(content)) return 'think-tag'
  const copied = COPIED_MARKS.some((mark) => content.includes(mark))
  // Look at the reply as it would be without the copied log.
  const own = paragraphs(withoutCopiedTail(content))
  const lastParagraph = own.at(-1)
  // Ends on "Let me find the exact line:" — the call that should follow is not there.
  if (lastParagraph && announces(lastParagraph) && /[:…]$|\.\.\.$/.test(lastParagraph)) return 'dangling'
  // "Let me view Hero.svelte." followed by what it found: the model wrote the result.
  // Two announcements, so a single "Let me check: the cause is …" does not count.
  const announced = own.slice(0, -1).filter(announces).length
  if (announced >= 2) return 'narrated'
  if (copied && !ranTools) return 'run-log'
  return null
}

/**
 * The reply without anything from the first copied mark on: a run log the
 * model wrote itself, or a stray think tag and what it wrote past it. What is
 * left is what the model said before it started imitating.
 */
export function withoutCopiedTail(content: string): string {
  let cut = content.length
  for (const mark of COPIED_MARKS) {
    const at = content.indexOf(mark)
    if (at !== -1 && at < cut) cut = at
  }
  const think = THINK_TAG.exec(content)
  if (think && think.index < cut) cut = think.index
  return cut === content.length ? content : content.slice(0, cut).trimEnd()
}

/** The note the re-asked request carries. */
export function phantomNote(reason: PhantomReason): string {
  const what =
    reason === 'run-log'
      ? 'it wrote a "[What this run did]" log, but no tool ran: Yellowscript writes that log, from real calls'
      : reason === 'think-tag'
        ? 'it went on past the end of your turn'
        : 'it said it would use a tool, made no tool call, and went on as if it had'
  return (
    `[Your last reply was dropped: ${what}. Nothing was read, run or changed. ` +
    'To look at or change anything, make the tool call; its result comes back to you. Do not write results yourself.]'
  )
}
