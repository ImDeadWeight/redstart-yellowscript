// =============================================================================
// Tests for mergeNestTools — the Phase 4.3 tool-set merge (HANDOFF 4.3).
// =============================================================================
// Proves:
//  - ws_* locals and Nest tools coexist in the merged payload
//  - a Nest tool whose name starts with ws_ is rejected (collision guard)
//  - a Nest tool whose name matches a local tool is rejected
//  - executing a Nest tool delegates to the host's execute callback
// =============================================================================

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createToolRegistry } from './registry.ts'
import { mergeNestTools, type NestToolRef } from './registry.ts'

const local = createToolRegistry({
  ripgrepPath: null,
  diagnostics: () => [],
  editorState: () => ({ openFiles: [], activeFile: null, languageId: null, isDirty: false, cursor: null, selection: null }),
})

function nestTool(name: string, execute?: (args: unknown) => Promise<string>): NestToolRef {
  return {
    name,
    description: `Nest tool ${name}`,
    inputSchema: { type: 'object', properties: {}, required: [] },
    execute: execute ?? ((() => Promise.resolve(`result of ${name}`)) as (args: unknown) => Promise<string>),
  }
}

describe('mergeNestTools', () => {
  it('coexists with local ws_* tools in the merged payload', () => {
    const merged = mergeNestTools(local, [nestTool('read_file'), nestTool('postgres_query')])
    const names = merged.names
    assert.ok(names.includes('ws_read_file'), 'local ws_read_file should survive')
    assert.ok(names.includes('read_file'), 'Nest read_file should be present')
    assert.ok(names.includes('postgres_query'), 'Nest postgres_query should be present')
  })

  it('rejects a Nest tool whose name starts with ws_ (same guard as local collision)', () => {
    // ws_ is the local-only namespace. A Nest tool leaking into it is the
    // exact collision the disjointness check exists to prevent — the prefix
    // guard IS the collision guard, since all local names begin with ws_.
    assert.throws(
      () => mergeNestTools(local, [nestTool('ws_read_file')]),
      /collides with the ws_ prefix/,
    )
  })

  it('rejects a duplicate Nest tool name within the same merge set', () => {
    assert.throws(
      () => mergeNestTools(local, [nestTool('read_file'), nestTool('read_file')]),
      /duplicates an existing tool name/,
    )
  })

  it('delegates execution of a Nest tool to the host callback', async () => {
    const merged = mergeNestTools(local, [nestTool('postgres_query', () => Promise.resolve('42 rows'))])
    const result = await merged.execute('postgres_query', '{"query":"SELECT 1"}', { workspaceRoots: [] })
    assert.equal(result.isError, false)
    assert.equal(result.content, '42 rows')
    assert.equal(result.summary, 'postgres_query (ran on Nest)')
  })

  it('reports unknown tools with the full merged name list', async () => {
    const merged = mergeNestTools(local, [nestTool('read_file')])
    const result = await merged.execute('nonexistent_tool', '{}', { workspaceRoots: [] })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('ws_read_file'), 'should name locals')
    assert.ok(result.content.includes('read_file'), 'should name nest tools')
  })

  it('re-running merge with a different Nest set replaces the Nest tools', () => {
    const first = mergeNestTools(local, [nestTool('read_file')])
    assert.ok(first.names.includes('read_file'))
    assert.equal(first.names.includes('postgres_query'), false)

    const second = mergeNestTools(local, [nestTool('postgres_query')])
    assert.ok(second.names.includes('postgres_query'))
    // Local tools are always present.
    assert.ok(second.names.includes('ws_read_file'))
  })

  it('preserves local tools untouched when merging zero Nest tools', () => {
    const merged = mergeNestTools(local, [])
    assert.deepEqual(merged.names, local.names)
  })
})
