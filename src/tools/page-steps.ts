// =============================================================================
// ys_check_page's steps, eval and viewport: checking behaviour, not just load.
// =============================================================================
// A page that loads cleanly can still be a game whose jump throws, or a form
// that never shows results. Steps act on the page after it loads, in order;
// `eval` reads a value out of it afterwards (a game's `window.__game` state);
// `viewport` loads it at a phone's size. All in the one call, so a small
// model need not hold a browser session across turns.
//
// This file parses and validates what the model sent, and knows how keys
// map to DevTools key events. Running them is browser-check.ts's job.
// No `vscode` import.
// =============================================================================

export const MAX_STEPS = 20
export const MAX_STEP_WAIT_MS = 5_000
export const MAX_HOLD_MS = 5_000
export const MAX_EVAL_CHARS = 2_000
export const EVAL_TIMEOUT_MS = 2_000

export type PageStep =
  | { key: string; holdMs: number }
  | { click: string | [number, number] }
  | { type: string; into?: string }
  | { waitMs: number }
  | { waitFor: string }
  | { screenshot: string }
  | { inspect: string }

const ACTIONS = ['key', 'click', 'type', 'wait_ms', 'wait_for', 'screenshot', 'inspect'] as const

/** One line for the report: `key ArrowRight (800ms)`. */
export function describeStep(step: PageStep): string {
  if ('key' in step) return `key ${step.key}${step.holdMs > 50 ? ` (${step.holdMs}ms)` : ''}`
  if ('click' in step) return `click ${Array.isArray(step.click) ? `[${step.click.join(', ')}]` : JSON.stringify(step.click)}`
  if ('type' in step) return `type ${JSON.stringify(step.type)}${step.into ? ` into ${JSON.stringify(step.into)}` : ''}`
  if ('waitMs' in step) return `wait ${step.waitMs}ms`
  if ('waitFor' in step) return `wait_for ${JSON.stringify(step.waitFor)}`
  if ('screenshot' in step) return `screenshot "${step.screenshot}"`
  return `inspect ${JSON.stringify(step.inspect)}`
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null)

/** The model's steps, checked; or what is wrong with them, said so it can fix it. */
export function parseSteps(raw: unknown): { steps: PageStep[] } | { error: string } {
  if (raw === undefined || raw === null) return { steps: [] }
  if (!Array.isArray(raw)) return { error: '"steps" must be an array of objects, e.g. [{"key": "Space"}, {"wait_ms": 500}].' }
  if (raw.length > MAX_STEPS) return { error: `At most ${MAX_STEPS} steps; got ${raw.length}.` }
  const steps: PageStep[] = []
  for (const [i, item] of raw.entries()) {
    const at = `Step ${i + 1}`
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return { error: `${at} must be an object with one action, e.g. {"click": "#start"}.` }
    const o = item as Record<string, unknown>
    const actions = ACTIONS.filter((a) => a in o)
    if (actions.length !== 1) return { error: `${at} needs exactly one of ${ACTIONS.join(', ')}; it has ${actions.length ? actions.join(', ') : 'none'}.` }
    const action = actions[0]!
    const value = o[action]
    switch (action) {
      case 'key': {
        if (typeof value !== 'string' || !keyEvent(value)) return { error: `${at}: unknown key ${JSON.stringify(value)}. Use a name like "ArrowRight", "Space", "Enter" or a single character.` }
        const hold = num(o.hold_ms) ?? 50
        steps.push({ key: value, holdMs: Math.min(Math.max(hold, 10), MAX_HOLD_MS) })
        break
      }
      case 'click':
        if (typeof value === 'string' && value.trim()) steps.push({ click: value })
        else if (Array.isArray(value) && value.length === 2 && value.every((n) => num(n) !== null)) steps.push({ click: [num(value[0])!, num(value[1])!] })
        else return { error: `${at}: "click" takes a CSS selector or [x, y] in CSS pixels.` }
        break
      case 'type':
        if (typeof value !== 'string') return { error: `${at}: "type" takes the text to type.` }
        if (o.into !== undefined && typeof o.into !== 'string') return { error: `${at}: "into" takes a CSS selector.` }
        steps.push(typeof o.into === 'string' ? { type: value, into: o.into } : { type: value })
        break
      case 'wait_ms': {
        const ms = num(value)
        if (ms === null || ms < 0) return { error: `${at}: "wait_ms" takes milliseconds (at most ${MAX_STEP_WAIT_MS}).` }
        steps.push({ waitMs: Math.min(ms, MAX_STEP_WAIT_MS) })
        break
      }
      case 'wait_for':
        if (typeof value !== 'string' || !value.trim()) return { error: `${at}: "wait_for" takes a CSS selector.` }
        steps.push({ waitFor: value })
        break
      case 'screenshot':
        steps.push({ screenshot: (typeof value === 'string' && value.trim() ? value : `step-${i + 1}`).replace(/[^\w.-]+/g, '-').slice(0, 40) })
        break
      case 'inspect':
        if (typeof value !== 'string' || !value.trim()) return { error: `${at}: "inspect" takes a CSS selector.` }
        steps.push({ inspect: value })
        break
    }
  }
  return { steps }
}

