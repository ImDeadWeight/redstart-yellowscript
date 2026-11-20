// The second message must find the file the first one made without looking
// for it: the run log on the first answer says which file it wrote.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, file, pass, result, workspace } from '../_lib/check.mjs'

const taskDir = path.dirname(fileURLToPath(import.meta.url))
const before = new Set(walk(path.join(taskDir, 'workspace', 'src')).map((p) => path.relative(path.join(taskDir, 'workspace'), p)))
const now = walk(file('src')).map((p) => path.relative(workspace, p))
const added = now.filter((p) => !before.has(p) && /\.m?js$/.test(p))
expect(added.length === 1, `expected one new file under src/, found ${added.length}: ${added.join(', ') || 'none'}`)

const mod = await import(pathToFileURL(file(added[0])).href).catch((e) => ({ error: e }))
expect(!mod.error, `${added[0]} does not load: ${mod.error?.message}`)
expect(typeof mod.greet === 'function', `${added[0]} has no named export greet`)
expect(mod.greet('Ann') === 'Hello, Ann!', `greet("Ann") is ${JSON.stringify(mod.greet('Ann'))}`)
expect(mod.greet('Ann', 'Hi') === 'Hi, Ann!', `greet("Ann", "Hi") is ${JSON.stringify(mod.greet('Ann', 'Hi'))}`)

const messages = result.messages ?? []
expect(messages.length === 2, `expected two messages' runs, got ${messages.length}`)
const searches = messages[1].calls.filter((c) => ['ys_glob', 'ys_grep', 'ys_list_directory'].includes(c.name) ||
  (c.name === 'ys_run_command' && /\b(dir|ls|find|findstr|grep|tree)\b/.test(c.args)))
expect(searches.length === 0, `the second message searched for the file: ${searches.map((c) => c.name).join(', ')}`)
pass(`${added[0]} made, then edited without a search`)

function walk(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]))
}
