// =============================================================================
// Repairing a model's malformed tool arguments.
// =============================================================================
// A local model emits `arguments` as JSON text and gets it slightly wrong
// often enough to matter. The usual failures are mechanical, and refusing them
// costs a turn each (and, for a whole-file ys_write_file, the whole file
// again):
//
//   - raw newlines or tabs inside a string — `content` with real line breaks
//   - a backslash that is not a JSON escape — `"pattern": "\d+"`
//   - single-quoted strings — `{'path': 'a.txt'}`
//   - a trailing comma — `{"path": "a.txt",}`
//   - the whole object wrapped in a ``` code fence
//
// `repairJson` fixes exactly those, in one pass over the text, and says which
// it fixed. It runs only after JSON.parse has refused the text, so valid
// arguments are never touched. Anything else is still an error for the model.
//
// This belongs next to agent-core's recovery parser, so chat-ui gains it too;
// until that is synced it lives here (PLAN-long-tasks.md item 0).
// =============================================================================

export type RepairKind = 'code fence' | 'raw newline' | 'invalid escape' | 'single quotes' | 'trailing comma'

export interface Repaired {
  text: string
  repairs: RepairKind[]
}

const FENCE = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```$/
const JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u'])

/** Rewrite the mechanical mistakes in `raw`; `repairs` is empty when there were none. */
export function repairJson(raw: string): Repaired {
  const found = new Set<RepairKind>()
  let text = raw.trim()

  const fenced = FENCE.exec(text)
  if (fenced) {
    text = fenced[1]!.trim()
    found.add('code fence')
  }

  let out = ''
  // The quote that opened the current string, or null outside one.
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!

    if (quote === null) {
      if (ch === '"') {
        quote = '"'
        out += ch
      } else if (ch === "'") {
        quote = "'"
        out += '"'
        found.add('single quotes')
      } else if (ch === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) {
        found.add('trailing comma')
      } else {
        out += ch
      }
      continue
    }

    // Inside a string.
    if (ch === '\\') {
      const next = text[i + 1]
      if (next === undefined) {
        out += '\\\\'
        found.add('invalid escape')
      } else if (quote === "'" && next === "'") {
        out += "'"
        i++
      } else if (JSON_ESCAPES.has(next) && !(next === 'u' && !/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6)))) {
        out += ch + next
        i++
      } else {
        out += '\\\\'
        found.add('invalid escape')
      }
    } else if (ch === quote) {
      quote = null
      out += '"'
    } else if (ch === '"') {
      // A double quote inside a single-quoted string.
      out += '\\"'
    } else if (ch === '\n' || ch === '\r' || ch === '\t') {
      out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : '\\t'
      found.add('raw newline')
    } else {
      out += ch
    }
  }

  return { text: out, repairs: [...found] }
}
