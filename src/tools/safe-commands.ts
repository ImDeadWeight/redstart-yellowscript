// =============================================================================
// Which command lines may run without asking (PLAN-long-tasks.md item 15).
// =============================================================================
// Every read tool runs without asking already. The prompts come when a small
// model reaches for the shell instead (`cat`, `git status`, `npm test`), and
// each one stops a long run until somebody answers it. So a line is put in
// one of three tiers:
//
//   A  read-only: listing, reading, searching, versions, read-only git.
//      Runs without asking unless `commands.builtInSafe` is off.
//   B  the project's own checks: its test/build/lint scripts, a dev server
//      in the background, locally installed test and lint tools. They run
//      the workspace's code, which the person already accepted as writes.
//      Runs without asking unless `commands.autoRunProjectChecks` is off.
//   C  everything else: asks, as before. Some never offer "Always allow".
//
// The line runs through a shell (cmd.exe on Windows, /bin/sh elsewhere) that
// rewrites it before the program sees it, so a check on the words alone is
// not enough. In order, any failure makes the line tier C:
//
//   1. no composition (&& || ; | & < > ` $( a second line)
//   2. no expansion ($ % ! ^ { } and ~ at the start of a word; on Windows a
//      single quote too, which cmd.exe does not treat as a quote)
//   3. words split cleanly (balanced double quotes)
//   4. a bare program name, not a path, and on Windows no file of that name
//      in the working directory (cmd.exe runs it before searching PATH)
//   5. the program's rule: an allowed subcommand, no denied flag
//   6. every path argument inside the workspace (or an extra read root), not
//      in .git, and not a secrets file; a search that recurses or globs only
//      where no secrets file lies under it.
//
// A tier A git line is run hardened: Yellowscript's own -c settings turn off
// fsmonitor, hooks, external diff and the pager; the model's -c is denied.
//
// Pure: everything it needs to know about the disk comes through
// `CommandContext`. No `vscode`.
// =============================================================================

import * as path from 'node:path'

import { SHELL_COMPOSITION } from './approval.ts'
import { secretReason, workspaceRelative } from './protected-paths.ts'

export interface CommandContext {
  platform: NodeJS.Platform
  /** Absolute working directory, already inside the workspace. */
  cwd: string
  /** Workspace roots, as the filesystem names them. */
  roots: readonly string[]
  /** Folders outside the workspace the person allowed reading. */
  readRoots: readonly string[]
  /** `commands.builtInSafe` */
  builtInSafe: boolean
  /** `commands.autoRunProjectChecks` */
  projectChecks: boolean
  /** Started in the background (ys_process start), not waited for. */
  background: boolean
  /** Windows: a file in `cwd` with this name and a PATHEXT extension. */
  shadowsProgram(name: string): boolean
  /** The "scripts" of package.json in `cwd`, or null without one. */
  scripts(): Record<string, string> | null
  /** This run changed package.json's scripts in `cwd`. */
  scriptsChangedThisRun(): boolean
  /** `node_modules/.bin/<name>` exists under `cwd`. */
  localBin(name: string): boolean
  /** A secrets file (protected-paths.ts) lies under this directory. */
  hasSecretsUnder(dir: string): boolean
  /** The same context in another folder: what a chain's `cd` moves to.
   *  Absent: a chain that changes folder asks. */
  at?(cwd: string): CommandContext
}

export type CommandTier =
  | {
      tier: 'A' | 'B'
      /** Shown on the card and in the output channel: why it ran unasked. */
      rule: string
      /** The line to actually run, when it differs (hardened git). */
      run?: string
      env?: Record<string, string>
    }
  | {
      tier: 'C'
      /** Why it was not tier A or B, for the log. */
      reason: string
      /** Set for lines that discard work: asked every time, no "Always allow". */
      neverAlways?: string
      /** In a `&&` chain whose other parts are all safe: the one part that
       *  asks. "Always allow" is offered for it, and an allowed prefix is
       *  matched against it. */
      asks?: string
    }

