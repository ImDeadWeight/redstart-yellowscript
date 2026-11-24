// The type errors are the bug: the program already prints the right report,
// and the workspace has no TypeScript of its own to run, so only the
// diagnostics show them (ys_diagnostics, or the report after each write).
// Run with and without them: `npm run bench -- --task diagnostics-only
// [--no-diagnostics]` (agent-runtime plan item 1).
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { expect, pass, run, workspace } from '../_lib/check.mjs'

// Yellowscript's own TypeScript, over the workspace's tsconfig.
const ts = createRequire(import.meta.url)('typescript')
const configPath = path.join(workspace, 'tsconfig.json')
const config = ts.readConfigFile(configPath, ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, workspace)
const program = ts.createProgram(parsed.fileNames, parsed.options)
const problems = ts.getPreEmitDiagnostics(program).filter((d) => d.category === ts.DiagnosticCategory.Error)
expect(
  problems.length === 0,
  `${problems.length} type error(s) remain: ${problems.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ').slice(0, 300)}`,
)

const r = run(process.execPath, ['src/main.ts'])
const want = 'Widget: $7.50\nGadget: $20.00\nGizmo: $4.99\nTotal: $32.49'
expect(
  r.status === 0 && r.stdout.trim().replace(/\r/g, '') === want,
  `node src/main.ts printed:\n${r.stdout.trim()}${r.stderr.slice(-300)}\nexpected:\n${want}`,
)
pass('type-checks cleanly, and prints the same report')
