// =============================================================================
// ys_check_page — load a page in a headless browser and report what happened.
// =============================================================================
// A model writing a canvas game or a website cannot see it run. This loads the
// page in a browser the machine already has (Edge, Chrome or Chromium, run
// headless with a throwaway profile), lets it run for a moment, and returns
// what a developer would look at first:
//
// - uncaught exceptions and console errors and warnings (the game loop that
//   throws on its third frame shows up here),
// - requests that failed (a 404 on a sprite or a script),
// - a DOM summary: title, canvases and their sizes, the visible text,
// - a screenshot, saved for the person, and given to the model only when it
//   can read images.
//
// It speaks the Chrome DevTools Protocol over Node's built-in WebSocket, so it
// needs no npm dependency and no browser download.
//
// SCOPE: only loopback URLs (a dev server on this machine) and files inside the
// workspace. It is a read-only check of the user's own work, not a web browser
// for the model, so there is nothing to approve and nothing it can reach out to.
//
// No `vscode` import.
// =============================================================================

import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { killTree } from './process-runner.ts'
import { assertWorkspaceToolName, stringArg, toolError, toolOk, type Tool, type ToolContext, type ToolResult } from './types.ts'
import { PathScopeError, resolveWithinWorkspace } from './workspace-path.ts'

export const DEFAULT_WAIT_MS = 2_000
export const MAX_WAIT_MS = 15_000
const LOAD_TIMEOUT_MS = 15_000
const MAX_EVENTS = 40
const MAX_TEXT_CHARS = 1_500

/** Where browsers usually live; the first that exists is used. */
export function browserCandidates(platform = process.platform, env = process.env): string[] {
  const fromEnv = env.YELLOWSCRIPT_BROWSER ? [env.YELLOWSCRIPT_BROWSER] : []
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES(X86)'], env.PROGRAMFILES, env.LOCALAPPDATA].filter((r): r is string => !!r)
    return [
      ...fromEnv,
      ...roots.map((r) => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
      ...roots.map((r) => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ]
  }
  if (platform === 'darwin') {
    return [
      ...fromEnv,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  }
  return [...fromEnv, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium']
}

export function findBrowser(candidates = browserCandidates()): string | null {
  return candidates.find((p) => fs.existsSync(p)) ?? null
}

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
  try {
    const file = resolveWithinWorkspace(roots, trimmed)
    if (!fs.existsSync(file)) return { error: `"${trimmed}" does not exist.` }
    return { url: pathToFileURL(file).toString() }
  } catch (err) {
    if (err instanceof PathScopeError) return { error: `"${trimmed}" is outside the workspace.` }
    return { error: `Could not resolve "${trimmed}": ${err instanceof Error ? err.message : String(err)}` }
  }
}

export interface PageEvent {
  kind: 'exception' | 'error' | 'warning' | 'log' | 'request-failed'
  text: string
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
}

/** A minimal CDP client over one browser WebSocket, flat sessions. */
class Cdp {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private readonly listeners: Array<(method: string, params: any, sessionId?: string) => void> = []
  private readonly ws: WebSocket

  constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data))
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'))
        else p.resolve(msg.result)
      } else if (msg.method) {
        for (const l of this.listeners) l(msg.method, msg.params, msg.sessionId)
      }
    })
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.addEventListener('open', () => resolve(new Cdp(ws)), { once: true })
      ws.addEventListener('error', () => reject(new Error('could not connect to the browser')), { once: true })
    })
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  on(listener: (method: string, params: any, sessionId?: string) => void): void {
    this.listeners.push(listener)
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // closing anyway
    }
  }
}

