import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { refusedOutside, resolveReadPath, suggestReadRoot, usableReadRoots, type Environment } from './read-scope.ts'
import type { ReadRequest } from './types.ts'

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yellowscript-scope-')))
after(() => fs.rmSync(base, { recursive: true, force: true }))

const home = path.join(base, 'home', 'ann')
const workspace = path.join(base, 'work', 'game')
const sibling = path.join(base, 'work', 'redstart-project')
for (const dir of [home, path.join(home, '.ssh'), workspace, path.join(sibling, 'docs')]) fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(sibling, 'package.json'), '{}')
fs.writeFileSync(path.join(sibling, 'docs', 'plan.md'), 'the plan\n')
fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host x\n')
fs.writeFileSync(path.join(workspace, 'a.txt'), 'inside\n')

const environment: Environment = { home, platform: 'linux', env: {} }

describe('refusedOutside', () => {
  test('home, the folders above it, and the credential folders in it', () => {
    assert.ok(refusedOutside(home, environment))
    assert.ok(refusedOutside(path.dirname(home), environment))
    assert.ok(refusedOutside(path.parse(home).root, environment))
    assert.ok(refusedOutside(path.join(home, '.ssh', 'config'), environment))
    assert.ok(refusedOutside(path.join(home, '.aws', 'credentials'), environment))
  })

  test('system folders', () => {
    assert.ok(refusedOutside('/etc/passwd', environment))
    assert.ok(refusedOutside('C:\\Windows\\win.ini', { home, platform: 'win32', env: { SystemRoot: 'C:\\Windows' } }))
  })

  test('a project next to the workspace is fine', () => {
    assert.equal(refusedOutside(path.join(sibling, 'docs', 'plan.md'), environment), null)
    assert.equal(refusedOutside(path.join(home, 'code', 'x.js'), environment), null, 'a folder inside home, not home itself')
  })
})

describe('suggestReadRoot', () => {
  test('the nearest project root above the file', () => {
    assert.equal(suggestReadRoot(path.join(sibling, 'docs', 'plan.md'), environment), sibling)
  })

  test("the file's own folder when no project root is above it, never home", () => {
    const loose = path.join(home, 'notes')
    fs.mkdirSync(loose, { recursive: true })
    assert.equal(suggestReadRoot(path.join(loose, 'a.md'), environment), loose)
  })
})

describe('usableReadRoots', () => {
  test('drops a setting that names home or a system folder', () => {
    assert.deepEqual(usableReadRoots([sibling, home, '/etc', 'relative/path'], environment), [sibling])
  })
})

describe('resolveReadPath', () => {
  const target = path.join(sibling, 'docs', 'plan.md')

  test('inside the workspace: as before, no question', async () => {
    let asked = 0
    const got = await resolveReadPath({ workspaceRoots: [workspace], askRead: async () => (asked++, true) }, 'a.txt', environment)
    assert.equal(got, path.join(workspace, 'a.txt'))
    assert.equal(asked, 0)
  })

  test('outside, with no one to ask: refused', async () => {
    await assert.rejects(resolveReadPath({ workspaceRoots: [workspace] }, target, environment), /escapes the workspace/)
  })

  test('outside: asks once, naming the folder "Always" would allow', async () => {
    const asked: ReadRequest[] = []
    const got = await resolveReadPath({ workspaceRoots: [workspace], askRead: async (r) => (asked.push(r), true) }, '../redstart-project/docs/plan.md', environment)
    assert.equal(got, target)
    assert.equal(asked[0]!.outsideFolder, sibling)
  })

  test('outside, in an allowed folder: no question', async () => {
    let asked = 0
    const got = await resolveReadPath({ workspaceRoots: [workspace], readRoots: [sibling], askRead: async () => (asked++, false) }, target, environment)
    assert.equal(got, target)
    assert.equal(asked, 0)
  })

  test('never offered for ~/.ssh, even with an allowed root that covers it', async () => {
    let asked = 0
    const context = { workspaceRoots: [workspace], readRoots: [path.join(home, '.ssh')], askRead: async () => (asked++, true) }
    await assert.rejects(resolveReadPath(context, path.join(home, '.ssh', 'config'), environment), /never read/)
    assert.equal(asked, 0)
  })

  test('a denial is a refusal', async () => {
    await assert.rejects(resolveReadPath({ workspaceRoots: [workspace], askRead: async () => false }, target, environment), /escapes the workspace/)
  })
})
