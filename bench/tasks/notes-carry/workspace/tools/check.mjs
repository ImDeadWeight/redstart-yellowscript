// The project's test runner. Suites: unit, smoke.
import assert from 'node:assert/strict'
import { balance, byMonth } from '../src/ledger.js'

const suite = process.argv[process.argv.indexOf('--suite') + 1]
const suites = {
  unit: {
    'empty balance is zero': () => assert.equal(balance([]), 0),
    'credits add': () => assert.equal(balance([{ kind: 'credit', amount: 5 }]), 5),
    'debits subtract': () => assert.equal(balance([{ kind: 'debit', amount: 5 }]), -5),
    'months group': () => assert.deepEqual(Object.keys(byMonth([{ date: '2026-01-02' }, { date: '2026-02-01' }])), ['2026-01', '2026-02']),
  },
  smoke: { 'loads': () => assert.ok(balance) },
}
if (!process.argv.includes('--suite') || !suites[suite]) {
  console.error('Choose a suite: node tools/check.mjs --suite unit|smoke')
  process.exit(2)
}
let passed = 0
let failed = 0
for (const [name, fn] of Object.entries(suites[suite])) {
  try {
    fn()
    passed++
  } catch (err) {
    failed++
    console.log(`FAIL ${name}: ${err.message}`)
  }
}
console.log(`${suite}: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
