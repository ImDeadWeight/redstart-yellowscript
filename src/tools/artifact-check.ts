// =============================================================================
// artifact_check — Yellowscript's answer to Nest's host-resolved tool.
// =============================================================================
// Nest defines artifact_check (redstart-project artifacts plan D11) and offers
// it only to a client that declared it can answer it: this one does, with the
// headless page check ys_check_page already runs, plus a screenshot.
//
// The URL is never the model's. The artifact's id is: Nest checks this
// account can read it and issues a short-lived view URL on its separate
// content origin (POST /artifacts/:id/view), and that is what the browser
// loads, top-level, under the content origin's own sandbox policy. So this
// does not widen what ys_check_page accepts as a target.
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { checkPage, formatPageCheck, type PageCheck, type PageEvent } from '../browser/page-check.ts'
import { toolError, toolOk, type ToolResult } from './types.ts'

export const ARTIFACT_CHECK_TOOL = 'artifact_check'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The plan's widths (chat-ui's viewer uses the same). */
export const VIEWPORTS = {
  desktop: { width: 1280, height: 900, mobile: false },
  tablet: { width: 820, height: 1180, mobile: true },
  phone: { width: 390, height: 844, mobile: true },
} as const

export interface ArtifactCheckDeps {
  /** POST /artifacts/:id/view on the Nest this window is signed in to. */
  view: (id: string) => Promise<{ url: string; revision: number | 'draft' }>
  /** GET /artifacts/:id, for the title. */
  title: (id: string) => Promise<string>
  browser: () => string | null
  screenshotDir: () => string | null
  /** Tests replace the browser. */
  check?: typeof checkPage
}

/** Run artifact_check. Never throws: a failure is a sentence the model can act on. */
export async function runArtifactCheck(args: unknown, deps: ArtifactCheckDeps): Promise<ToolResult> {
  const a = (typeof args === 'object' && args !== null ? args : {}) as { id?: unknown; viewport?: unknown }
  const id = typeof a.id === 'string' ? a.id.trim() : ''
  if (!ID.test(id)) return toolError('artifact_check needs "id": the artifact to check (from artifact_create or artifact_list).')
  const viewportName = a.viewport === 'tablet' || a.viewport === 'phone' ? a.viewport : 'desktop'
  const browser = deps.browser()
  if (!browser) {
    return toolError(
      'No Chrome, Edge or Chromium was found on this machine, so the artifact cannot be checked. ' +
        'Set the YELLOWSCRIPT_BROWSER environment variable to a browser executable.',
    )
  }

  let view: { url: string; revision: number | 'draft' }
  let title = id
  try {
    view = await deps.view(id)
    title = await deps.title(id).catch(() => id)
  } catch (err) {
    return toolError(`Could not open the artifact: ${err instanceof Error ? err.message : String(err)}`)
  }

  let check: PageCheck
  try {
    check = await (deps.check ?? checkPage)({ url: view.url, browser, screenshot: true, viewport: VIEWPORTS[viewportName] })
  } catch (err) {
    return toolError(`The artifact check failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  let saved: string | null = null
  const dir = deps.screenshotDir()
  if (check.screenshot && dir) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      saved = path.join(dir, `artifact-${id.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
      fs.writeFileSync(saved, Buffer.from(check.screenshot, 'base64'))
    } catch {
      saved = null
    }
  }

  const order: PageEvent['kind'][] = ['exception', 'error', 'request-failed']
  const problems = check.events.filter((e) => order.includes(e.kind))
  const rev = view.revision === 'draft' ? 'your unsaved draft' : `revision ${view.revision}`
  // The page check names the URL it loaded; the token in it is no business of
  // the model's, and the line would be noise.
  const report = formatPageCheck(check, saved).split(view.url).join('the artifact')
  const result = toolOk(
    `Checked "${title}" (${rev}) at ${viewportName} width (${VIEWPORTS[viewportName].width} px).\n${report}`,
    `artifact_check — ${problems.length || !check.loaded ? 'problems found' : 'no errors'}`,
  )
  if (check.screenshot) result.images = [`data:image/png;base64,${check.screenshot}`]
  return result
}
