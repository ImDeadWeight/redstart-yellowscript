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
  migrateToolName,
  migrateToolNames,
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
    assert.equal(isWritableTool('ys_edit_file'), true)
    assert.equal(isWritableTool('ys_write_file'), true)
    assert.equal(isWritableTool('ys_read_file'), false)
    assert.equal(isWritableTool('rm -rf'), false)
  })

  it('a writable tool is not auto-approved until remembered', () => {
    const { store } = memory()
    assert.equal(isAutoApproved(store, 'ys_edit_file'), false)
  })

  it('a remembered approval auto-approves and is idempotent', () => {
    const { store } = memory()
    rememberApproval(store, 'ys_edit_file')
    assert.equal(isAutoApproved(store, 'ys_edit_file'), true)
    rememberApproval(store, 'ys_edit_file')
    assert.deepEqual([...store.getAllowedTools()].sort(), ['ys_edit_file'])
  })

  it('an unknown tool is never auto-approved even if passed through', () => {
    const { store } = memory(['ys_edit_file'])
    assert.equal(isAutoApproved(store, 'ys_read_file'), false)
    // Remembering a non-writable tool is a no-op.
    rememberApproval(store, 'ys_read_file')
    assert.deepEqual([...store.getAllowedTools()].sort(), ['ys_edit_file'])
  })

  it('forgetApproval removes the memory', () => {
    const { store } = memory(['ys_edit_file', 'ys_write_file'])
    forgetApproval(store, 'ys_edit_file')
    assert.equal(isAutoApproved(store, 'ys_edit_file'), false)
    assert.equal(isAutoApproved(store, 'ys_write_file'), true)
  })
})

describe('legacy ws_ tool names', () => {
  it('maps a pre-rename name to its ys_ name and leaves others alone', () => {
    assert.equal(migrateToolName('ws_edit_file'), 'ys_edit_file')
    assert.equal(migrateToolName('ys_edit_file'), 'ys_edit_file')
    assert.equal(migrateToolName('read_file'), 'read_file')
  })

  it('migrates a saved list and drops the duplicates the rename creates', () => {
    assert.deepEqual(migrateToolNames(['ws_edit_file', 'ys_edit_file', 'ws_write_file']), [
      'ys_edit_file',
      'ys_write_file',
    ])
  })

  it('a migrated saved approval still auto-approves', () => {
    const { store } = memory()
    const legacy: ApprovalStore = {
      getAllowedTools: () => migrateToolNames(['ws_edit_file']),
      setAllowedTools: store.setAllowedTools,
    }
    assert.equal(isAutoApproved(legacy, 'ys_edit_file'), true)
  })
})
