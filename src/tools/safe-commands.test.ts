import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as os from 'node:os'
import * as path from 'node:path'

import { classifyCommand, endsProcesses, pidsIn, redactUrlCredentials, splitWords, withoutStderrRedirects, type CommandContext } from './safe-commands.ts'

const root = path.join(os.tmpdir(), 'ys-safe-ws')
const sibling = path.join(os.tmpdir(), 'ys-safe-sibling')

function ctx(over: Partial<CommandContext> = {}): CommandContext {
  return {
    platform: 'linux',
    cwd: root,
    roots: [root],
    readRoots: [],
    builtInSafe: true,
    projectChecks: true,
    background: false,
    shadowsProgram: () => false,
    scripts: () => ({ test: 'node --test', build: 'tsc', lint: 'eslint .', dev: 'vite', 'format:check': 'prettier --check .' }),
    scriptsChangedThisRun: () => false,
    localBin: (name) => ['tsc', 'vitest', 'eslint', 'prettier', 'jest', 'playwright'].includes(name),
    hasSecretsUnder: () => false,
    ...over,
  }
}

const tier = (line: string, over: Partial<CommandContext> = {}) => classifyCommand(line, ctx(over)).tier

describe('tier A: read-only, built in', () => {
  const rows = [
    'ls', 'ls -la src', 'dir', 'tree src', 'stat package.json', 'file logo.png', 'du -sh src', 'wc -l src/a.js',
    'cat src/a.js', 'type src\\a.js', 'head -n 20 src/a.js', 'tail -n 50 log.txt',
    'diff a.js b.js', 'cmp a b', 'fc a.txt b.txt',
    'grep -n foo src/a.js', 'grep -rn TODO src', 'rg foo', 'rg -g "*.ts" foo src', 'findstr /n foo a.txt', 'find . -name "*.js"',
    'sort names.txt', 'uniq names.txt',
    'pwd', 'cd', 'echo hello', 'where node', 'which npm', 'command -v git',
    'node --version', 'npm -v', 'git --version', 'go version', 'python -V',
    'npm ls', 'npm pkg get scripts', 'npm view vite version', 'npm outdated', 'npm audit', 'pnpm ls', 'yarn list',
    'git status', 'git diff', 'git diff -- src/a.js', 'git log --oneline -5', 'git show HEAD', 'git blame src/a.js',
    'git ls-files', 'git grep foo', 'git rev-parse HEAD', 'git describe --tags', 'git shortlog -s', 'git stash list', 'git stash show',
    'git branch', 'git branch -a', 'git tag --list', 'git remote -v',
    'node --check src/a.js', 'npx tsc --noEmit', 'npx tsc --noEmit -p tsconfig.json',
  ]
  for (const line of rows) test(line, () => assert.equal(tier(line), 'A', JSON.stringify(classifyCommand(line, ctx()))))

  test('a git line is run hardened, and says which rule allowed it', () => {
    const result = classifyCommand('git log -p', ctx())
    assert.equal(result.tier, 'A')
    if (result.tier === 'A') {
      assert.equal(result.run, 'git --no-pager -c core.fsmonitor=false -c core.hooksPath= -c diff.external= -c core.pager=cat log --no-ext-diff --no-textconv -p')
      assert.equal(result.env?.GIT_TERMINAL_PROMPT, '0')
      assert.match(result.rule, /git read-only/)
    }
  })

  test('the setting turns tier A off', () => {
    assert.equal(tier('git status', { builtInSafe: false }), 'C')
  })
})

describe('tier B: the project\'s own checks', () => {
  const rows = [
    'npm test', 'npm t', 'npm run build', 'npm run lint', 'npm run format:check', 'npm test -- --watch=false',
    'pnpm test', 'pnpm build', 'yarn lint', 'yarn run test', 'bun run test',
    'npx vitest run', 'npx jest', 'npx eslint src', 'npx prettier --check .', 'npx playwright test',
    'pytest', 'python -m pytest tests', 'ruff check .', 'mypy src',
    'cargo test', 'cargo clippy', 'go vet ./...', 'go test ./...',
  ]
  for (const line of rows) test(line, () => assert.equal(tier(line), 'B', JSON.stringify(classifyCommand(line, ctx()))))

  test('a dev server only in the background', () => {
    assert.equal(tier('npm run dev', { background: true }), 'B')
    assert.equal(tier('npm run dev'), 'C')
  })

  test('the rule shows the script it runs', () => {
    const result = classifyCommand('npm test', ctx())
    assert.equal(result.tier === 'B' && result.rule, 'package script "test": node --test')
  })

  test('a script must exist, and not have been changed by this run', () => {
    assert.equal(tier('npm run typecheck'), 'C')
    assert.equal(tier('npm test', { scriptsChangedThisRun: () => true }), 'C')
  })

  test('the setting turns tier B off', () => {
    assert.equal(tier('npm test', { projectChecks: false }), 'C')
  })
})