const c = (reason: string, neverAlways?: string): CommandTier => (neverAlways ? { tier: 'C', reason, neverAlways } : { tier: 'C', reason })

// --- Splitting ---------------------------------------------------------------

/** Words of the line, with double quotes removed; null when they do not balance. */
export function splitWords(line: string, platform: NodeJS.Platform): string[] | null {
  const words: string[] = []
  let current = ''
  let started = false
  let quoted = false
  for (const ch of line.trim()) {
    if (ch === '"') {
      quoted = !quoted
      started = true
    } else if (ch === "'" && platform !== 'win32') {
      // POSIX single quotes: treated like double quotes here; nothing inside
      // can expand anyway, since rule 2 already refused $ and friends.
      quoted = !quoted
      started = true
    } else if (/\s/.test(ch) && !quoted) {
      if (started) words.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (quoted) return null
  if (started) words.push(current)
  return words
}

const EXPANSION = /[$%!^{}]|(^|\s)~/

// --- Paths -------------------------------------------------------------------

function isFlag(word: string, platform: NodeJS.Platform): boolean {
  return word.startsWith('-') || (platform === 'win32' && /^\/[a-z?]/i.test(word))
}

function inside(roots: readonly string[], absolute: string): boolean {
  return workspaceRelative(roots, absolute) !== null
}

type PathKind = 'content' | 'names'

/**
 * Null when `word`, as a path argument, is allowed; else why not. `content`
 * paths are read (cat, grep); `names` are only listed (ls, find).
 */
function pathProblem(word: string, kind: PathKind, ctx: CommandContext, recursive: boolean): string | null {
  const glob = /[*?]/.test(word)
  if (glob && (path.isAbsolute(word) || word.split(/[\\/]/).includes('..'))) return `glob "${word}" outside the working directory`
  const absolute = path.resolve(ctx.cwd, glob ? path.dirname(word) : word)
  const allowed = [...ctx.roots, ...ctx.readRoots]
  if (!inside(allowed, absolute)) return `"${word}" is outside the workspace`
  const rel = workspaceRelative(allowed, absolute) ?? ''
  if (rel.split('/').includes('.git')) return `"${word}" is inside .git`
  if (rel === '.yellowscript/shadow' || rel.startsWith('.yellowscript/shadow/')) return `"${word}" is the checkpoint repository`
  if (kind === 'content') {
    if (!glob && secretReason(absolute)) return `"${word}" may hold secrets`
    if (glob && globCouldMatchSecret(path.basename(word))) return `"${word}" could match a file that holds secrets`
    if (recursive && ctx.hasSecretsUnder(absolute)) return `a file that may hold secrets is under "${word}"`
  }
  return null
}

/** Names a secrets file can have, to test a glob against. */
const SECRET_SAMPLES = ['.env', '.env.local', '.env.production', 'a.pem', 'a.key', 'a.p12', 'a.pfx', 'id_rsa', 'id_ed25519', 'id_ecdsa', '.npmrc', '.pypirc', '.git-credentials', '.netrc']

/** True when a file-name glob (`*.env`, `.e*`, `id_*`) could match a secrets file. */
function globCouldMatchSecret(pattern: string): boolean {
  const source = pattern.toLowerCase().replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  const regex = new RegExp(`^${source}$`)
  return SECRET_SAMPLES.some((name) => regex.test(name))
}

function checkPaths(words: readonly string[], kind: PathKind, ctx: CommandContext, recursive = false): string | null {
  for (const word of words) {
    const problem = pathProblem(word, kind, ctx, recursive)
    if (problem) return problem
  }
  return null
}

// --- Tier A ------------------------------------------------------------------

const LISTING = new Set(['ls', 'dir', 'tree', 'stat', 'file', 'du', 'wc'])
const READING = new Set(['cat', 'type', 'head', 'tail'])
const COMPARING = new Set(['diff', 'cmp', 'fc'])
const VERSIONED = new Set(['node', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'python', 'python3', 'py', 'pip', 'git', 'tsc', 'cargo', 'rustc', 'go', 'java', 'dotnet'])
const VERSION_FLAGS = new Set(['--version', '-v', '-V', 'version', '-version'])

const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'grep', 'rev-parse', 'describe', 'shortlog'])
const GIT_LISTING = new Set(['branch', 'tag', 'remote'])
const GIT_LIST_FLAGS = new Set(['-a', '-r', '-v', '-vv', '--list', '-l', '--show-current', '--all', '--remotes', '--verbose'])
const GIT_DENIED = ['-c', '--config-env', '--exec-path', '--git-dir', '--work-tree', '--output', '--ext-diff', '--textconv', '-O', '--open-files-in-pager', '-C', '--no-index', '--namespace', '--super-prefix']
/** Yellowscript's own settings for a read-only git line. */
const GIT_HARDENING = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-c', 'diff.external=', '-c', 'core.pager=cat']
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' }

