import { pathToFileURL } from 'node:url'
import { callsOf, checkPageHeadless, exists, expect, file, pass, read } from '../_lib/check.mjs'

expect(exists('index.html'), 'there is no index.html')
const html = read('index.html')
expect(/<canvas/i.test(html), 'index.html has no <canvas>')
expect(/requestAnimationFrame/.test(html), 'the game loop does not use requestAnimationFrame')
expect(/ArrowUp/.test(html) && /ArrowDown/.test(html), 'no ArrowUp/ArrowDown handling')
expect(/['"](w|KeyW)['"]/i.test(html) && /['"](s|KeyS)['"]/i.test(html), 'no W/S handling')
expect(callsOf('ys_check_page').length > 0, 'the page was never checked with ys_check_page')
const page = await checkPageHeadless(pathToFileURL(file('index.html')).href)
expect(page !== null, 'no browser on this machine to load the page')
const problems = page.events.filter((e) => e.kind === 'exception' || e.kind === 'error')
expect(problems.length === 0, `the page reports: ${problems.map((e) => e.text).join(' | ').slice(0, 400)}`)
expect(/canvas 640x480/.test(page.summary), `expected a 640x480 canvas, page shows: ${page.summary.split('\n')[0]}`)
pass('loads without errors, 640x480 canvas, rAF loop, both control schemes')