describe('tier C: every bypass is refused', () => {
  const bypasses: [string, Partial<CommandContext>?][] = [
    // Expansion: a path that only looks relative.
    ['type %USERPROFILE%\\.ssh\\id_rsa', { platform: 'win32' }],
    ['cat $HOME/.ssh/id_rsa'],
    ['cat ~/.ssh/id_rsa'],
    ['echo !PATH!', { platform: 'win32' }],
    ['echo ^&calc', { platform: 'win32' }],
    ['cat {a,b}'],
    // Outside the workspace, or secrets.
    ['cat ../../secret'],
    ['cat C:\\Windows\\win.ini'],
    ['cat /etc/passwd'],
    ['cat .env'],
    ['cat config/.env.local'],
    ['type id_rsa', { platform: 'win32' }],
    ['cat .git/config'],
    ['ls ../'],
    ['cat ../*.txt'],
    // Searches that would read a secrets file.
    ['grep -r TOKEN .', { hasSecretsUnder: () => true }],
    ['rg TOKEN', { hasSecretsUnder: () => true }],
    ['cat *.env'],
    // Git that runs programs, writes, or reaches elsewhere.
    ['git -c core.pager=calc log'],
    ['git log -c core.pager=calc'],
    ['git diff --output=x'],
    ['git grep -O foo'],
    ['git grep -Ocalc foo'],
    ['git diff --ext-diff'],
    ['git log --textconv'],
    ['git -C .. status'],
    ['git diff --no-index ../a ../b'],
    ['git --git-dir=../other/.git log'],
    ['git show HEAD:.env'],
    ['git branch new-feature'],
    ['git tag v1'],
    ['git remote add x url'],
    ['git add .'], ['git commit -m x'], ['git checkout main'], ['git switch main'], ['git stash'], ['git stash pop'],
    ['git merge x'], ['git rebase main'], ['git pull'], ['git fetch'],
    // Searches and finds that run programs or write.
    ['find . -delete'], ['find . -exec rm {} ;'], ['find . -execdir sh -c x'], ['find . -fprint out'],
    ['rg --pre sh x'], ['rg -z x'], ['rg --pre=sh x'], ['grep -f patterns.txt x'], ['findstr /g:list.txt x', { platform: 'win32' }],
    ['tail -f log.txt'], ['tail --follow log.txt'],
    ['sort -o out.txt in.txt'], ['sort --output=out in'], ['uniq in out'], ['diff --output=x a b'],
    // Programs given as paths, or shadowed in the working directory.
    ['./git status'], ['C:\\tools\\git.exe status', { platform: 'win32' }],
    ['git status', { platform: 'win32', shadowsProgram: (n) => n === 'git' }],
    // Composition, a second line, quotes.
    ['cat a\nrm b'], ['cat a && rm b'], ['cat a; rm b'], ['cat a | sh'], ['cat a > b'], ['cat `whoami`'], ['cat $(whoami)'],
    ['cat "unbalanced'], ["cat 'a'", { platform: 'win32' }],
    // Not read-only.
    ['npm install'], ['npm ci'], ['npm audit fix'], ['npm add x'], ['pip install x'],
    ['node script.js'], ['node -e "1"'], ['python x.py'], ['npx some-cli'], ['npx tsc'], ['npx tsc --noEmit --outDir x'],
    ['npx tsc --noEmit', { localBin: () => false }], ['npx vitest run', { localBin: () => false }],
    ['npx vitest'], ['npx eslint --fix src'], ['npx prettier --write .'], ['npx prettier .'], ['npx jest --watch'], ['npx jest -u'],
    ['ruff check --fix .'], ['go test -exec x ./...'], ['go build -o ../out'], ['pytest -p evil'],
    ['rm a.txt'], ['del a.txt', { platform: 'win32' }], ['mv a b'], ['cp a b'], ['mkdir x'], ['touch x'], ['chmod +x a'],
    ['curl http://x'], ['wget x'], ['ssh host'], ['scp a host:b'],
    ['sudo ls'], ['runas /user:x cmd', { platform: 'win32' }], ['reg query x', { platform: 'win32' }], ['taskkill /f /im node.exe', { platform: 'win32' }],
    ['sed -i s/a/b/ f'], ['awk "{print}" f'], ['env'], ['printenv'], ['set', { platform: 'win32' }], ['npm config get'], ['certutil -urlcache x', { platform: 'win32' }],
    ['npm test -- --outDir=../x'], ['npm run build -- ../x'],
    ['powershell -Command Get-Content x', { platform: 'win32' }],
  ]
  for (const [line, over] of bypasses) {
    test(JSON.stringify(line), () => assert.equal(tier(line, over), 'C', JSON.stringify(classifyCommand(line, ctx(over)))))
  }

  test('the test that this run changed scripts.test', () => {
    assert.equal(tier('npm test', { scriptsChangedThisRun: () => true }), 'C')
  })
})