function deniedFlag(args: readonly string[], denied: readonly string[]): string | null {
  for (const arg of args) {
    for (const flag of denied) {
      if (arg === flag || arg.startsWith(`${flag}=`)) return flag
      // A short flag with its value attached: -Ofoo, -cfoo.
      if (/^-[A-Za-z]$/.test(flag) && arg.startsWith(flag) && arg.length > 2 && !arg.startsWith('--')) return flag
    }
  }
  return null
}

function quoteForShell(word: string): string {
  return /[\s"]/.test(word) || word === '' ? `"${word.replace(/"/g, '\\"')}"` : word
}

function gitRule(args: readonly string[], ctx: CommandContext): CommandTier {
  const sub = args[0]
  if (sub === undefined) return c('bare git')
  const rest = args.slice(1)
  if (sub === 'push') return c('git push', 'git push sends work to another machine')
  if (sub === 'clean') return c('git clean', 'git clean deletes files that are not tracked')
  if (sub === 'reset' && rest.includes('--hard')) return c('git reset --hard', 'git reset --hard discards uncommitted work')
  if (sub === 'restore' || (sub === 'checkout' && rest.includes('--'))) return c(`git ${sub}`, `git ${sub} discards changes to files`)

  const denied = deniedFlag(args, GIT_DENIED)
  if (denied) return c(`git ${denied}`)

  let readOnly = GIT_READ.has(sub)
  if (sub === 'stash') readOnly = rest[0] === 'list' || rest[0] === 'show'
  if (GIT_LISTING.has(sub)) readOnly = rest.every((a) => GIT_LIST_FLAGS.has(a))
  if (!readOnly) return c(`git ${sub} changes the repository`)

  // git show rev:path reads a committed file: the same secrets rule as cat.
  for (const arg of rest) {
    const colon = arg.indexOf(':')
    if (colon > 0 && !arg.startsWith('-') && secretReason(arg.slice(colon + 1))) return c(`"${arg}" may hold secrets`)
  }
  const afterDashes = rest.indexOf('--')
  if (afterDashes >= 0) {
    const problem = checkPaths(rest.slice(afterDashes + 1), 'content', ctx)
    if (problem) return c(problem)
  }

  const diffLike = sub === 'diff' || sub === 'log' || sub === 'show' || (sub === 'stash' && rest[0] === 'show')
  const subWords = sub === 'stash' ? ['stash', rest[0]!] : [sub]
  const tail = sub === 'stash' ? rest.slice(1) : rest
  const run = ['git', ...GIT_HARDENING, ...subWords, ...(diffLike ? ['--no-ext-diff', '--no-textconv'] : []), ...tail].map(quoteForShell).join(' ')
  return { tier: 'A', rule: `git read-only (${subWords.join(' ')})`, run, env: GIT_ENV }
}

/** Arguments that take the next word as their value, per search program. */
const VALUE_FLAGS: Record<string, Set<string>> = {
  grep: new Set(['-e', '-A', '-B', '-C', '-m', '--regexp', '--max-count']),
  rg: new Set(['-e', '-g', '-t', '-T', '-A', '-B', '-C', '-m', '-M', '-j', '-d', '--regexp', '--glob', '--type', '--type-not', '--max-count', '--max-depth', '--max-columns', '--threads']),
}

function searchRule(program: string, args: readonly string[], ctx: CommandContext): CommandTier {
  if (program === 'rg') {
    const denied = deniedFlag(args, ['--pre', '--pre-glob', '-z', '--search-zip', '-f', '--file', '--ignore-file'])
    if (denied) return c(`rg ${denied} runs programs or reads other files`)
  }
  if (program === 'grep') {
    const denied = deniedFlag(args, ['-f', '--file'])
    if (denied) return c(`grep ${denied} reads another file`)
  }
  if (program === 'findstr' && args.some((a) => /^\/[gfd]:/i.test(a))) return c('findstr /g /f /d read other files')

  const valueFlags = VALUE_FLAGS[program] ?? new Set<string>()
  const positional: string[] = []
  let patternGiven = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (isFlag(arg, ctx.platform)) {
      if (arg === '-e' || arg === '--regexp' || /^\/c:/i.test(arg)) patternGiven = true
      if (valueFlags.has(arg)) i++
      continue
    }
    positional.push(arg)
  }
  const paths = patternGiven ? positional : positional.slice(1)
  const recursive =
    program === 'rg' || args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) && !a.startsWith('--') || a === '--recursive' || /^\/s$/i.test(a))
  const scope = paths.length ? paths : recursive ? ['.'] : []
  const problem = checkPaths(scope, 'content', ctx, recursive)
  return problem ? c(problem) : { tier: 'A', rule: `search (${program})` }
}

