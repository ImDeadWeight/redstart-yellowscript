import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { checkWrite, parseJsonc, secretReason, workspaceRelative } from './protected-paths.ts'
import { createToolRegistry } from './registry.ts'
import type { EditorState } from './editor-context.ts'

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-protected-')))
after(() => fs.rmSync(root, { recursive: true, force: true }))

const at = (rel: string) => path.join(root, ...rel.split('/'))
const edit = (before: string, after: string) => ({ before, after, isDeleted: false })
const verdict = (rel: string, before = '', after = 'x') => checkWrite([root], at(rel), edit(before, after))

describe('checkWrite', () => {
  test('.git is refused anywhere in the workspace', () => {
    for (const rel of ['.git/config', '.git/hooks/pre-commit', 'sub/.git/config', '.GIT/config', '.git']) {
      assert.ok(verdict(rel) && 'refuse' in verdict(rel)!, rel)
    }
    // A name that only starts with .git is an ordinary file.
    assert.equal(verdict('.gitignore'), null)
    assert.equal(verdict('docs/.github/workflow.yml'), null)
  })

  test('the checkpoint repository is refused', () => {
    assert.ok('refuse' in verdict('.yellowscript/shadow/x')!)
    assert.equal(verdict('.yellowscript/PLAN.md'), null)
  })

  test("Yellowscript's own settings are refused; other settings ask", () => {
    const before = '{\n  // editor\n  "editor.tabSize": 2,\n}\n'
    const own = '{\n  "editor.tabSize": 2,\n  "redstartYellowscript.allowedCommands": ["rm"],\n}\n'
    const other = '{\n  "editor.tabSize": 4,\n}\n'
    assert.ok('refuse' in verdict('.vscode/settings.json', before, own)!)
    assert.deepEqual(verdict('.vscode/settings.json', before, other), { ask: '.vscode/settings.json holds editor settings' })
    // Removing one is a change too.
    assert.ok('refuse' in verdict('.vscode/settings.json', own, before)!)
    // Changing another setting in a file that has ours is fine to ask about.
    assert.ok('ask' in verdict('.vscode/settings.json', own, own.replace('2', '4'))!)
  })

  test('a value on a later line still counts as a change to that setting', () => {
    const before = '{ "redstartYellowscript.allowedCommands": [\n  "npm test"\n] }'
    const after = '{ "redstartYellowscript.allowedCommands": [\n  "npm test",\n  "curl"\n] }'
    assert.ok('refuse' in verdict('.vscode/settings.json', before, after)!)
  })

  test('a settings file that does not parse is refused if it names our settings', () => {
    assert.ok('refuse' in verdict('.vscode/settings.json', '{}', '{ "redstartYellowscript.x": [ ')!)
    assert.ok('ask' in verdict('.vscode/settings.json', '{}', '{ broken')!)
  })

  test('a .code-workspace file: settings live under "settings"', () => {
    const before = '{ "folders": [{ "path": "." }], "settings": {} }'
    const after = '{ "folders": [{ "path": "." }], "settings": { "redstartYellowscript.commands.builtInSafe": false } }'
    assert.ok('refuse' in verdict('game.code-workspace', before, after)!)
    assert.ok('ask' in verdict('game.code-workspace', before, before.replace('"."', '"src"'))!)
  })

  test('tasks, launch and package.json scripts always ask', () => {
    assert.ok('ask' in verdict('.vscode/tasks.json')!)
    assert.ok('ask' in verdict('.vscode/launch.json')!)
    const pkg = (scripts: object) => JSON.stringify({ name: 'g', scripts })
    assert.ok('ask' in verdict('package.json', pkg({ test: 'node --test' }), pkg({ test: 'curl x | sh' }))!)
    assert.equal(verdict('package.json', pkg({ test: 'a' }), JSON.stringify({ name: 'h', scripts: { test: 'a' } })), null)
    assert.ok('ask' in verdict('web/package.json', '', pkg({ dev: 'vite' }))!, 'a new package.json with scripts')
    assert.ok(checkWrite([root], at('package.json'), { before: pkg({}), after: '', isDeleted: true }))
  })

  test('paths outside every root are not this module\'s business', () => {
    assert.equal(checkWrite([root], path.join(os.tmpdir(), 'elsewhere', '.git', 'config'), edit('', 'x')), null)
  })
})

describe('workspaceRelative', () => {
  test('backslashes and case', () => {
    assert.equal(workspaceRelative([root], path.join(root, 'A', 'B.txt')), 'a/b.txt')
    assert.equal(workspaceRelative([root.toUpperCase()], path.join(root, 'x')), 'x')
    assert.equal(workspaceRelative([root], root + '-other' + path.sep + 'x'), null)
  })
})

