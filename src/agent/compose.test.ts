// =============================================================================
// Tests for composing one chat's agent, with a headless setup: the real tool
// registry over a temp workspace, a scripted model, and gates that apply
// writes directly. This is the shape the benchmark's own setup takes.
// =============================================================================

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, describe, test } from 'node:test'

import type { HostMessage } from '../chat/protocol.ts'
import type { ChatCompletionRequest, NestClient, StreamResult } from '../nest/client.ts'
import { BackgroundProcesses } from '../tools/background-processes.ts'
import { createToolRegistry } from '../tools/registry.ts'
import type { PendingWrite } from '../tools/types.ts'
import { composeSession, type AgentSetup } from './compose.ts'

const scratch: string[] = []
after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true })
})
function tempDir(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ys-compose-')))
  scratch.push(dir)
  return dir
}

/** A model that replays a script, one entry per round trip. */
function scripted(replies: Array<Partial<StreamResult>>): NestClient & { requests: ChatCompletionRequest[] } {
  const requests: ChatCompletionRequest[] = []
  return {
    requests,
    async streamChatCompletion(request: ChatCompletionRequest) {
      requests.push(structuredClone(request))
      const next = replies[requests.length - 1] ?? { content: 'done' }
      return { content: '', reasoning: '', toolCalls: [], aborted: false, ...next } satisfies StreamResult
    },
  } as unknown as NestClient & { requests: ChatCompletionRequest[] }
}

const call = (id: string, name: string, args: unknown): Partial<StreamResult> => ({
  toolCalls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] as StreamResult['toolCalls'],
})

function headless(options: { roots: string[]; client: NestClient; processes?: Pick<BackgroundProcesses, 'list'> }) {
  const processes = new BackgroundProcesses()
  const tools = createToolRegistry({
    ripgrepPath: null,
    diagnostics: () => [],
    editorState: () => ({ activeFile: null, languageId: null, isDirty: false, cursor: null, selection: null, openFiles: [] }),
    processes,
  })
  const changes: Array<{ conversationId: string; root: string; pending: PendingWrite }> = []
  const allowed: string[] = []
  const warnings: string[] = []
  const setup: AgentSetup = {
    client: () => options.client,
    onUnauthorized: () => {},
    workspace: { roots: () => options.roots, readRoots: () => allowed, allowReadRoot: async (folder) => void allowed.push(folder) },
    tools: () => tools,
    project: () => ({ id: 'p1', name: 'Alpha' }),
    processes: options.processes ?? processes,
    gates: {
      change: ({ conversationId, root }) => async (pending) => {
        changes.push({ conversationId, root, pending })
        for (const c of pending.changes) {
          fs.mkdirSync(path.dirname(c.absolutePath), { recursive: true })
          fs.writeFileSync(c.absolutePath, c.after, 'utf8')
        }
        return true
      },
      command: () => async () => null,
    },
    maxTurns: () => 10,
    log: { info: () => {}, warn: (line) => void warnings.push(line) },
  }
  const emitted: HostMessage[] = []
  const session = composeSession(setup, 'c1', { emit: (m) => void emitted.push(m), onPersist: () => {}, context: () => null })
  return { session, changes, allowed, warnings, emitted }
}

describe('composeSession', () => {
  test('with no folder open it is a plain chat: no tools, no workspace message', async () => {
    const client = scripted([{ content: 'hello' }])
    const { session } = headless({ roots: [], client })
    await session.send('hi')
    const request = client.requests[0]!
    assert.equal(request.tools, undefined)
    assert.deepEqual(request.messages.map((m) => m.role), ['user'])
    assert.equal(request.redstart_project, 'p1')
  })

  test('with a folder: the workspace message first, the tools, and the project', async () => {
    const root = tempDir()
    const client = scripted([{ content: 'ok' }])
    const { session } = headless({ roots: [root], client })
    await session.send('hi')
    const request = client.requests[0]!
    assert.equal(request.messages[0]!.role, 'system')
    assert.match(String(request.messages[0]!.content), new RegExp(`The workspace is ${path.basename(root)}`))
    assert.ok((request.tools?.length ?? 0) > 0)
    assert.equal(request.redstart_project, 'p1')
  })

  test('what is running is put on the newest message', async () => {
    const root = tempDir()
    const client = scripted([{ content: 'ok' }])
    const running = { list: () => [{ id: 'p1', command: 'npm run dev', cwd: root, startedAt: Date.now(), exitCode: null, running: true, url: 'http://localhost:5173' }] }
    const { session } = headless({ roots: [root], client, processes: running })
    await session.send('is it up?')
    const newest = String(client.requests[0]!.messages.at(-1)!.content)
    assert.match(newest, /^\[.*npm run dev.*\]\n\nis it up\?$/s)
  })

  test("a write goes through the setup's gate, for this conversation, in the first folder", async () => {
    const root = tempDir()
    const client = scripted([call('w1', 'ys_write_file', { path: 'notes/a.txt', content: 'hi\n' }), { content: 'Written.' }])
    const { session, changes } = headless({ roots: [root], client })
    await session.send('write it')
    assert.equal(changes.length, 1)
    assert.equal(changes[0]!.conversationId, 'c1')
    assert.equal(changes[0]!.root, root)
    assert.equal(fs.readFileSync(path.join(root, 'notes', 'a.txt'), 'utf8'), 'hi\n')
  })

  test('"Always for this folder" on a read outside the workspace adds it to the read roots', async () => {
    const root = tempDir()
    const outside = tempDir()
    fs.writeFileSync(path.join(outside, 'b.txt'), 'outside\n')
    const client = scripted([call('r1', 'ys_read_file', { path: path.join(outside, 'b.txt') }), { content: 'Read it.' }])
    const { session, allowed, emitted } = headless({ roots: [root], client })
    const sent = session.send('read the other file')
    // Answer the card when it comes up.
    for (let i = 0; i < 100; i++) {
      const asking = emitted.findLast((m) => m.type === 'conversationState' && m.state.approval)
      if (asking && asking.type === 'conversationState' && asking.state.approval) {
        session.approve(asking.state.approval.id, 'always')
        break
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    await sent
    assert.deepEqual(allowed, [outside])
    const toolResult = client.requests[1]!.messages.find((m) => m.role === 'tool')
    assert.match(String(toolResult?.content), /outside/)
  })
})