function findRule(args: readonly string[], ctx: CommandContext): CommandTier {
  const denied = deniedFlag(args, ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'])
  if (denied) return c(`find ${denied} changes files or runs programs`)
  const roots: string[] = []
  for (const arg of args) {
    if (arg.startsWith('-') || arg === '(' || arg === '!' || arg === ')') break
    roots.push(arg)
  }
  const problem = checkPaths(roots.length ? roots : ['.'], 'names', ctx)
  return problem ? c(problem) : { tier: 'A', rule: 'listing (find)' }
}

function tierA(program: string, args: readonly string[], ctx: CommandContext): CommandTier | null {
  const positional = args.filter((a) => !isFlag(a, ctx.platform))

  if (LISTING.has(program)) {
    const problem = checkPaths(positional, 'names', ctx)
    return problem ? c(problem) : { tier: 'A', rule: `listing (${program})` }
  }
  if (READING.has(program)) {
    if (program === 'tail' && args.some((a) => a === '-f' || a === '-F' || a === '--follow' || a.startsWith('--follow='))) return c('tail -f never ends')
    // head -n 20 file: the count is not a path.
    const paths: string[] = []
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!
      if (!isFlag(arg, ctx.platform)) paths.push(arg)
      else if (arg === '-n' || arg === '-c' || arg === '--lines' || arg === '--bytes') i++
    }
    const problem = checkPaths(paths, 'content', ctx)
    return problem ? c(problem) : { tier: 'A', rule: `reading (${program})` }
  }
  if (COMPARING.has(program)) {
    if (program === 'diff' && deniedFlag(args, ['--output'])) return c('diff --output writes a file')
    const problem = checkPaths(positional, 'content', ctx)
    return problem ? c(problem) : { tier: 'A', rule: `comparing (${program})` }
  }
  if (program === 'grep' || program === 'rg' || program === 'findstr') return searchRule(program, args, ctx)
  if (program === 'find') return findRule(args, ctx)
  if (program === 'sort' || program === 'uniq') {
    if (program === 'sort' && args.some((a) => a === '-o' || a.startsWith('-o') && !a.startsWith('--') || a === '--output' || a.startsWith('--output='))) return c('sort -o writes a file')
    if (program === 'uniq' && positional.length > 1) return c('uniq with two files writes the second')
    const problem = checkPaths(positional, 'content', ctx)
    return problem ? c(problem) : { tier: 'A', rule: `sorting (${program})` }
  }
  if (program === 'pwd' && args.length === 0) return { tier: 'A', rule: 'where am I (pwd)' }
  if (program === 'cd' && args.length === 0) return { tier: 'A', rule: 'where am I (cd)' }
  if (program === 'echo') return { tier: 'A', rule: 'echo' }
  // What is running, on this machine only (/s, /u and /p reach another).
  if (program === 'tasklist' && !args.some((x) => /^\/(s|u|p)$/i.test(x))) return { tier: 'A', rule: 'listing processes (tasklist)' }
  if ((program === 'where' || program === 'which') && positional.length > 0 && positional.every((a) => !/[\\/:]/.test(a))) return { tier: 'A', rule: `where am I (${program})` }
  if (program === 'command' && args[0] === '-v' && args.length === 2 && !/[\\/]/.test(args[1]!)) return { tier: 'A', rule: 'where am I (command -v)' }

  if (VERSIONED.has(program) && args.length === 1 && VERSION_FLAGS.has(args[0]!)) return { tier: 'A', rule: `version (${program})` }

  if (program === 'npm' || program === 'pnpm' || program === 'yarn') {
    const sub = args[0]
    const facts = new Set(['ls', 'list', 'view', 'info', 'outdated', 'audit', 'why'])
    if (sub === 'pkg' && args[1] === 'get') return { tier: 'A', rule: `package facts (${program} pkg get)` }
    if (sub && facts.has(sub)) {
      if (sub === 'audit' && args.slice(1).some((a) => a === 'fix' || a === '--fix')) return null
      return { tier: 'A', rule: `package facts (${program} ${sub})` }
    }
    return null
  }
  if (program === 'git') return gitRule(args, ctx)

  if (program === 'node' && args.length === 2 && (args[0] === '--check' || args[0] === '-c')) {
    const problem = checkPaths([args[1]!], 'names', ctx)
    return problem ? c(problem) : { tier: 'A', rule: 'syntax only (node --check)' }
  }
  if (program === 'npx' && args[0] === 'tsc') {
    if (!ctx.localBin('tsc')) return c('tsc is not installed in this project, and npx would download it')
    const rest = args.slice(1)
    if (!rest.includes('--noEmit')) return c('tsc without --noEmit writes files')
    const allowed = new Set(['--noEmit', '--pretty', '--skipLibCheck', '--strict', '-p', '--project'])
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!
      if (arg === '-p' || arg === '--project') {
        const problem = checkPaths([rest[i + 1] ?? ''], 'names', ctx)
        if (problem) return c(problem)
        i++
      } else if (!allowed.has(arg)) {
        return c(`tsc ${arg} is not on the syntax-only list`)
      }
    }
    return { tier: 'A', rule: 'syntax only (tsc --noEmit)' }
  }
  return null
}

