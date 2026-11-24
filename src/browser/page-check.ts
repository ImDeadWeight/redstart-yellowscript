// =============================================================================
// Loading a page in a headless browser and reporting what happened.
// =============================================================================
// A model writing a canvas game or a website cannot see it run. This loads the
// page, lets it run for a moment, runs the steps it was given, and returns
// what a developer would look at first:
//
// - uncaught exceptions and console errors and warnings (the game loop that
//   throws on its third frame shows up here),
// - requests that failed (a 404 on a sprite or a script),
// - a DOM summary: title, canvases and their sizes, the visible text,
// - screenshots.
//
// SCOPE: only loopback URLs (a dev server on this machine) and files inside the
// workspace (resolveTarget). The tool that exposes this to the model is
// tools/check-page-tool.ts.
//
// No `vscode` import.
// =============================================================================

import type { ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { Cdp, launch } from './cdp.ts'
import { killTree } from '../tools/command-run.ts'
import { EVAL_TIMEOUT_MS, MAX_EVAL_CHARS, describeStep, keyEvent, type PageStep } from '../tools/page-steps.ts'
import { PathScopeError, resolveWithinWorkspace } from '../tools/workspace-path.ts'

export const DEFAULT_WAIT_MS = 2_000
export const MAX_WAIT_MS = 15_000
const LOAD_TIMEOUT_MS = 15_000
const MAX_EVENTS = 40
const MAX_TEXT_CHARS = 1_500

/** The URL to load, or why it may not be loaded. */
export function resolveTarget(target: string, roots: readonly string[]): { url: string } | { error: string } {
  const trimmed = target.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      return { error: `"${trimmed}" is not a valid URL.` }
    }
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)) return { url: url.toString() }
    return { error: `Only pages on this machine can be checked (localhost or 127.0.0.1), not ${url.hostname}.` }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-z]:[\\/]/i.test(trimmed)) {
    return { error: 'Give an http://localhost URL or a workspace-relative file path.' }
  }
  // index.html?test or page.html#level-2: the file, then its query or hash.
  const suffixAt = trimmed.search(/[?#]/)
  const filePart = suffixAt >= 0 ? trimmed.slice(0, suffixAt) : trimmed
  const suffix = suffixAt >= 0 ? trimmed.slice(suffixAt) : ''
  try {
    const file = resolveWithinWorkspace(roots, filePart)
    if (!fs.existsSync(file)) return { error: `"${filePart}" does not exist.` }
    return { url: `${pathToFileURL(file).toString()}${suffix}` }
  } catch (err) {
    if (err instanceof PathScopeError) return { error: `"${trimmed}" is outside the workspace.` }
    return { error: `Could not resolve "${trimmed}": ${err instanceof Error ? err.message : String(err)}` }
  }
}

export interface PageEvent {
  kind: 'exception' | 'error' | 'warning' | 'log' | 'request-failed'
  text: string
  /** The step (1-based) that ran last before it: an exception right after
   *  {"key": "Space"} is the jump. Absent: during load. */
  afterStep?: number
}

export interface StepOutcome {
  step: string
  ok: boolean
  error?: string
}

export interface PageCheck {
  url: string
  loaded: boolean
  title: string
  events: PageEvent[]
  /** What the page shows: canvases, element count, visible text. */
  summary: string
  /** PNG, base64; absent when the capture failed. */
  screenshot?: string
  durationMs: number
  /** Each step that ran; the run stops at the first that fails. */
  steps?: StepOutcome[]
  /** `inspect` steps: the element's facts, as text. */
  inspections?: { selector: string; text: string }[]
  /** `screenshot` steps, labelled. */
  shots?: { label: string; data: string }[]
  /** The `eval` expression's JSON value, or why it failed. */
  evaluation?: { ok: boolean; text: string }
  viewport?: string
}

/** What the page shows, evaluated inside it. */
const SUMMARY_SCRIPT = `(() => {
  const canvases = [...document.querySelectorAll('canvas')].map((c) => c.width + 'x' + c.height);
  const text = (document.body ? document.body.innerText : '').replace(/\\s+\\n/g, '\\n').trim();
  return JSON.stringify({
    title: document.title,
    elements: document.getElementsByTagName('*').length,
    canvases,
    text: text.slice(0, ${MAX_TEXT_CHARS}),
    more: Math.max(0, text.length - ${MAX_TEXT_CHARS}),
  });
})()`

/** An element's box, visibility, text and a few computed styles. */
const inspectScript = (selector: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  const visible = r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  return JSON.stringify({
    box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    visible,
    text: (el.innerText || el.value || '').trim().slice(0, 200),
    position: s.position, display: s.display, color: s.color, background: s.backgroundColor, fontSize: s.fontSize,
  });
})()`

/** The centre of the first element `selector` matches, scrolled into view. */
const centreScript = (selector: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2]);
})()`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface CheckPageOptions {
  url: string
  browser: string
  waitMs?: number
  screenshot?: boolean
  steps?: PageStep[]
  /** Evaluated after the steps; its JSON value is reported. */
  evaluate?: string
  viewport?: { width: number; height: number; mobile: boolean }
}