describe('never "Always allow"', () => {
  const rows = ['git push', 'git push --force origin main', 'git reset --hard', 'git clean -fd', 'git checkout -- src/a.js', 'git restore src/a.js', 'rm -rf dist', 'rm -r x', 'rmdir /s /q dist', 'del /s *.log']
  for (const line of rows) {
    test(line, () => {
      const result = classifyCommand(line, ctx({ platform: line.includes('/s') ? 'win32' : 'linux' }))
      assert.equal(result.tier, 'C')
      assert.ok(result.tier === 'C' && result.neverAlways, JSON.stringify(result))
    })
  }

  test('an ordinary tier C line may still be always-allowed', () => {
    const result = classifyCommand('npm install', ctx())
    assert.ok(result.tier === 'C' && !result.neverAlways)
  })
})

describe('reading outside the workspace', () => {
  test('a folder the person allowed is readable; another is not', () => {
    assert.equal(tier(`cat ${path.join(sibling, 'README.md')}`, { readRoots: [sibling] }), 'A')
    assert.equal(tier(`cat ${path.join(sibling, 'README.md')}`), 'C')
    assert.equal(tier(`cat ${path.join(sibling, '.env')}`, { readRoots: [sibling] }), 'C', 'secrets still ask there')
  })
})

describe('splitWords', () => {
  test('double quotes group, and must balance', () => {
    assert.deepEqual(splitWords('grep "a b" "c"', 'linux'), ['grep', 'a b', 'c'])
    assert.equal(splitWords('grep "a', 'linux'), null)
    assert.deepEqual(splitWords('rg ""', 'linux'), ['rg', ''])
  })
})

describe('redactUrlCredentials', () => {
  test('masks the secret in a URL, and a bare token', () => {
    assert.equal(redactUrlCredentials('origin\thttps://pat:ghp_abc123@github.com/a/b.git (fetch)'), 'origin\thttps://pat:***@github.com/a/b.git (fetch)')
    assert.equal(redactUrlCredentials('https://ghp_abc123@github.com/a/b'), 'https://***@github.com/a/b')
    assert.equal(redactUrlCredentials('see https://github.com/a/b and git@github.com:a/b'), 'see https://github.com/a/b and git@github.com:a/b')
  })
})

test('a line that ends processes always asks, and never offers Always', () => {
  for (const line of ['taskkill /pid 20092 /F', 'kill -9 4242', 'pkill node', 'killall node']) {
    const result = classifyCommand(line, ctx())
    assert.equal(result.tier, 'C', line)
    assert.ok(result.tier === 'C' && result.neverAlways, `${line} offers Always`)
  }
  assert.equal(endsProcesses('powershell -Command Stop-Process -Id 1'), true)
  assert.equal(endsProcesses('npm test'), false)
  assert.deepEqual(pidsIn('taskkill /pid 20092 /pid 8080 /T /F'), [20092, 8080])
})