// --- Tier B ------------------------------------------------------------------

const CHECK_SCRIPTS = new Set(['test', 'build', 'lint', 'typecheck', 'check', 'format:check'])
const SERVER_SCRIPTS = new Set(['dev', 'start', 'serve', 'preview'])
/** Arguments passed through to a script: plain flags, no paths. */
const PLAIN_FLAG = /^--?[\w-]+(=[\w.,:@-]*)?$/

function scriptOf(program: string, args: readonly string[]): { script: string; extra: readonly string[] } | null {
  const [sub, next, ...more] = args
  if (sub === undefined) return null
  if (program === 'npm') {
    if (sub === 'test' || sub === 't') return { script: 'test', extra: args.slice(1) }
    if (sub === 'start') return { script: 'start', extra: args.slice(1) }
    if ((sub === 'run' || sub === 'run-script') && next) return { script: next, extra: more }
    return null
  }
  if (program === 'pnpm' || program === 'yarn') {
    if (sub === 'run' && next) return { script: next, extra: more }
    if (!sub.startsWith('-')) return { script: sub, extra: args.slice(1) }
    return null
  }
  if (program === 'bun' && sub === 'run' && next) return { script: next, extra: more }
  return null
}

function packageScript(program: string, args: readonly string[], ctx: CommandContext): CommandTier | null {
  const found = scriptOf(program, args)
  if (!found) return null
  const server = SERVER_SCRIPTS.has(found.script)
  if (!CHECK_SCRIPTS.has(found.script) && !(server && ctx.background)) return null
  const scripts = ctx.scripts()
  const body = scripts?.[found.script]
  if (typeof body !== 'string') return c(`package.json has no "${found.script}" script`)
  if (ctx.scriptsChangedThisRun()) return c("this run changed package.json's scripts")
  const extra = found.extra.filter((a) => a !== '--')
  if (!extra.every((a) => PLAIN_FLAG.test(a))) return c('arguments passed to the script are not plain flags')
  return { tier: 'B', rule: `package script "${found.script}": ${body}` }
}

