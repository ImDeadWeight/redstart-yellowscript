import { expect, pass, run } from '../_lib/check.mjs'

const r = run(process.execPath, ['src/main.js'])
expect(r.status === 0, `node src/main.js still fails (exit ${r.status}):\n${r.stderr.slice(-500)}`)
const want = 'Players: 3\nBest: Lin (19)\nTotal: 42'
expect(r.stdout.trim().replace(/\r/g, '') === want, `printed:\n${r.stdout.trim()}\nexpected:\n${want}`)
pass('runs and prints the report')
