import { pathToFileURL } from 'node:url'
import { callsOf, checkPageHeadless, expect, file, pass } from '../_lib/check.mjs'

expect(callsOf('ys_process_start').some((c) => /server\.js|npm run dev/.test(c.args)), 'the server was never started with ys_process_start')
expect(callsOf('ys_check_page').length >= 2, `ys_check_page ran ${callsOf('ys_check_page').length} time(s); expected a check before and after the fix`)
expect(callsOf('ys_process_stop').length > 0, 'the server was never stopped')
const page = await checkPageHeadless(pathToFileURL(file('public/index.html')).href)
expect(page !== null, 'no browser on this machine to load the page')
const problems = page.events.filter((e) => e.kind === 'exception' || e.kind === 'error')
expect(problems.length === 0, `the page still reports: ${problems.map((e) => e.text).join(' | ').slice(0, 300)}`)
expect(/Ada: 12/.test(page.summary) && /Lin: 19/.test(page.summary), 'the scores are not on the page')
pass('started, checked, fixed, re-checked, stopped; the page renders the scores')