const LOCAL_TOOLS: Record<string, { denied: string[]; needs?: (args: readonly string[]) => string | null }> = {
  vitest: {
    denied: ['-u', '--update', '--outputFile', '--ui', '--watch', '-w'],
    needs: (args) => (args[0] === 'run' ? null : 'vitest without "run" watches and never ends'),
  },
  jest: { denied: ['-u', '--updateSnapshot', '--outputFile', '--watch', '--watchAll'] },
  eslint: { denied: ['--fix', '-o', '--output-file', '--cache-location'] },
  prettier: {
    denied: ['--write', '-w'],
    needs: (args) => (args.some((a) => a === '--check' || a === '-c' || a === '--list-different' || a === '-l') ? null : 'prettier without --check rewrites files'),
  },
  playwright: {
    denied: ['-u', '--update-snapshots', '--ui', '--output'],
    needs: (args) => (args[0] === 'test' ? null : 'only "playwright test"'),
  },
}

function localTool(program: string, args: readonly string[], ctx: CommandContext): CommandTier | null {
  if (program !== 'npx' || args[0] === undefined) return null
  const name = args[0].toLowerCase()
  const tool = LOCAL_TOOLS[name]
  if (!tool) return null
  const rest = args.slice(1)
  if (!ctx.localBin(name)) return c(`${name} is not installed in this project, and npx would download it`)
  const need = tool.needs?.(rest)
  if (need) return c(need)
  const denied = deniedFlag(rest, tool.denied)
  if (denied) return c(`${name} ${denied} writes files or never ends`)
  const problem = checkPaths(rest.filter((a) => !isFlag(a, ctx.platform) && a !== 'run' && a !== 'test'), 'names', ctx)
  return problem ? c(problem) : { tier: 'B', rule: `local tool (${name})` }
}

function otherChecks(program: string, args: readonly string[], ctx: CommandContext): CommandTier | null {
  const sub = args[0]
  const paths = (from: number) => checkPaths(args.slice(from).filter((a) => !isFlag(a, ctx.platform)), 'names', ctx)
  if (program === 'pytest' || ((program === 'python' || program === 'python3' || program === 'py') && sub === '-m' && args[1] === 'pytest')) {
    if (deniedFlag(args, ['-p'])) return c('pytest -p loads a plugin')
    const problem = paths(program === 'pytest' ? 0 : 2)
    return problem ? c(problem) : { tier: 'B', rule: 'python tests (pytest)' }
  }
  if (program === 'ruff' && sub === 'check') {
    const denied = deniedFlag(args, ['--fix', '--unsafe-fixes', '-o', '--output-file'])
    if (denied) return c(`ruff ${denied} writes files`)
    const problem = paths(1)
    return problem ? c(problem) : { tier: 'B', rule: 'python lint (ruff check)' }
  }
  if (program === 'mypy') {
    const problem = paths(0)
    return problem ? c(problem) : { tier: 'B', rule: 'python types (mypy)' }
  }
  if (program === 'cargo' && sub && ['check', 'test', 'clippy', 'build'].includes(sub)) {
    const denied = deniedFlag(args, ['--config', '--out-dir', '--manifest-path', '-Z'])
    if (denied) return c(`cargo ${denied}`)
    return { tier: 'B', rule: `rust (cargo ${sub})` }
  }
  if (program === 'go' && sub && ['vet', 'test', 'build'].includes(sub)) {
    const denied = deniedFlag(args, ['-o', '-exec', '-vettool', '-toolexec', '-modfile', '-overlay'])
    if (denied) return c(`go ${denied}`)
    return { tier: 'B', rule: `go (go ${sub})` }
  }
  return null
}

