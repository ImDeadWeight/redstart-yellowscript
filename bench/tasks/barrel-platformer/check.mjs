import { pathToFileURL } from 'node:url'
import { callsOf, checkPageHeadless, exists, expect, file, pass, read, result } from '../_lib/check.mjs'

expect(exists('index.html'), 'there is no index.html')
const sources = ['index.html', 'game.js'].filter(exists).map(read).join('\n')
for (const [what, re] of [
  ['the rAF game loop', /requestAnimationFrame/],
  ['ArrowLeft/ArrowRight', /ArrowLeft[\s\S]*ArrowRight|ArrowRight[\s\S]*ArrowLeft/],
  ['ArrowUp/ArrowDown for ladders', /ArrowUp[\s\S]*ArrowDown|ArrowDown[\s\S]*ArrowUp/],
  ['Space to jump', /['"]( |Space)['"]|keyCode\s*===?\s*32/],
  ['ladders', /ladder/i],
  ['barrels', /barrel/i],
  ['lives', /lives/i],
]) expect(re.test(sources), `no sign of ${what}`)
expect((result.plan ?? []).length > 0, 'no plan was kept with update_plan')
expect(callsOf('ys_check_page').length > 0, 'the page was never checked')
const page = await checkPageHeadless(pathToFileURL(file('index.html')).href)
expect(page !== null, 'no browser on this machine to load the page')
const problems = page.events.filter((e) => e.kind === 'exception' || e.kind === 'error')
expect(problems.length === 0, `the page reports: ${problems.map((e) => e.text).join(' | ').slice(0, 400)}`)
expect(/canvas 800x600/.test(page.summary), `expected an 800x600 canvas: ${page.summary.split('\n')[0]}`)
pass('runs without errors with every listed mechanic present; playability is for a person to judge')
