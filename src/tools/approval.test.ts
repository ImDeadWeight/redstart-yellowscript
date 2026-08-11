// =============================================================================
// Tests for approval-tier policy and per-workspace "always allow".
// =============================================================================
// These prove the gate's decisions without any vscode: a missing memory never
// becomes a silent write, and a remembered approval is scoped to the store it
// was saved in.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  forgetApproval,
  isAutoApproved,
  isWritableTool,
  rememberApproval,
  type ApprovalStore,
} from './approval.ts'

function memory(initial: string[] = []): { store: ApprovalStore; saved: string[] } {
  const saved = [...initial]
  return {
    saved,
    store: {
      getAllowedTools: () => [...saved],
      setAllowedTools: (tools) => {
        saved.length = 0
        saved.push(...tools)
      },
    },
  }
}

describe('approval tiers', () => {
  it('writes are the writable tier; reads are not', () => {
    assert.equal(isWritableTool('ws_edit_file'), true)
    assert.equal(isWritableTool('ws_write_file'), true)
    assert.equal(isWritableTool('ws_read_file'), false)
    assert.equal(isWritableTool('rm -rf'), false)
  })

  it('a writable tool is not auto-approved until remembered', () => {
    const { store } = memory()
    assert.equal(isAutoApproved(store, 'ws_edit_file'), false)
  })

  it('a remembered approval auto-approves and is idempotent', () => {
    const { store } = memory()
    rememberApproval(store, 'ws_edit_file')
    assert.equal(isAutoApproved(store, 'ws_edit_file'), true)
    rememberApproval(store, 'ws_edit_file')
    assert.deepEqual([...store.getAllowedTools()].sort(), ['ws_edit_file'])
  })

  it('an unknown tool is never auto-approved even if passed through', () => {
    const { store } = memory(['ws_edit_file'])
    assert.equal(isAutoApproved(store, 'ws_read_file'), false)
    // Remembering a non-writable tool is a no-op.
    rememberApproval(store, 'ws_read_file')
    assert.deepEqual([...store.getAllowedTools()].sort(), ['ws_edit_file'])
  })

  it('forgetApproval removes the memory', () => {
    const { store } = memory(['ws_edit_file', 'ws_write_file'])
    forgetApproval(store, 'ws_edit_file')
    assert.equal(isAutoApproved(store, 'ws_edit_file'), false)
    assert.equal(isAutoApproved(store, 'ws_write_file'), true)
  })
})
