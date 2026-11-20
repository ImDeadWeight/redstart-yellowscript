// =============================================================================
// The disk side of safe-commands.ts: what the classifier asks about, answered
// from the real filesystem. Shared by the chat's command gate and the bench,
// so both judge a line the same way. No `vscode`.
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { CommandContext } from './safe-commands.ts'
import { secretReason, workspaceRelative } from './protected-paths.ts'

/** Entries a secrets scan looks at before giving up and saying "maybe". */
const SECRET_SCAN_LIMIT = 10_000

export interface NodeCommandContextOptions {
  cwd: string
  roots: readonly string[]
  readRoots?: readonly string[]
  builtInSafe: boolean
  projectChecks: boolean
  background: boolean
  /**
   * package.json in `cwd` as it was before this run first wrote it, or null
   * when this run has not written it. Decides "this run changed the scripts".
   */
  packageJsonBeforeRun?: (packageJsonPath: string) => string | null
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

function readScripts(text: string | null): Record<string, string> | null {
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as { scripts?: unknown }
    return typeof parsed.scripts === 'object' && parsed.scripts !== null ? (parsed.scripts as Record<string, string>) : {}
  } catch {
    return null
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** A bounded walk for a secrets file under `dir` (.git skipped). True when
 *  one is found, or when the walk is too big to finish: then it asks. */
export function secretsUnder(dir: string, limit = SECRET_SCAN_LIMIT): boolean {
  const stack = [dir]
  let seen = 0
  while (stack.length) {
    const current = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      // A file, not a directory: judge it by its own name.
      if (current === dir) return secretReason(dir) !== null
      continue
    }
    for (const entry of entries) {
      if (++seen > limit) return true
      if (entry.isDirectory()) {
        if (entry.name !== '.git') stack.push(path.join(current, entry.name))
      } else if (secretReason(entry.name)) {
        return true
      }
    }
  }
  return false
}

export function nodeCommandContext(options: NodeCommandContextOptions): CommandContext {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const packageJson = path.join(options.cwd, 'package.json')
  return {
    platform,
    cwd: options.cwd,
    roots: options.roots,
    readRoots: options.readRoots ?? [],
    builtInSafe: options.builtInSafe,
    projectChecks: options.projectChecks,
    background: options.background,
    shadowsProgram(name) {
      const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      return ['', ...exts].some((ext) => fs.existsSync(path.join(options.cwd, name + ext.toLowerCase())) || fs.existsSync(path.join(options.cwd, name + ext)))
    },
    scripts: () => readScripts(readText(packageJson)),
    scriptsChangedThisRun() {
      const before = options.packageJsonBeforeRun?.(packageJson) ?? null
      if (before === null) return false
      return JSON.stringify(readScripts(before)) !== JSON.stringify(readScripts(readText(packageJson)))
    },
    localBin(name) {
      // npx looks up the tree; so does this, as far as the workspace root.
      let dir = options.cwd
      for (;;) {
        const bin = path.join(dir, 'node_modules', '.bin', name)
        if (fs.existsSync(bin) || fs.existsSync(`${bin}.cmd`)) return true
        const parent = path.dirname(dir)
        if (parent === dir || workspaceRelative(options.roots, parent) === null) return false
        dir = parent
      }
    },
    hasSecretsUnder: (dir) => secretsUnder(dir),
  }
}