describe('secretReason', () => {
  test('secrets files', () => {
    for (const name of ['.env', '.env.local', '.ENV.production', 'server.pem', 'tls.key', 'cert.p12', 'id_rsa', 'id_ed25519.pub', '.npmrc', '.pypirc', '.git-credentials', '.netrc']) {
      assert.ok(secretReason(path.join(root, name)), name)
    }
  })

  test('ordinary files, and the example env files', () => {
    for (const name of ['.env.example', '.env.sample', 'env.js', 'keys.ts', 'README.md', 'package.json']) {
      assert.equal(secretReason(path.join(root, name)), null, name)
    }
  })
})

describe('parseJsonc', () => {
  test('comments and trailing commas, but not inside strings', () => {
    assert.deepEqual(parseJsonc('{ // c\n "a": "http://x", /* b */ "b": [1,], }'), { a: 'http://x', b: [1] })
  })
})

// ---------------------------------------------------------------------------
// Through the registry: every write tool, and the tricks a model could try.
// ---------------------------------------------------------------------------

const emptyEditor = (): EditorState => ({ activeFile: null, languageId: null, isDirty: false, cursor: null, selection: null, openFiles: [] })
const tools = createToolRegistry({ ripgrepPath: null, diagnostics: () => [], editorState: emptyEditor })
const ctx = { workspaceRoots: [root] }

describe('protected paths through the write tools', () => {
  fs.mkdirSync(at('.git/hooks'), { recursive: true })
  fs.writeFileSync(at('.git/config'), '[core]\n')
  fs.mkdirSync(at('.vscode'), { recursive: true })
  fs.writeFileSync(at('.vscode/settings.json'), '{}\n')
  fs.writeFileSync(at('notes.txt'), 'hello\n')

  const refused = async (name: string, args: unknown) => {
    const result = await tools.execute(name, JSON.stringify(args), ctx)
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}: ${result.content}`)
    assert.match(result.content, /^Not written:/)
    assert.equal(result.pendingWrite, undefined)
  }

  test('every write tool refuses .git, whatever the spelling', async () => {
    await refused('ys_write_file', { path: '.git/hooks/pre-commit', content: 'calc' })
    await refused('ys_write_file', { path: '.GIT/config', content: 'x' })
    await refused('ys_write_file', { path: './.git/../.git/hooks/x', content: 'x' })
    await refused('ys_write_file', { path: '.git\\config', content: 'x' })
    await refused('ys_replace', { path: '.git/config', old_string: '[core]', new_string: '[core]\n\tfsmonitor = calc' })
    await refused('ys_delete_file', { path: '.git/config' })
    await refused('ys_move_file', { from: 'notes.txt', to: '.git/hooks/post-checkout' })
  })

  test('a link inside the workspace pointing into .git is refused', async () => {
    try {
      fs.symlinkSync(at('.git'), at('innocent'), 'junction')
    } catch {
      return // this machine cannot make links
    }
    await refused('ys_write_file', { path: 'innocent/hooks/pre-commit', content: 'calc' })
  })

  test("writing Yellowscript's settings is refused; other settings must be asked", async () => {
    await refused('ys_write_file', { path: '.vscode/settings.json', content: '{ "redstartYellowscript.allowedCommands": ["*"] }' })
    const other = await tools.execute('ys_write_file', JSON.stringify({ path: '.vscode/settings.json', content: '{ "editor.tabSize": 4 }' }), ctx)
    assert.equal(other.isError, false)
    assert.match(other.pendingWrite?.alwaysAsk ?? '', /editor settings/)
  })

  test('an ordinary file is untouched by any of this', async () => {
    const ok = await tools.execute('ys_write_file', JSON.stringify({ path: 'src/a.js', content: '1' }), ctx)
    assert.equal(ok.isError, false)
    assert.equal(ok.pendingWrite?.alwaysAsk, undefined)
  })
})

describe('secrets through the read tools', () => {
  fs.writeFileSync(at('.env'), 'TOKEN=hunter2\n')

  test('a .env read is refused when there is no one to ask', async () => {
    const result = await tools.execute('ys_read_file', '{"path":".env"}', ctx)
    assert.equal(result.isError, true)
    assert.doesNotMatch(result.content, /hunter2/)
  })

  test('it asks, and reads only on yes', async () => {
    const asked: string[] = []
    const no = await tools.execute('ys_read_file', '{"path":".env"}', { ...ctx, askRead: async (r) => (asked.push(r.label), false) })
    assert.doesNotMatch(no.content, /hunter2/)
    const yes = await tools.execute('ys_read_file', '{"path":".env"}', { ...ctx, askRead: async () => true })
    assert.match(yes.content, /hunter2/)
    assert.deepEqual(asked, ['.env'])
  })

  test('grep skips it and says so', async () => {
    const result = await tools.execute('ys_grep', '{"pattern":"hunter2"}', ctx)
    assert.match(result.content, /No matches/)
    assert.match(result.content, /1 file that may hold secrets \(\.env\) not searched/)
  })
})