/** Start the browser and resolve with its DevTools WebSocket URL. */
function launch(browser: string, profile: string): Promise<{ child: ChildProcess; wsUrl: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--mute-audio',
        '--window-size=1280,800',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    )
    let stderr = ''
    const timer = setTimeout(() => {
      killTree(child)
      reject(new Error('the browser did not start within 15s'))
    }, LOAD_TIMEOUT_MS)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr)
      if (m) {
        clearTimeout(timer)
        // Nothing more is read from stderr; a held pipe would keep Node alive.
        child.stderr?.removeAllListeners('data')
        child.stderr?.destroy()
        child.unref()
        resolve({ child, wsUrl: m[1]! })
      }
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the browser exited (code ${code}) before it was ready`))
    })
  })
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

/** Load `url` headless, wait `waitMs` after load, and report. */
export async function checkPage(options: { url: string; browser: string; waitMs?: number; screenshot?: boolean }): Promise<PageCheck> {
  const started = Date.now()
  const waitMs = Math.min(Math.max(0, options.waitMs ?? DEFAULT_WAIT_MS), MAX_WAIT_MS)
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-browser-'))
  let child: ChildProcess | undefined
  let cdp: Cdp | undefined
  const events: PageEvent[] = []
  const push = (e: PageEvent) => {
    if (events.length < MAX_EVENTS) events.push({ kind: e.kind, text: e.text.slice(0, 500) })
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
    const nav = await cdp.send('Page.navigate', { url: options.url }, sessionId)
    if (nav.errorText) push({ kind: 'request-failed', text: `navigation failed: ${nav.errorText}` })
    else {
      let loadTimer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([loadedPromise, new Promise((r) => (loadTimer = setTimeout(r, LOAD_TIMEOUT_MS)))])
      // Cleared, or it holds every check (and the extension host's tests) for 15s.
      clearTimeout(loadTimer)
    }
    // Let it run: a game loop's errors arrive after load.
    await new Promise((r) => setTimeout(r, waitMs))

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
    `${check.url} — ${check.loaded ? 'loaded' : 'did NOT finish loading'}${check.title ? `, title "${check.title}"` : ''} (${(check.durationMs / 1000).toFixed(1)}s)`,
    problems === 0
      ? `No errors${counts.warning ? `, ${counts.warning} warning(s)` : ''}.`
      : `${counts.exception} uncaught exception(s), ${counts.error} console error(s), ${counts['request-failed']} failed request(s), ${counts.warning} warning(s).`,
  ]
  const order: PageEvent['kind'][] = ['exception', 'error', 'request-failed', 'warning', 'log']
  const sorted = [...check.events].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
  if (sorted.length) lines.push('--- console ---', ...sorted.map((e) => `[${e.kind}] ${e.text}`))
  if (check.summary) lines.push('--- page ---', check.summary)
  if (screenshotPath) lines.push(`Screenshot saved to ${screenshotPath}.`)
  return lines.join('\n')
}

export interface CheckPageDeps {
  /** The browser to drive, or null when none was found. */
  browser: () => string | null
  /** Where screenshots are saved (absolute directory), or null to not save. */
  screenshotDir: () => string | null
}

export function createCheckPageTool(deps: CheckPageDeps): Tool {
  return {
    definition: {
      name: assertWorkspaceToolName('ys_check_page'),
      description:
        'Load a page headless and report exceptions, console errors, failed requests and what it shows ' +
        '(title, canvases, text), with a screenshot. Use it after changing a page or a canvas game.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'http://localhost:… URL, or a workspace .html path.' },
          wait_s: { type: 'number', description: "Seconds to run after load, so a game loop's errors show (default 2, max 15)." },
        },
        required: ['target'],
        additionalProperties: false,
      },
    },
    async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
      const target = stringArg(args, 'target')
      if (!target) return toolError('ys_check_page requires a "target": a localhost URL or a workspace HTML file.')
      const resolved = resolveTarget(target, context.workspaceRoots)
      if ('error' in resolved) return toolError(resolved.error)
      const browser = deps.browser()
      if (!browser) {
        return toolError(
          'No Chrome, Edge or Chromium was found on this machine, so the page cannot be checked. ' +
            'Set the YELLOWSCRIPT_BROWSER environment variable to a browser executable.',
        )
      }
      const waitS = Number((args as { wait_s?: unknown })?.wait_s)
      let check: PageCheck
      try {
        check = await checkPage({ url: resolved.url, browser, ...(Number.isFinite(waitS) ? { waitMs: waitS * 1000 } : {}) })
      } catch (err) {
        return toolError(`The page check failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      let saved: string | null = null
      const dir = deps.screenshotDir()
      if (check.screenshot && dir) {
        try {
          fs.mkdirSync(dir, { recursive: true })
          saved = path.join(dir, `page-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
          fs.writeFileSync(saved, Buffer.from(check.screenshot, 'base64'))
        } catch {
          saved = null
        }
      }
      const order: PageEvent['kind'][] = ['exception', 'error', 'request-failed']
      const problems = check.events.filter((e) => order.includes(e.kind)).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
      const result = toolOk(formatPageCheck(check, saved), `ys_check_page — ${problems.length ? 'problems found' : 'no errors'}`)
      result.effect = {
        kind: 'check',
        target: resolved.url,
        problems: problems.length + (check.loaded ? 0 : 1),
        first: check.loaded ? (problems[0]?.text.split('\n')[0]!.slice(0, 160) ?? null) : 'did not finish loading',
      }
      if (check.screenshot) result.images = [`data:image/png;base64,${check.screenshot}`]
      return result
    },
  }
}