/** Load `url` headless, wait `waitMs` after load, run the steps, and report. */
export async function checkPage(options: CheckPageOptions): Promise<PageCheck> {
  const started = Date.now()
  const waitMs = Math.min(Math.max(0, options.waitMs ?? DEFAULT_WAIT_MS), MAX_WAIT_MS)
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-browser-'))
  let child: ChildProcess | undefined
  let cdp: Cdp | undefined
  const events: PageEvent[] = []
  let currentStep = 0
  const push = (e: PageEvent) => {
    // The browser asks for a favicon by itself; its 404 is not the page's bug.
    if (e.kind === 'request-failed' && /\/favicon\.ico\b/.test(e.text)) return
    if (events.length < MAX_EVENTS) events.push({ kind: e.kind, text: e.text.slice(0, 500), ...(currentStep ? { afterStep: currentStep } : {}) })
  }
  try {
    const launched = await launch(options.browser, profile)
    child = launched.child
    cdp = await Cdp.connect(launched.wsUrl)
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })

    let loaded = false
    let onLoad: () => void = () => {}
    const loadedPromise = new Promise<void>((r) => (onLoad = r))
    cdp.on((method, params, sid) => {
      if (sid !== sessionId) return
      if (method === 'Page.loadEventFired') {
        loaded = true
        onLoad()
      } else if (method === 'Runtime.exceptionThrown') {
        const d = params.exceptionDetails
        const where = d.url ? ` (${d.url.split('/').pop()}:${(d.lineNumber ?? 0) + 1})` : ''
        push({ kind: 'exception', text: `${d.exception?.description ?? d.text}${where}` })
      } else if (method === 'Runtime.consoleAPICalled') {
        const kind = params.type === 'error' || params.type === 'assert' ? 'error' : params.type === 'warning' ? 'warning' : 'log'
        const text = (params.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(' ')
        push({ kind, text })
      } else if (method === 'Log.entryAdded' && params.entry?.level === 'error') {
        push({ kind: params.entry.source === 'network' ? 'request-failed' : 'error', text: `${params.entry.text}${params.entry.url ? ` ${params.entry.url}` : ''}` })
      } else if (method === 'Network.loadingFailed' && !params.canceled) {
        push({ kind: 'request-failed', text: params.errorText })
      }
    })
    await Promise.all(['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable'].map((m) => cdp!.send(m, {}, sessionId)))
    if (options.viewport) {
      const { width, height, mobile } = options.viewport
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile }, sessionId)
    }
    const nav = await cdp.send('Page.navigate', { url: options.url }, sessionId)
    if (nav.errorText) push({ kind: 'request-failed', text: `navigation failed: ${nav.errorText}` })
    else {
      let loadTimer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([loadedPromise, new Promise((r) => (loadTimer = setTimeout(r, LOAD_TIMEOUT_MS)))])
      // Cleared, or it holds every check (and the extension host's tests) for 15s.
      clearTimeout(loadTimer)
    }
    // Let it run: a game loop's errors arrive after load.
    await sleep(waitMs)

    const page = cdp
    const evaluate = async (expression: string): Promise<unknown> => {
      const out = await page.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
      return out?.result?.value
    }
    const stepOutcomes: StepOutcome[] = []
    const inspections: { selector: string; text: string }[] = []
    const shots: { label: string; data: string }[] = []
    for (const [index, step] of (options.steps ?? []).entries()) {
      currentStep = index + 1
      const outcome: StepOutcome = { step: describeStep(step), ok: true }
      stepOutcomes.push(outcome)
      try {
        if ('key' in step) {
          const k = keyEvent(step.key)!
          const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode }
          await page.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text } : {}) }, sessionId)
          await sleep(step.holdMs)
          await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId)
        } else if ('click' in step) {
          let point = step.click
          if (typeof point === 'string') {
            const found = await evaluate(centreScript(point))
            if (typeof found !== 'string') throw new Error(`no element matches ${JSON.stringify(point)}`)
            point = JSON.parse(found) as [number, number]
          }
          const [x, y] = point
          await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId)
          await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId)
          await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId)
        } else if ('type' in step) {
          if (step.into) {
            const focused = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(step.into)}); if (!el) return false; el.focus(); return true })()`)
            if (focused !== true) throw new Error(`no element matches ${JSON.stringify(step.into)}`)
          }
          await page.send('Input.insertText', { text: step.type }, sessionId)
        } else if ('waitMs' in step) {
          await sleep(step.waitMs)
        } else if ('waitFor' in step) {
          const deadline = Date.now() + 5_000
          while ((await evaluate(`!!document.querySelector(${JSON.stringify(step.waitFor)})`)) !== true) {
            if (Date.now() > deadline) throw new Error('timed out after 5s')
            await sleep(100)
          }
        } else if ('screenshot' in step) {
          const shot = await page.send('Page.captureScreenshot', { format: 'png' }, sessionId)
          if (shot?.data) shots.push({ label: step.screenshot, data: shot.data })
        } else if ('inspect' in step) {
          const found = await evaluate(inspectScript(step.inspect))
          if (typeof found !== 'string') throw new Error(`no element matches ${JSON.stringify(step.inspect)}`)
          const f = JSON.parse(found)
          inspections.push({
            selector: step.inspect,
            text: `box ${f.box.join(',')} (x,y,w,h) · ${f.visible ? 'visible' : 'NOT visible'} · position ${f.position} · display ${f.display} · color ${f.color} · background ${f.background} · font-size ${f.fontSize}${f.text ? `\ntext: ${f.text}` : ''}`,
          })
        }
        // Let what the step set off happen, so its errors land after it.
        await sleep(50)
      } catch (err) {
        outcome.ok = false
        outcome.error = err instanceof Error ? err.message : String(err)
        break
      }
    }

    let evaluation: PageCheck['evaluation']
    if (options.evaluate) {
      currentStep = 0
      const out = await page
        .send('Runtime.evaluate', { expression: options.evaluate, returnByValue: true, awaitPromise: true, timeout: EVAL_TIMEOUT_MS }, sessionId)
        .catch((err: Error) => ({ exceptionDetails: { text: err.message } }))
      if (out?.exceptionDetails) {
        evaluation = { ok: false, text: out.result?.description ?? out.exceptionDetails.exception?.description ?? out.exceptionDetails.text ?? 'it threw' }
      } else {
        const json = JSON.stringify(out?.result?.value ?? null) ?? 'undefined'
        evaluation = { ok: true, text: json.length > MAX_EVAL_CHARS ? `${json.slice(0, MAX_EVAL_CHARS)}…[${json.length - MAX_EVAL_CHARS} more characters]` : json }
      }
    }

    const evaluated = await cdp.send('Runtime.evaluate', { expression: SUMMARY_SCRIPT, returnByValue: true }, sessionId).catch(() => null)
    const info = evaluated?.result?.value ? JSON.parse(evaluated.result.value) : null
    const summaryLines: string[] = []
    if (info) {
      summaryLines.push(`${info.elements} elements; ${info.canvases.length ? `canvas ${info.canvases.join(', ')}` : 'no canvas'}`)
      if (info.text) summaryLines.push(`Visible text:\n${info.text}${info.more ? `\n…[${info.more} more characters]` : ''}`)
      else summaryLines.push('No visible text.')
    }
    let screenshot: string | undefined
    if (options.screenshot !== false) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId).catch(() => null)
      if (shot?.data) screenshot = shot.data
    }
    const result: PageCheck = { url: options.url, loaded, title: info?.title ?? '', events, summary: summaryLines.join('\n'), durationMs: Date.now() - started }
    if (screenshot) result.screenshot = screenshot
    if (stepOutcomes.length) result.steps = stepOutcomes
    if (inspections.length) result.inspections = inspections
    if (shots.length) result.shots = shots
    if (evaluation) result.evaluation = evaluation
    if (options.viewport) result.viewport = `${options.viewport.width}x${options.viewport.height}${options.viewport.mobile ? ' (mobile)' : ''}`
    await cdp.send('Browser.close').catch(() => undefined)
    return result
  } finally {
    cdp?.close()
    if (child) killTree(child)
    // The profile can stay locked for a moment after the browser exits.
    setTimeout(() => fs.rm(profile, { recursive: true, force: true }, () => {}), 2_000).unref()
  }
}

/** The text the model reads. */
export function formatPageCheck(check: PageCheck, screenshotPath: string | null): string {
  const counts = { exception: 0, error: 0, warning: 0, 'request-failed': 0, log: 0 }
  for (const e of check.events) counts[e.kind]++
  const problems = counts.exception + counts.error + counts['request-failed']
  const lines = [
    `${check.url} — ${check.loaded ? 'loaded' : 'did NOT finish loading'}${check.title ? `, title "${check.title}"` : ''}${check.viewport ? ` at ${check.viewport}` : ''} (${(check.durationMs / 1000).toFixed(1)}s)`,
    problems === 0
      ? `No errors${counts.warning ? `, ${counts.warning} warning(s)` : ''}.`
      : `${counts.exception} uncaught exception(s), ${counts.error} console error(s), ${counts['request-failed']} failed request(s), ${counts.warning} warning(s).`,
  ]
  const order: PageEvent['kind'][] = ['exception', 'error', 'request-failed', 'warning', 'log']
  const sorted = [...check.events].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
  if (check.steps?.length) {
    const failed = check.steps.find((s) => !s.ok)
    if (failed) lines.push(`Step ${check.steps.indexOf(failed) + 1} (${failed.step}) failed: ${failed.error}. The steps after it did not run.`)
    lines.push('--- steps ---', ...check.steps.map((s, i) => `${i + 1}. ${s.step} — ${s.ok ? 'ok' : `FAILED: ${s.error}`}`))
  }
  if (sorted.length) lines.push('--- console ---', ...sorted.map((e) => `[${e.kind}]${e.afterStep ? ` (after step ${e.afterStep})` : ''} ${e.text}`))
  for (const i of check.inspections ?? []) lines.push(`--- inspect ${i.selector} ---`, i.text)
  if (check.evaluation) lines.push('--- eval ---', check.evaluation.ok ? check.evaluation.text : `threw: ${check.evaluation.text}`)
  if (check.summary) lines.push('--- page ---', check.summary)
  if (screenshotPath) lines.push(`Screenshot saved to ${screenshotPath}.`)
  return lines.join('\n')
}
