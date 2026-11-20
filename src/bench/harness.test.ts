// =============================================================================
// Tests for the bench itself: are the tasks honest, and does the harness work?
// =============================================================================
// A benchmark task is only worth running if its check FAILS on the untouched
// workspace (otherwise it is a free pass) and PASSES on a correct solution
// (otherwise no model can pass it). Every task ships a reference solution in
// reference/ — the files a correct run would leave and the result record it
// would produce — and this proves both directions for each one.
//
// Then the harness is run end to end with a scripted model (no Nest), so
// `npm test` catches a broken harness before a long live run does.

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, test } from 'node:test'

import { loadTasks, runCheck, runTask, summarize } from './harness.ts'
import { findBrowser } from '../tools/browser-check.ts'
import type { CompletionStreamer } from '../agent/loop.ts'
import type { ChatCompletionRequest, StreamResult } from '../nest/client.ts'

const TASKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bench', 'tasks')
const tasks = loadTasks(TASKS)
const hasBrowser = findBrowser() !== null
const scratch: string[] = []
after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true })
})

/** A temp copy of the task's workspace, optionally with the reference files on top. */
function workspaceFor(taskDir: string, withReference: boolean): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ys-bench-test-')))
  scratch.push(dir)
  const source = path.join(taskDir, 'workspace')
  if (fs.existsSync(source)) fs.cpSync(source, dir, { recursive: true })
  const reference = path.join(taskDir, 'reference', 'files')
  if (withReference && fs.existsSync(reference)) fs.cpSync(reference, dir, { recursive: true })
  return dir
}

function resultFile(dir: string, content: unknown): string {
  const file = path.join(dir, '.yellowscript', 'bench-result.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(content))
  return file
}

describe('bench tasks', () => {
  test('there are tasks, each with a prompt, a check and a reference', () => {
    assert.ok(tasks.length >= 8, `found ${tasks.length}`)
    for (const t of tasks) assert.ok(fs.existsSync(path.join(t.dir, 'reference', 'result.json')), `${t.id} has no reference/result.json`)
  })

  for (const task of tasks) {
    const needsBrowser = task.tags?.includes('web') ?? false
    describe(task.id, { skip: needsBrowser && !hasBrowser ? 'needs a browser' : false }, () => {
      test('fails on the untouched workspace', { timeout: 60_000 }, () => {
        const dir = workspaceFor(task.dir, false)
        const file = resultFile(dir, { answer: '', stopReason: 'complete', questions: 0, calls: [] })
        const check = runCheck(task, dir, file)
        assert.equal(check.pass, false, `the check passed with nothing done: ${check.output}`)
      })

      test('passes on the reference solution', { timeout: 60_000 }, () => {
        const dir = workspaceFor(task.dir, true)
        const file = resultFile(dir, JSON.parse(fs.readFileSync(path.join(task.dir, 'reference', 'result.json'), 'utf8')))
        const check = runCheck(task, dir, file)
        assert.equal(check.pass, true, check.output)
      })
    })
  }
})

/** A model that replays a script, one entry per round trip. */
function scripted(replies: Array<Partial<StreamResult>>): CompletionStreamer & { requests: ChatCompletionRequest[] } {
  const requests: ChatCompletionRequest[] = []
  return {
    requests,
    async streamChatCompletion(request) {
      requests.push(structuredClone(request))
      const next = replies[requests.length - 1] ?? { content: 'done' }
      return { content: '', reasoning: '', toolCalls: [], aborted: false, model: 'scripted', ...next }
    },
  }
}

const call = (id: string, name: string, args: unknown) => ({
  toolCalls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }],
})

describe('runTask', () => {
  const fixCrash = tasks.find((t) => t.id === 'fix-crash')!

  test('a model that fixes the crash passes, and the record counts what it did', async () => {
    const client = scripted([
      call('c1', 'ys_read_file', { path: 'src/main.js' }),
      call('c2', 'ys_replace', { path: 'src/main.js', old_string: "import { summary } from './lib/stats.js'", new_string: "import { summarise } from './lib/stat.js'" }),
      call('c3', 'ys_replace', { path: 'src/main.js', old_string: 'const s = summary(scores)', new_string: 'const s = summarise(scores)' }),
      call('c4', 'ys_run_command', { command: 'node src/main.js' }),
      { content: 'Fixed: the import named a file and a function that do not exist.' },
    ])
    const record = await runTask(fixCrash, { client, contextSource: { props: async () => ({ nCtx: 32_768 }) }, label: 'scripted' })
    assert.equal(record.pass, true, record.check)
    assert.equal(record.stopReason, 'complete')
    assert.equal(record.toolCalls, 4)
    assert.equal(record.toolErrors, 0)
    assert.equal(record.model, 'scripted')
    assert.equal(record.nCtx, 32_768)
    // The model was told about the workspace before it started.
    assert.match(String(client.requests[0]!.messages[0]!.content), /The workspace is ys-bench-fix-crash-/)
  })

  test('a follow-up is a new request carrying the first run\'s log', async () => {
    const followUp = tasks.find((t) => t.id === 'follow-up-edit')!
    const client = scripted([
      call('c1', 'ys_write_file', { path: 'src/lib/greeting.js', content: 'export function greet(name) {\n  return `Hello, ${name}!`\n}\n' }),
      { content: 'Added greet in src/lib/greeting.js.' },
      call('c2', 'ys_replace', { path: 'src/lib/greeting.js', old_string: 'greet(name) {\n  return `Hello,', new_string: 'greet(name, greeting = "Hello") {\n  return `${greeting},' }),
      { content: 'Done.' },
    ])
    const record = await runTask(followUp, { client, label: 'scripted' })
    assert.equal(record.pass, true, record.check)
    const second = client.requests[2]!.messages
    assert.equal(second.at(-2)!.content, 'Added greet in src/lib/greeting.js.\n\n[What this run did]\ncreated src/lib/greeting.js')
    assert.match(String(second.at(-1)!.content), /optional second parameter/)
  })

  test('a model that gives up fails, with the check saying why', async () => {
    const record = await runTask(fixCrash, { client: scripted([{ content: 'I cannot fix this.' }]), label: 'scripted' })
    assert.equal(record.pass, false)
    assert.match(record.check, /still fails/)
  })

  test('a client error is a failed record, not a crash', async () => {
    const client: CompletionStreamer = { streamChatCompletion: async () => { throw new Error('Nest unreachable') } }
    const record = await runTask(fixCrash, { client, label: 'scripted' })
    assert.equal(record.pass, false)
    assert.equal(record.stopReason, 'error')
    assert.match(record.error ?? '', /Nest unreachable/)
  })

  test('the summary ends with one row for the results log', () => {
    const base = { label: 'x', model: 'm', check: 'ok', stopReason: 'complete' as const, iterations: 4, toolErrors: 0, invalidArgs: 0, repairedArgs: 0, recovered: 0, repeats: 0, trims: 0, questions: 0, nCtx: 32768, durationMs: 1000, answer: '' }
    const text = summarize([{ ...base, task: 'a', pass: true, toolCalls: 4 }, { ...base, task: 'b', pass: false, toolCalls: 6, toolErrors: 3, trims: 2 }], 'x', new Date('2026-11-19T12:00:00Z'))
    assert.match(text, /\*\*1\/2 passed\.\*\*/)
    assert.match(text.trim().split('\n').at(-1)!, /^\| 2026-11-19 \| x \| m \| 1\/2 \(50%\) \| 70% \| 0% \| 0% \| 0% \| 4\.0 \| 0 \| 1 \|$/)
  })
})
