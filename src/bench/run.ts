// =============================================================================
// npm run bench — run the coding benchmark against a live Nest.
// =============================================================================
//
//   YELLOWSCRIPT_TEST_LIVE_NEST=http://127.0.0.1:19080 \
//   YELLOWSCRIPT_TEST_TOKEN=rst_... \
//   npm run bench -- --label "qwen3.6-35b Q4_K_XL" [--task fix-failing-test] [--repeat 3] [--keep]
//                    [--withhold ys_outline,ys_find_symbol,ys_references]
//                    [--catalog full,core,core+nest] [--no-diagnostics] [--no-stagnation]
//
// --catalog runs every task under each catalog in turn (harness.ts CATALOGS:
// the agent-runtime plan's item 5); Nest's tools are listed once over MCP
// for the catalogs that include them. --no-diagnostics and --no-stagnation
// are the "without" half of a with/without comparison (items 1 and 3).
//
// Each task runs in a fresh temp copy of bench/tasks/<id>/workspace and is
// scored by its check.mjs. Results go to bench/results/<stamp>-<label>/:
// runs.jsonl (one record per run) and summary.md, which ends with the row to
// copy into docs/bench-results.md.
//
// Commands the model proposes run on this machine (inside the temp copy).
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { NestClient, nestFetch } from '../nest/client.ts'
import { McpHost, type McpTool } from '../nest/mcp-host.ts'
import type { NestToolRef } from '../tools/registry.ts'
import { CATALOGS, loadTasks, runTask, summarize, type Catalog, type RunRecord } from './harness.ts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TASKS = path.join(ROOT, 'bench', 'tasks')

const { values } = parseArgs({
  options: {
    label: { type: 'string' },
    task: { type: 'string', multiple: true },
    tag: { type: 'string' },
    repeat: { type: 'string', default: '1' },
    keep: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    // Leave tools out (comma-separated names), to measure what they save.
    withhold: { type: 'string' },
    // Tool catalogs to run, comma-separated (full, core, core+nest).
    catalog: { type: 'string', default: 'full' },
    'no-diagnostics': { type: 'boolean', default: false },
    'no-stagnation': { type: 'boolean', default: false },
  },
})

const catalogs = values.catalog.split(',').map((c) => c.trim()).filter(Boolean) as Catalog[]
const unknown = catalogs.filter((c) => !CATALOGS.includes(c))
if (unknown.length || catalogs.length === 0) {
  console.error(`Unknown catalog(s): ${unknown.join(', ') || '(none)'}. Use ${CATALOGS.join(', ')}.`)
  process.exit(2)
}

const all = loadTasks(TASKS)
if (values.list) {
  for (const t of all) console.log(`${t.id.padEnd(28)} ${t.title}${t.tags?.length ? `  [${t.tags.join(', ')}]` : ''}`)
  process.exit(0)
}

const baseUrl = process.env.YELLOWSCRIPT_TEST_LIVE_NEST
const token = process.env.YELLOWSCRIPT_TEST_TOKEN
if (!baseUrl || !token) {
  console.error('Set YELLOWSCRIPT_TEST_LIVE_NEST (the gateway URL) and YELLOWSCRIPT_TEST_TOKEN (an rst_ key) to run the bench.')
  console.error('`npm run bench -- --list` shows the tasks without a Nest.')
  process.exit(2)
}

let tasks = all
if (values.task?.length) {
  const wanted = new Set(values.task)
  tasks = all.filter((t) => wanted.has(t.id))
  const missing = [...wanted].filter((id) => !all.some((t) => t.id === id))
  if (missing.length) {
    console.error(`Unknown task(s): ${missing.join(', ')}. Try --list.`)
    process.exit(2)
  }
}
if (values.tag) tasks = tasks.filter((t) => t.tags?.includes(values.tag!))
// Milestones take an hour each: only when asked for by --task or --tag.
else if (!values.task?.length) tasks = tasks.filter((t) => !t.tags?.includes('milestone'))
const repeat = Math.max(1, Number(values.repeat) || 1)

const client = new NestClient(baseUrl, { timeoutMs: 600_000 })
client.setCredential({ kind: 'apiKey', key: token })
const props = await client.props().catch(() => null)
const label = values.label ?? 'unlabelled'

/** Nest's tools over MCP, as the editor merges them; run on the Nest, approved by the bench. */
async function listNestTools(): Promise<NestToolRef[]> {
  let listed: readonly McpTool[] = []
  const host = new McpHost(
    {
      baseUrl: client.baseUrl,
      listMcpServers: (signal) => client.listMcpServers(signal),
      fetch: nestFetch,
      getCredential: () => client.getCredential(),
    },
    { onTools: (tools) => (listed = tools), onConnection: () => {}, onError: (err) => console.error(`  mcp: ${err.message}`) },
  )
  if (!(await host.connect())) return []
  return listed.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    execute: async (args: unknown) => (await host.callToolResult(t.name, args)).text,
  }))
}
const nestTools = catalogs.some((c) => c !== 'core') ? await listNestTools() : []
if (catalogs.some((c) => c !== 'core')) console.log(`Nest tools: ${nestTools.length ? nestTools.map((t) => t.name).join(', ') : 'none (MCP unreachable: local tools only)'}`)

console.log(
  `\nbench: ${tasks.length} task(s) × ${repeat} × catalog ${catalogs.join(', ')} against ${baseUrl} · n_ctx ${props?.nCtx ?? 'unknown'} · vision ${props?.vision ?? 'unknown'}` +
    `${values['no-diagnostics'] ? ' · no diagnostics' : ''}${values['no-stagnation'] ? ' · no stagnation checks' : ''}\n`,
)

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outDir = path.join(ROOT, 'bench', 'results', `${stamp}-${label.replace(/[^\w.-]+/g, '_')}`)
fs.mkdirSync(outDir, { recursive: true })
const records: RunRecord[] = []

for (const catalog of catalogs) for (const task of tasks) {
  for (let i = 0; i < repeat; i++) {
    console.log(`▶ ${task.id}${repeat > 1 ? ` (${i + 1}/${repeat})` : ''}${catalogs.length > 1 ? ` [${catalog}]` : ''} — ${task.title}`)
    const run = await runTask(task, {
      client,
      contextSource: client,
      label,
      keep: values.keep,
      catalog,
      nestTools,
      diagnostics: !values['no-diagnostics'],
      stagnation: !values['no-stagnation'],
      ...(values.withhold ? { withhold: values.withhold.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      ...(values.quiet ? {} : { log: (line: string) => console.log(line) }),
    })
    const { workspace, ...record } = run
    records.push(record)
    fs.appendFileSync(path.join(outDir, 'runs.jsonl'), `${JSON.stringify(record)}\n`)
    console.log(
      `  ${record.pass ? 'PASS' : 'FAIL'} · ${record.stopReason} · ${record.iterations} turns · ${record.toolCalls} calls · ` +
        `${(record.durationMs / 1000).toFixed(0)}s · ${record.check.split('\n')[0]}` +
        (record.error ? `\n  error: ${record.error}` : '') +
        (values.keep ? `\n  workspace kept: ${workspace}` : ''),
    )
  }
}

// One summary per catalog, so each ends with its own row for the results log.
const summary = catalogs.map((c) => summarize(records.filter((r) => (r.catalog ?? 'full') === c), catalogs.length > 1 ? `${label} [${c}]` : label)).join('\n\n')
fs.writeFileSync(path.join(outDir, 'summary.md'), summary)
console.log(`\n${summary}\nResults: ${outDir}`)
process.exit(records.every((r) => r.pass) ? 0 : 1)
