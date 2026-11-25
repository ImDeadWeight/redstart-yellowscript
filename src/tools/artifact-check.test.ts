import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { runArtifactCheck, VIEWPORTS, type ArtifactCheckDeps } from './artifact-check.ts'
import { artifactCardsFrom, mergeCards, safeUrl } from '../chat/artifact-cards.ts'
import { mergeNestTools, createToolRegistry, type NestToolRef } from './registry.ts'
import { parseWebviewMessage } from '../chat/protocol.ts'
import { HOST_RESOLVED_TOOLS } from '../nest/mcp-host.ts'
import type { PageCheck } from '../browser/page-check.ts'

// artifacts plan §11: Yellowscript answers Nest's artifact_check with its
// own page check, and draws artifact cards with Open in Redstart.

const ID = '12345678-1234-1234-1234-123456789abc'
const VIEW = `http://192.168.0.5:19085/a/tok.sig/index.html`

function deps(over: Partial<ArtifactCheckDeps> = {}): ArtifactCheckDeps & { loaded: string[] } {
  const loaded: string[] = []
  return {
    loaded,
    view: async () => ({ url: VIEW, revision: 3 }),
    title: async () => 'Dashboard',
    browser: () => 'msedge',
    screenshotDir: () => null,
    check: async (o) => {
      loaded.push(`${o.url} ${o.viewport?.width}`)
      return { url: o.url, loaded: true, title: 'Dash', events: [{ kind: 'exception', text: 'ReferenceError: x' }], screenshot: 'iVBORw0KGgo=' } as unknown as PageCheck
    },
    ...over,
  }
}

describe('artifact_check', () => {
  test('checks the URL Nest issued, at the asked width, with the screenshot', async () => {
    const d = deps()
    const r = await runArtifactCheck({ id: ID, viewport: 'phone' }, d)
    assert.equal(r.isError, false, r.content)
    assert.deepEqual(d.loaded, [`${VIEW} ${VIEWPORTS.phone.width}`])
    assert.match(r.content, /^Checked "Dashboard" \(revision 3\) at phone width \(390 px\)\./)
    assert.ok(!r.content.includes('tok.sig'), 'the view token reached the model')
    assert.deepEqual(r.images, ['data:image/png;base64,iVBORw0KGgo='])
    assert.match(r.summary, /problems found/)
  })

  test('the model gives an id, never a URL', async () => {
    const d = deps()
    for (const bad of [{}, { id: 'http://evil.example/' }, { id: '../x' }, { target: VIEW }]) {
      const r = await runArtifactCheck(bad, d)
      assert.equal(r.isError, true)
    }
    assert.equal(d.loaded.length, 0, 'a page was loaded for a bad id')
  })

  test('no browser, or Nest refusing, is a sentence', async () => {
    assert.match((await runArtifactCheck({ id: ID }, deps({ browser: () => null }))).content, /No Chrome, Edge or Chromium/)
    const refused = await runArtifactCheck({ id: ID }, deps({ view: async () => { throw new Error('Not found') } }))
    assert.equal(refused.isError, true)
    assert.match(refused.content, /Could not open the artifact: Not found/)
  })

  test('declared as a host tool, and run here instead of on Nest', async () => {
    assert.ok((HOST_RESOLVED_TOOLS as readonly string[]).includes('artifact_check'))
    let onNest = 0
    const ref: NestToolRef = {
      name: 'artifact_check', description: 'd', inputSchema: {},
      execute: async () => { onNest++; return 'from Nest' },
      executeLocal: async () => ({ content: 'checked here', isError: false, summary: 's', truncated: false }),
    }
    const local = createToolRegistry({
      ripgrepPath: null,
      diagnostics: () => [],
      editorState: () => ({ openFiles: [], activeFile: null, languageId: null, isDirty: false, cursor: null, selection: null }),
    })
    const merged = mergeNestTools(local, [ref])
    const tool = merged.tools.find((t) => t.definition.name === 'artifact_check')!
    const r = await tool.execute({ id: ID }, { workspaceRoots: [] })
    assert.equal(r.content, 'checked here')
    assert.equal(onNest, 0)
  })
})

describe('artifact cards', () => {
  const result = `Created artifact ${ID} "Sales dashboard" (web) in the project "Billing".\nOpen: https://abc.nest.redstartdevelopment.com/#/artifacts/${ID}\n[artifact: ${ID} draft]`

  test('a card per artifact line, with Nest\'s link and the title', () => {
    assert.deepEqual(artifactCardsFrom(result), [{ id: ID, revision: 'draft', title: 'Sales dashboard', url: `https://abc.nest.redstartdevelopment.com/#/artifacts/${ID}` }])
    assert.deepEqual(artifactCardsFrom('no artifact here'), [])
  })

  test('a link that is not http(s), or names another artifact, is dropped', () => {
    for (const bad of [`Open: javascript:alert(1)`, `Open: https://abc.example/#/artifacts/00000000-0000-0000-0000-000000000000`, `Open: https://user:pw@abc.example/#/artifacts/${ID}`]) {
      const cards = artifactCardsFrom(`${bad}\n[artifact: ${ID} r2]`)
      assert.equal(cards[0]!.url, undefined, bad)
    }
    assert.equal(safeUrl('file:///etc/passwd'), false)
  })

  test('a later result updates the card and keeps what it lacks', () => {
    const merged = mergeCards(artifactCardsFrom(result), [{ id: ID, revision: 4 }])
    assert.equal(merged.length, 1)
    assert.equal(merged[0]!.revision, 4)
    assert.equal(merged[0]!.title, 'Sales dashboard')
  })

  test('Open in Redstart names a turn and an id, nothing else', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'openArtifact', turnId: 't1', id: ID }), { type: 'openArtifact', turnId: 't1', id: ID })
    assert.equal(parseWebviewMessage({ type: 'openArtifact', turnId: 't1' }), null)
  })
})
