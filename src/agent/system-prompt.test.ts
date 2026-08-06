import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { buildSystemPrompt } from './system-prompt.ts'

const TOOLS = ['ws_read_file', 'ws_glob', 'ws_diagnostics']

describe('buildSystemPrompt', () => {
  test('names the environment the model is running in', () => {
    // Not capability — environment. It changes tone and strategy, and unlike a
    // capability list it stays true across versions.
    const prompt = buildSystemPrompt(TOOLS)
    assert.match(prompt, /Yellowscript/)
    assert.match(prompt, /Visual Studio Code/)
  })

  test('lists exactly the tools it was given', () => {
    const prompt = buildSystemPrompt(TOOLS)
    for (const name of TOOLS) assert.ok(prompt.includes(name), `missing ${name}`)
  })

  test('sorts the list so a repeated request is byte-identical', () => {
    // Prompt caching holds only while the prefix matches, and registry order is
    // not something this should depend on.
    assert.equal(buildSystemPrompt(['ws_b', 'ws_a']), buildSystemPrompt(['ws_a', 'ws_b']))
  })

  test('states that the list is complete', () => {
    // The whole point: the gateway has already told the model it can create
    // documents and edit files, describing what NEST has rather than what this
    // client forwards.
    const prompt = buildSystemPrompt(TOOLS)
    assert.match(prompt, /list is complete/i)
    assert.match(prompt, /whatever you may have been told elsewhere/i)
  })

  test('forbids claiming work that no tool call produced', () => {
    const prompt = buildSystemPrompt(TOOLS)
    assert.match(prompt, /never describe work as done when no tool call produced it/i)
  })

  test('does not enumerate prohibitions, so it cannot go stale', () => {
    // A prompt saying "you cannot write files" needs editing in lockstep with
    // the tool set, and is wrong the first time someone forgets — which is the
    // same bug this exists to fix, one level up. The limits are phrased against
    // the list instead.
    const readOnly = buildSystemPrompt(TOOLS)
    assert.ok(!/cannot write files/i.test(readOnly))
    assert.ok(!/cannot run/i.test(readOnly))

    // Adding a write tool must not contradict anything already written.
    const withWrite = buildSystemPrompt([...TOOLS, 'ws_write_file'])
    assert.ok(withWrite.includes('ws_write_file'))
    assert.match(withWrite, /list is complete/i)
  })

  test('survives an empty tool list without claiming anything', () => {
    // Not expected — the caller only sends this when tools are going out — but
    // it must not produce a prompt that implies capabilities.
    const prompt = buildSystemPrompt([])
    assert.match(prompt, /list is complete/i)
  })
})
