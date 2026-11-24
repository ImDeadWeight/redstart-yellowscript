// =============================================================================
// Tests for the Settings page's list: it matches package.json, and a value
// from the webview is checked before it is written.
// =============================================================================

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { parseWebviewMessage } from './protocol.ts'
import { coerceSetting, SETTING_GROUPS, SETTINGS } from './settings.ts'

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, { type: string; default: unknown; minimum?: number; maximum?: number; items?: { enum?: string[] } }> } }
}
const properties = manifest.contributes.configuration.properties
const PREFIX = 'redstartYellowscript.'

describe('the settings list', () => {
  test('every setting in package.json is on the page, and nothing else', () => {
    const declared = Object.keys(properties).map((k) => k.slice(PREFIX.length)).sort()
    assert.deepEqual(SETTINGS.map((s) => s.key).sort(), declared)
  })

  test('each matches its package.json type, default, range and options', () => {
    const types = { boolean: 'boolean', number: ['number', 'integer'], string: 'string', list: 'array' } as const
    for (const s of SETTINGS) {
      const p = properties[PREFIX + s.key]!
      assert.ok(([] as string[]).concat(types[s.kind]).includes(p.type), `${s.key}: ${s.kind} vs ${p.type}`)
      assert.deepEqual(s.defaultValue, p.default, `${s.key} default`)
      if (s.kind === 'number') assert.deepEqual([s.min, s.max], [p.minimum, p.maximum], `${s.key} range`)
      if (s.kind === 'list') assert.deepEqual(s.options, p.items?.enum, `${s.key} options`)
    }
  })

  test('every setting is in a known group', () => {
    for (const s of SETTINGS) assert.ok(SETTING_GROUPS.includes(s.group), s.key)
  })
})

describe('coerceSetting', () => {
  test('an unknown key or the wrong type is refused', () => {
    assert.equal(coerceSetting('nope', true), undefined)
    assert.equal(coerceSetting('autoConnect', 'yes'), undefined)
    assert.equal(coerceSetting('agent.maxTurns', '40'), undefined)
    assert.equal(coerceSetting('agent.maxTurns', Number.NaN), undefined)
    assert.equal(coerceSetting('allowedCommands', 'npm test'), undefined)
  })

  test('numbers are clamped to the range and rounded when whole', () => {
    assert.equal(coerceSetting('agent.maxTurns', 1), 5)
    assert.equal(coerceSetting('agent.maxTurns', 9_999), 500)
    assert.equal(coerceSetting('agent.maxTurns', 41.6), 42)
  })

  test('lists are trimmed, deduplicated and kept to their options', () => {
    assert.deepEqual(coerceSetting('allowedCommands', [' npm test ', 'npm test', '', 7]), ['npm test'])
    assert.deepEqual(coerceSetting('approvedWriteTools', ['ys_write_file', 'ys_run']), ['ys_write_file'])
  })

  test('strings are trimmed', () => {
    assert.equal(coerceSetting('serverUrl', '  http://nest:19080 '), 'http://nest:19080')
  })
})

describe('the settings messages', () => {
  test('loadPage accepts the settings page; updateSetting carries key and value', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'loadPage', page: 'settings' }), { type: 'loadPage', page: 'settings' })
    assert.equal(parseWebviewMessage({ type: 'loadPage', page: 'admin' }), null)
    assert.deepEqual(parseWebviewMessage({ type: 'updateSetting', key: 'autoConnect', value: false }), { type: 'updateSetting', key: 'autoConnect', value: false })
    assert.equal(parseWebviewMessage({ type: 'updateSetting', key: 'autoConnect' }), null)
  })
})