// --- Never "Always allow" --------------------------------------------------------

function discardsWork(program: string, args: readonly string[]): string | null {
  const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive' || /^\/s$/i.test(a))
  if ((program === 'rm' || program === 'del' || program === 'erase' || program === 'rmdir' || program === 'rd') && recursive) {
    return `${program} with a recursive flag deletes whole folders`
  }
  return null
}

/** Programs that end processes. Never "Always allow": a wrong pid takes down
 *  the editor, the Nest, or someone's work, and the card says which pids are
 *  Yellowscript's own. */
const PROCESS_ENDERS = new Set(['taskkill', 'tskill', 'kill', 'pkill', 'killall', 'stop-process', 'spps'])

/** True when the line's program ends processes (see PROCESS_ENDERS). */
export function endsProcesses(line: string): boolean {
  const first = line.trim().split(/\s+/)[0]?.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '') ?? ''
  return PROCESS_ENDERS.has(first) || /\bstop-process\b/i.test(line)
}

/** The process ids a kill line names (`taskkill /pid 123`, `kill -9 123`). */
export function pidsIn(line: string): number[] {
  return [...line.matchAll(/(?:^|[\s,=])(\d{2,7})(?=$|[\s,])/g)].map((m) => Number(m[1]))
}

// --- The classifier --------------------------------------------------------------

/** The tier of one command line. */
export function classifyCommand(line: string, ctx: CommandContext): CommandTier {
  if (SHELL_COMPOSITION.test(line)) {
    // `a && b`, and nothing else: each part on its own.
    const chain = andChain(line, ctx.platform)
    return chain ? classifyChain(chain, ctx) : c('the line pipes, redirects, or chains other than with &&')
  }
  if (EXPANSION.test(line)) return c('the line uses shell expansion ($, %, !, ^, braces or ~)')
  if (ctx.platform === 'win32' && line.includes("'")) return c("cmd.exe does not treat ' as a quote")
  const words = splitWords(line, ctx.platform)
  if (!words || words.length === 0) return c('the quotes do not balance')

  const raw = words[0]!
  if (/[\\/:]/.test(raw)) return c('the program is given as a path')
  const program = raw.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')
  const args = words.slice(1)
  if (ctx.platform === 'win32' && ctx.shadowsProgram(program)) return c(`a file named ${program} in the working directory would run instead`)

  const discards = discardsWork(program, args)
  if (discards) return c(discards, discards)
  if (PROCESS_ENDERS.has(program)) return c(`${program} ends processes`, 'it ends processes, and a wrong one can be the editor or the Nest')

  const a = tierA(program, args, ctx)
  if (a && a.tier === 'A') return ctx.builtInSafe ? a : c('built-in safe commands are turned off')
  if (a && a.tier === 'C' && (a.neverAlways || program === 'git')) return a

  const b = packageScript(program, args, ctx) ?? localTool(program, args, ctx) ?? otherChecks(program, args, ctx)
  if (b && b.tier === 'B') return ctx.projectChecks ? b : c("running the project's checks without asking is turned off")
  return b ?? a ?? c('not on the safe lists')
}

// --- && chains ----------------------------------------------------------------

/**
 * The parts of a line joined only by `&&` outside quotes, or null when it
 * composes any other way (a pipe, `;`, `||`, a redirect, a subshell).
 */
