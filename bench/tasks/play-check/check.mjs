// Space must make the player leave the ground, checked the way the model was
// asked to check it: steps and an eval on index.html?test. The run must have
// used steps and eval itself, not only loaded the page.
import { pathToFileURL } from 'node:url'
import { callsOf, checkPageHeadless, expect, file, pass } from '../_lib/check.mjs'

const url = `${pathToFileURL(file('index.html')).href}?test`
const read = '({ y: __game.player.y, x: __game.player.x })'
const before = await checkPageHeadless(url, { waitMs: 300, evaluate: read })
expect(before !== null, 'no browser on this machine to load the page')
const errors = before.events.filter((e) => e.kind === 'exception' || e.kind === 'error')
expect(errors.length === 0, `the page reports: ${errors.map((e) => e.text).join(' | ').slice(0, 300)}`)
const rest = JSON.parse(before.evaluation?.text ?? 'null')
expect(rest && rest.y === 260, `the player should start on the ground (y 260): ${before.evaluation?.text}`)

const jumped = await checkPageHeadless(url, { waitMs: 300, steps: [{ key: 'Space' }, { wait_ms: 150 }], evaluate: read })
const air = JSON.parse(jumped.evaluation?.text ?? 'null')
expect(air && air.y < 240, `after Space the player is at y ${air?.y}; it did not jump`)

const ran = await checkPageHeadless(url, { waitMs: 300, steps: [{ key: 'ArrowRight', hold_ms: 400 }], evaluate: read })
const moved = JSON.parse(ran.evaluation?.text ?? 'null')
expect(moved && moved.x > 40, 'ArrowRight no longer moves the player')

const proof = callsOf('ys_check_page').some((c) => /"steps"/.test(c.args) && /"eval"/.test(c.args))
expect(proof, 'the run never checked the page with steps and an eval')
pass(`Space lifts the player to y ${Math.round(air.y)}; checked with steps and eval`)
