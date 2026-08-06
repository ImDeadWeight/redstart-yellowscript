// =============================================================================
// A small, deliberately limited Markdown renderer.
// =============================================================================
// WHY NOT A LIBRARY: markdown-it plus a sanitizer is ~100kb of webview bundle
// and a second thing to keep patched, to render output that is overwhelmingly
// paragraphs, code blocks and lists. When the transcript needs tables and
// footnotes, swap this out — until then it is not worth the weight.
//
// THE SAFETY ARGUMENT, since this renders model output into a privileged
// webview and gets it wrong exactly once:
//
//   1. The entire input is HTML-escaped FIRST. After that step no `<`, `>`, `&`,
//      `"` or `'` from the model survives as markup — they are all entities.
//   2. Every tag emitted afterwards is a literal in this file. The model's text
//      is only ever placed as escaped text content.
//   3. The one place model text reaches an ATTRIBUTE is a link's href, so link
//      URLs are scheme-checked against http/https. `javascript:` and `data:`
//      never render as links. The URL is already escaped, so quotes cannot
//      break out of the attribute either.
//
// That ordering is the whole defence. If you add a rule, add it AFTER the escape
// and never emit unescaped input.
//
// STREAMING: `renderMarkdown` is called on every delta with the partial text, so
// it has to look sane mid-token. An unterminated code fence renders as a code
// block rather than as literal backticks, because that is what it is about to
// become.
// =============================================================================

// Sentinel marking where an extracted code block or span was lifted out.
// Built with fromCharCode rather than written as a literal: it is an invisible
// private-use character, and a literal one is the kind of thing an editor, a
// copy-paste, or a re-encode silently eats. It is stripped from the input before
// use, so model output can never forge one.
const SENTINEL = String.fromCharCode(0xe000)
const BLOCK_REF = new RegExp(`${SENTINEL}B(\\d+)`, 'g')
const SPAN_REF = new RegExp(`${SENTINEL}S(\\d+)`, 'g')
const LONE_BLOCK_REF = new RegExp(`^${SENTINEL}B\\d+$`)

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Only http and https become links. Everything else renders as plain text. */
export function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim())
}

export function renderMarkdown(source: string): string {
  // Strip the sentinel before anything else so the placeholder scheme below
  // cannot be spoofed by the model's own output.
  const escaped = escapeHtml(source.split(SENTINEL).join(''))

  const blocks: string[] = []
  const spans: string[] = []

  // Fenced code first: nothing inside a fence should be interpreted as markup.
  // The `(?:```|$)` tail is what makes a half-streamed fence render as a code
  // block instead of as stray backticks.
  const withoutFences = escaped.replace(
    /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g,
    (_match, language: string, code: string) => {
      // Validate the language rather than sanitising it. Stripping bad
      // characters turns `js" onload="alert(1)` into a plausible-looking but
      // meaningless class; rejecting it outright is both safer and honest about
      // not knowing the language.
      const lang = language.trim()
      const classAttr = /^[\w+#-]{1,24}$/.test(lang) ? ` class="language-${lang}"` : ''
      blocks.push(`<pre><code${classAttr}>${code.replace(/\n$/, '')}</code></pre>`)
      return `\n${SENTINEL}B${blocks.length - 1}\n`
    },
  )

  // Inline code next, for the same reason.
  const withoutCode = withoutFences.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    spans.push(`<code>${code}</code>`)
    return `${SENTINEL}S${spans.length - 1}`
  })

  return renderBlocks(withoutCode.split('\n'))
    .replace(BLOCK_REF, (_m, i: string) => blocks[Number(i)] ?? '')
    .replace(SPAN_REF, (_m, i: string) => spans[Number(i)] ?? '')
}

/** Block-level structure: headings, lists, quotes, rules, paragraphs. */
function renderBlocks(lines: string[]): string {
  const out: string[] = []
  let paragraph: string[] = []
  let listType: 'ul' | 'ol' | null = null
  let quote: string[] = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    out.push(`<p>${renderInline(paragraph.join('\n'))}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (!listType) return
    out.push(`</${listType}>`)
    listType = null
  }
  const flushQuote = () => {
    if (quote.length === 0) return
    out.push(`<blockquote>${renderBlocks(quote)}</blockquote>`)
    quote = []
  }
  const flushAll = () => {
    flushParagraph()
    flushList()
    flushQuote()
  }

  for (const line of lines) {
    // An extracted code block stands alone as its own block.
    if (LONE_BLOCK_REF.test(line.trim())) {
      flushAll()
      out.push(line.trim())
      continue
    }

    if (line.trim() === '') {
      flushAll()
      continue
    }

    // `&gt;` not `>`: block parsing runs on already-escaped text, so the
    // blockquote marker arrives here as an entity.
    const quoteMatch = /^&gt;\s?(.*)$/.exec(line)
    if (quoteMatch) {
      flushParagraph()
      flushList()
      quote.push(quoteMatch[1] ?? '')
      continue
    }
    flushQuote()

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushAll()
      const level = heading[1]?.length ?? 1
      out.push(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`)
      continue
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushAll()
      out.push('<hr>')
      continue
    }

    const unordered = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (unordered) {
      flushParagraph()
      if (listType !== 'ul') {
        flushList()
        out.push('<ul>')
        listType = 'ul'
      }
      out.push(`<li>${renderInline(unordered[1] ?? '')}</li>`)
      continue
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      flushParagraph()
      if (listType !== 'ol') {
        flushList()
        out.push('<ol>')
        listType = 'ol'
      }
      out.push(`<li>${renderInline(ordered[1] ?? '')}</li>`)
      continue
    }

    flushList()
    paragraph.push(line)
  }

  flushAll()
  return out.join('\n')
}

/** Inline emphasis and links, applied to already-escaped text. */
function renderInline(text: string): string {
  return (
    text
      // Links are the only place model text reaches an attribute, hence the
      // scheme check. An unsafe URL degrades to its label rather than vanishing.
      .replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) =>
        isSafeUrl(url) ? `<a href="${url}">${label || url}</a>` : label || url,
      )
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      // A single newline inside a paragraph is a visible line break here —
      // model output relies on it far more than the Markdown spec does.
      .replace(/\n/g, '<br>')
  )
}