export function andChain(line: string, platform: NodeJS.Platform): string[] | null {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote) {
      if (ch === quote) quote = null
      current += ch
    } else if (ch === '"' || (ch === "'" && platform !== 'win32')) {
      quote = ch
      current += ch
    } else if (ch === '&' && line[i + 1] === '&') {
      parts.push(current)
      current = ''
      i++
    } else {
      current += ch
    }
  }
  if (quote) return null
  parts.push(current)
  const trimmed = parts.map((p) => p.trim())
  if (trimmed.length < 2 || trimmed.some((p) => p === '' || SHELL_COMPOSITION.test(p))) return null
  return trimmed
}

/** A `cd` part: the folder it moves to, a refusal, or null when it is not a cd. */
function cdStep(part: string, ctx: CommandContext): { to: string } | CommandTier | null {
  const words = splitWords(part, ctx.platform)
  const program = words?.[0]?.toLowerCase()
  if (!words || (program !== 'cd' && program !== 'chdir')) return null
  if (EXPANSION.test(part)) return c('cd uses shell expansion')
  let args = words.slice(1)
  const switchesDrive = ctx.platform === 'win32' && args[0]?.toLowerCase() === '/d'
  if (switchesDrive) args = args.slice(1)
  if (args.length === 0) return { to: ctx.cwd }
  if (args.length > 1) return c('cd is given more than one folder')
  const to = path.resolve(ctx.cwd, args[0]!)
  if (!inside(ctx.roots, to)) return c(`cd ${args[0]} leaves the workspace`)
  // cmd.exe's cd changes another drive's folder without moving there.
  if (ctx.platform === 'win32' && !switchesDrive && path.parse(to).root.toLowerCase() !== path.parse(ctx.cwd).root.toLowerCase()) {
    return c('cd to another drive without /d does not move there')
  }
  return { to }
}

/**
 * A `&&` chain, part by part: safe when every part would be on its own, with
 * a leading `cd` into a workspace folder moving where the rest is judged
 * from. Models write `cd Crestline && npm run check` for nearly everything
 * (2026-11-24), and as a whole line it asked every time, with no "Always
 * allow". When exactly one part asks, the tier says which (`asks`).
 */
function classifyChain(parts: readonly string[], ctx: CommandContext): CommandTier {
  let here = ctx
  const rules: string[] = []
  const lines: string[] = []
  let rewritten = false
  let env: Record<string, string> | undefined
  let projectCheck = false
  let asking: { part: string; tier: Extract<CommandTier, { tier: 'C' }> } | null = null
  for (const part of parts) {
    const moved = cdStep(part, here)
    if (moved && 'tier' in moved) return moved
    if (moved) {
      if (moved.to !== here.cwd) {
        const next = here.at?.(moved.to)
        if (!next) return c('the chain changes folder')
        here = next
      }
      lines.push(part)
      continue
    }
    const tier = classifyCommand(part, here)
    if (tier.tier === 'C') {
      // Discards work, or a second part that asks: the whole line asks, with no "Always allow".
      if (tier.neverAlways) return { ...tier, reason: `"${part}": ${tier.reason}` }
      if (asking) return c(`more than one part asks ("${asking.part}", "${part}")`)
      asking = { part, tier }
      lines.push(part)
      continue
    }
    if (tier.tier === 'B') projectCheck = true
    rules.push(tier.rule)
    if (tier.run) rewritten = true
    lines.push(tier.run ?? part)
    if (tier.env) env = { ...env, ...tier.env }
  }
  if (asking) return { tier: 'C', reason: `"${asking.part}": ${asking.tier.reason}`, asks: asking.part }
  const result: CommandTier = { tier: projectCheck ? 'B' : 'A', rule: rules.join('; ') || 'changing folder (cd)' }
  if (rewritten) result.run = lines.join(' && ')
  if (env) result.env = env
  return result
}

/** Credentials in URLs (`https://user:token@host`) masked, for the model. */
export function redactUrlCredentials(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)(:[^\s/@]*)?@/gi, (_m, scheme: string, user: string, secret: string | undefined) =>
    secret ? `${scheme}${user}:***@` : `${scheme}***@`,
  )
}
