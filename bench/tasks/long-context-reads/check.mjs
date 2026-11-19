import { readFileSync } from 'node:fs'
import { callsOf, expect, pass, result } from '../_lib/check.mjs'

const { total } = JSON.parse(readFileSync(new URL('./expected.json', import.meta.url), 'utf8'))
expect(result.stopReason === 'complete', `the run ended as "${result.stopReason}", not complete`)
const reads = new Set(callsOf('ys_read_file').map((c) => (/level-(\d+)/.exec(c.args) ?? [])[1]).filter(Boolean))
expect(reads.size === 30, `read ${reads.size} of the 30 files with ys_read_file`)
const m = /Total:\s*\**\s*([\d,]+)/i.exec(result.answer)
expect(m, 'the answer has no "Total: <number>"')
const got = Number(m[1].replace(/,/g, ''))
expect(got === total, `answered ${got}, the total is ${total}`)
pass(`read all 30 files and answered ${total}`)
