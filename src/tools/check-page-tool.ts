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

import * as fs from 'node:fs'
import * as path from 'node:path'

import { checkPage, formatPageCheck, resolveTarget, type PageCheck, type PageEvent } from '../browser/page-check.ts'
import { parseSteps, parseViewport } from './page-steps.ts'
import { assertWorkspaceToolName, stringArg, toolError, toolOk, type Tool, type ToolContext, type ToolResult } from './types.ts'

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
        '(title, canvases, text), with a screenshot. Steps act on it after load, in order; eval reads a value ' +
        'after them. A game: {"steps": [{"key": "ArrowRight", "hold_ms": 800}, {"key": "Space"}], "eval": ' +
        '"window.__game.player"} (a game exposes its state as window.__game). A form: {"steps": [{"type": "hi", "into": "#q"}, {"click": "#go"}, ' +
        '{"wait_for": ".results li"}]}.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'http://localhost:… URL, or a workspace .html path.' },
          wait_s: { type: 'number', description: "Seconds to run after load, so a game loop's errors show (default 2, max 15)." },
          steps: {
            type: 'array',
            description: 'One action each: key (+hold_ms), click (selector or [x, y]), type (+into), wait_ms, wait_for, screenshot, inspect.',
            items: { type: 'object' },
          },
          eval: { type: 'string', description: 'A JS expression; its JSON value is reported.' },
          viewport: { type: 'string', description: 'e.g. "390x844".' },
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
      const o = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
      const parsed = parseSteps(o.steps)
      if ('error' in parsed) return toolError(parsed.error)
      const viewport = parseViewport(o.viewport)
      if (viewport && 'error' in viewport) return toolError(viewport.error)
      const expression = typeof o.eval === 'string' && o.eval.trim() ? o.eval : undefined
      let check: PageCheck
      try {
        check = await checkPage({
          url: resolved.url,
          browser,
          ...(Number.isFinite(waitS) ? { waitMs: waitS * 1000 } : {}),
          ...(parsed.steps.length ? { steps: parsed.steps } : {}),
          ...(expression ? { evaluate: expression } : {}),
          ...(viewport ? { viewport } : {}),
        })
      } catch (err) {
        return toolError(`The page check failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      let saved: string | null = null
      const dir = deps.screenshotDir()
      if (check.screenshot && dir) {
        try {
          fs.mkdirSync(dir, { recursive: true })
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          // The labelled ones are for the person; only the last goes to the model.
          for (const shot of check.shots ?? []) fs.writeFileSync(path.join(dir, `page-${stamp}-${shot.label}.png`), Buffer.from(shot.data, 'base64'))
          saved = path.join(dir, `page-${stamp}.png`)
          fs.writeFileSync(saved, Buffer.from(check.screenshot, 'base64'))
        } catch {
          saved = null
        }
      }
      const order: PageEvent['kind'][] = ['exception', 'error', 'request-failed']
      const problems = check.events.filter((e) => order.includes(e.kind)).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
      const failedStep = check.steps?.find((s) => !s.ok)
      const result = toolOk(formatPageCheck(check, saved), `ys_check_page — ${failedStep ? 'a step failed' : problems.length ? 'problems found' : 'no errors'}`)
      result.effect = {
        kind: 'check',
        target: resolved.url,
        problems: problems.length + (check.loaded ? 0 : 1) + (failedStep ? 1 : 0),
        first: !check.loaded ? 'did not finish loading' : failedStep ? `step ${failedStep.step} failed: ${failedStep.error}` : (problems[0]?.text.split('\n')[0]!.slice(0, 160) ?? null),
      }
      if (check.screenshot) result.images = [`data:image/png;base64,${check.screenshot}`]
      return result
    },
  }
}
