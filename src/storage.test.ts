import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { parseCredential } from './storage.ts'

describe('parseCredential', () => {
  test('round-trips both credential kinds', () => {
    assert.deepEqual(parseCredential({ kind: 'session', token: 't', username: 'ada' }), {
      kind: 'session',
      token: 't',
      username: 'ada',
    })
    assert.deepEqual(parseCredential({ kind: 'apiKey', key: 'rst_x' }), { kind: 'apiKey', key: 'rst_x' })
  })

  test('rejects anything it does not recognise rather than passing it through', () => {
    // Whatever comes back becomes an Authorization header. A half-parsed blob
    // must not get that far.
    for (const value of [
      null,
      undefined,
      'a string',
      42,
      {},
      { kind: 'session' },
      { kind: 'session', token: 't' },
      { kind: 'session', token: 123, username: 'ada' },
      { kind: 'apiKey' },
      { kind: 'apiKey', key: null },
      { kind: 'something-else', token: 't', username: 'ada' },
    ]) {
      assert.equal(parseCredential(value), null, `should reject: ${JSON.stringify(value)}`)
    }
  })

  test('drops extra fields instead of preserving them', () => {
    const parsed = parseCredential({ kind: 'apiKey', key: 'rst_x', injected: 'nope' })
    assert.deepEqual(parsed, { kind: 'apiKey', key: 'rst_x' })
  })
})