describe('&& chains, part by part', () => {
  /** A context that can move: `at` keeps everything but the folder. */
  const moving = (over: Partial<CommandContext> = {}): CommandContext => {
    const base = ctx(over)
    return { ...base, at: (cwd) => moving({ ...over, cwd }) }
  }
  const classify = (line: string, over: Partial<CommandContext> = {}) => classifyCommand(line, moving(over))

  test('cd into a workspace folder, then a safe command: runs unasked, judged from that folder', () => {
    for (const line of ['cd app && dir', 'cd app && ls -la', 'cd app && cat package.json', 'cd app && git status', 'pwd && ls']) {
      assert.equal(classify(line).tier, 'A', `${line}: ${JSON.stringify(classify(line))}`)
    }
    // The project's own check, from the folder it was cd'd to (Crestline: `cd Crestline && npm run check`).
    const check = classify('cd app && npm run lint')
    assert.equal(check.tier, 'B', JSON.stringify(check))
    // Windows: cd /d, and backslashes.
    assert.equal(classify('cd /d app && dir .svelte-kit\generated', { platform: 'win32', cwd: 'C:\ws', roots: ['C:\ws'] }).tier, 'A')
  })

  test('a cd that leaves the workspace, or a part that is not safe, asks', () => {
    assert.equal(classify(`cd ${sibling} && ls`).tier, 'C')
    assert.equal(classify('cd .. && ls').tier, 'C')
    assert.equal(classify('cat a && rm b').tier, 'C')
    // Without a context that can move, a chain that changes folder asks.
    assert.equal(classifyCommand('cd app && ls', ctx()).tier, 'C')
    // Only &&: a pipe or a redirect anywhere still asks, quotes or not.
    for (const line of ['cd app && ls | sh', 'cd app && ls > out.txt', 'cd app; ls', 'cd app || ls']) assert.equal(classify(line).tier, 'C', line)
    // && inside quotes is not split on, and the line is not judged part by part: it asks.
    assert.equal(classify('echo "a && b"').tier, 'C')
  })

  test('one part that asks is named, so "Always allow" can be offered for it alone', () => {
    const install = classify('cd app && npm install')
    assert.ok(install.tier === 'C' && install.asks === 'npm install', JSON.stringify(install))
    // Two parts that ask: the whole line asks, and nothing is named.
    const two = classify('cd app && npm install && node build.js')
    assert.ok(two.tier === 'C' && two.asks === undefined, JSON.stringify(two))
    // A part that discards work keeps its "asked every time".
    const discard = classify('cd app && git reset --hard')
    assert.ok(discard.tier === 'C' && discard.neverAlways && discard.asks === undefined, JSON.stringify(discard))
  })
})

test("tasklist lists this machine's processes unasked; another machine's asks", () => {
  assert.equal(tier('tasklist /FO CSV /NH', { platform: 'win32' }), 'A')
  assert.equal(tier('tasklist /FI "IMAGENAME eq node.exe" /FO TABLE', { platform: 'win32' }), 'A')
  assert.equal(tier('tasklist /S server01', { platform: 'win32' }), 'C')
})

describe('stderr redirects change nothing about a line (2026-11-24)', () => {
  test('2>&1, 2>nul, 2>/dev/null and 2>$null are dropped outside quotes', () => {
    assert.equal(withoutStderrRedirects('npx vitest run 2>&1'), 'npx vitest run')
    assert.equal(withoutStderrRedirects('dir src 2>nul'), 'dir src')
    assert.equal(withoutStderrRedirects('ls src 2> /dev/null'), 'ls src')
    assert.equal(withoutStderrRedirects('git status 2>$null && npm test 2>&1'), 'git status && npm test')
    assert.equal(withoutStderrRedirects('grep "a 2>&1 b" src'), 'grep "a 2>&1 b" src')
  })
  test('a redirect into a file, or of stdout, stays', () => {
    assert.equal(withoutStderrRedirects('npm test 2>err.txt'), 'npm test 2>err.txt')
    assert.equal(withoutStderrRedirects('npm test >nul 2>&1'), 'npm test >nul')
  })
  test('a safe line is still safe with them', () => {
    assert.equal(tier('npx vitest run 2>&1'), 'B')
    assert.equal(tier('npm test 2>&1'), 'B')
    assert.equal(tier('dir src 2>nul', { platform: 'win32' }), 'A')
    assert.equal(tier('npm test 2>out.txt'), 'C')
  })
})