/** `390x844` → a viewport; under 600px wide is emulated as mobile. */
export function parseViewport(raw: unknown): { width: number; height: number; mobile: boolean } | { error: string } | null {
  if (raw === undefined || raw === null || raw === '') return null
  const m = typeof raw === 'string' ? /^\s*(\d{3,4})\s*[x×]\s*(\d{3,4})\s*$/i.exec(raw) : null
  if (!m) return { error: '"viewport" is WIDTHxHEIGHT in CSS pixels, e.g. "390x844".' }
  const width = Number(m[1])
  const height = Number(m[2])
  if (width < 200 || height < 200 || width > 4000 || height > 4000) return { error: 'The viewport must be between 200 and 4000 pixels each way.' }
  return { width, height, mobile: width < 600 }
}

/** DevTools' fields for a key, or null when the name is unknown. */
export function keyEvent(name: string): { key: string; code: string; keyCode: number; text?: string } | null {
  const named: Record<string, [string, string, number]> = {
    arrowleft: ['ArrowLeft', 'ArrowLeft', 37],
    arrowup: ['ArrowUp', 'ArrowUp', 38],
    arrowright: ['ArrowRight', 'ArrowRight', 39],
    arrowdown: ['ArrowDown', 'ArrowDown', 40],
    left: ['ArrowLeft', 'ArrowLeft', 37],
    up: ['ArrowUp', 'ArrowUp', 38],
    right: ['ArrowRight', 'ArrowRight', 39],
    down: ['ArrowDown', 'ArrowDown', 40],
    space: [' ', 'Space', 32],
    ' ': [' ', 'Space', 32],
    enter: ['Enter', 'Enter', 13],
    return: ['Enter', 'Enter', 13],
    escape: ['Escape', 'Escape', 27],
    esc: ['Escape', 'Escape', 27],
    tab: ['Tab', 'Tab', 9],
    backspace: ['Backspace', 'Backspace', 8],
    shift: ['Shift', 'ShiftLeft', 16],
    control: ['Control', 'ControlLeft', 17],
    alt: ['Alt', 'AltLeft', 18],
  }
  const hit = named[name.toLowerCase()]
  if (hit) {
    const [key, code, keyCode] = hit
    return key === ' ' ? { key, code, keyCode, text: ' ' } : key === 'Enter' ? { key, code, keyCode, text: '\r' } : { key, code, keyCode }
  }
  const keyX = /^Key([A-Z])$/.exec(name)
  if (keyX) return { key: keyX[1]!.toLowerCase(), code: name, keyCode: keyX[1]!.charCodeAt(0), text: keyX[1]!.toLowerCase() }
  const digit = /^Digit(\d)$/.exec(name)
  if (digit) return { key: digit[1]!, code: name, keyCode: digit[1]!.charCodeAt(0), text: digit[1]! }
  if (name.length === 1) {
    const upper = name.toUpperCase()
    if (/[a-z]/i.test(name)) return { key: name, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: name }
    if (/\d/.test(name)) return { key: name, code: `Digit${name}`, keyCode: name.charCodeAt(0), text: name }
    return { key: name, code: '', keyCode: 0, text: name }
  }
  return null
}
