// =============================================================================
// Protected paths — files the model may not change, or not without asking.
// =============================================================================
// The write tools refuse paths outside the workspace and, before this,
// nothing else. That left a model able to write `.git/config` (git runs
// `core.fsmonitor` on `git status`, and diff drivers on `git diff`) or to add
// itself an `allowedCommands` entry in `.vscode/settings.json`, and with
// "Always allow edits" or "Apply all in this task" either would apply without
// a prompt. Commands that run without asking (PLAN-long-tasks.md item 15) are
// only safe if the model cannot change what those commands do.
//
// Three rules, all judged on the RESOLVED path (resolveWithinWorkspace has
// already followed symlinks and `..`), compared case-insensitively:
//
//   refused   .git/ anywhere; .yellowscript/shadow/ (the checkpoints reverts
//             need); any change to a redstartYellowscript.* setting in
//             .vscode/settings.json or a *.code-workspace file.
//   ask       the rest of those settings files, .vscode/tasks.json and
//             .vscode/launch.json (what F5 and tasks run), and package.json
//             when its "scripts" change. Never auto-applied, like a deletion.
//   secret    reads of .env files, keys and credential files ask first: what a
//             read returns goes into the prompt and the transcript.
//
// Pure: no `vscode`, no I/O.
// =============================================================================

import * as path from 'node:path'

export type WriteVerdict = { refuse: string } | { ask: string } | null

/** A path relative to the workspace root that holds it, '/'-separated and
 *  lower-cased; null when it is in none of them. */
export function workspaceRelative(roots: readonly string[], absolutePath: string): string | null {
  const target = path.resolve(absolutePath).toLowerCase()
  for (const root of roots) {
    const base = path.resolve(root).toLowerCase()
    if (target === base) return ''
    if (target.startsWith(base + path.sep) || target.startsWith(`${base}/`)) {
      return target.slice(base.length + 1).replace(/\\/g, '/')
    }
  }
  return null
}

const SETTINGS_PREFIX = 'redstartyellowscript'

/** JSON with comments and trailing commas (VS Code's settings files). */
export function parseJsonc(text: string): unknown {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (ch === '\\') out += text[++i] ?? ''
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else {
      out += ch
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: {} }
  try {
    return { ok: true, value: parseJsonc(text) }
  } catch {
    return { ok: false }
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Yellowscript's own settings in a settings object, as comparable text. */
function ownSettings(settings: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (!isObject(settings)) return out
  for (const [key, value] of Object.entries(settings)) {
    if (key.toLowerCase().startsWith(SETTINGS_PREFIX)) out.set(key.toLowerCase(), JSON.stringify(value))
  }
  return out
}

function sameMap(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

/** Did a settings file's redstartYellowscript.* keys change? Null: unreadable. */
function ownSettingsChanged(before: string, after: string, workspaceFile: boolean): boolean | null {
  const a = tryParse(before)
  const b = tryParse(after)
  if (!b.ok) return null
  const pick = (v: unknown) => (workspaceFile ? (isObject(v) ? v.settings : undefined) : v)
  const was = a.ok ? ownSettings(pick(a.value)) : new Map<string, string>()
  return !sameMap(was, ownSettings(pick(b.value)))
}

/** Did package.json's "scripts" change? Null: unreadable. */
function scriptsChanged(before: string, after: string): boolean | null {
  const a = tryParse(before)
  const b = tryParse(after)
  if (!b.ok) return null
  const scripts = (v: unknown) => JSON.stringify(isObject(v) ? (v.scripts ?? null) : null)
  return !a.ok || scripts(a.value) !== scripts(b.value)
}

/**
 * The rule for writing one file. `before` and `after` are its whole content
 * (empty for a new file, or after a deletion).
 */
export function checkWrite(
  roots: readonly string[],
  absolutePath: string,
  change: { before: string; after: string; isDeleted: boolean },
): WriteVerdict {
  const rel = workspaceRelative(roots, absolutePath)
  if (rel === null) return null
  const segments = rel.split('/')
  const name = segments.at(-1) ?? ''

  if (segments.includes('.git')) {
    return { refuse: `${rel} is inside .git, whose config and hooks are programs git runs. Yellowscript does not change it; use git itself.` }
  }
  if (rel === '.yellowscript/shadow' || rel.startsWith('.yellowscript/shadow/')) {
    return { refuse: `${rel} is Yellowscript's checkpoint repository, which reverts depend on.` }
  }

  const settingsFile = rel === '.vscode/settings.json'
  const workspaceFile = name.endsWith('.code-workspace')
  if (settingsFile || workspaceFile) {
    const changed = ownSettingsChanged(change.before, change.isDeleted ? '' : change.after, workspaceFile)
    if (changed === true || (changed === null && change.after.toLowerCase().includes(SETTINGS_PREFIX))) {
      return { refuse: `This would change Yellowscript's own settings (redstartYellowscript.*) in ${rel}. Those are the person's to set; ask them to.` }
    }
    return { ask: `${rel} holds editor settings` }
  }
  if (rel === '.vscode/tasks.json' || rel === '.vscode/launch.json') {
    return { ask: `${rel} defines what runs on F5 or a task` }
  }
  if (name === 'package.json') {
    const changed = change.isDeleted ? true : scriptsChanged(change.before, change.after)
    if (changed !== false) return { ask: `this changes the "scripts" in ${rel}, which Yellowscript may run without asking` }
  }
  return null
}

/** The stricter of two verdicts: refuse beats ask beats nothing. */
export function stricter(a: WriteVerdict, b: WriteVerdict): WriteVerdict {
  if (a && 'refuse' in a) return a
  if (b && 'refuse' in b) return b
  return a ?? b
}

const SECRET_EXEMPT = new Set(['.env.example', '.env.sample', '.env.template'])
const SECRET_NAMES = new Set(['.npmrc', '.pypirc', '.git-credentials', '.netrc'])
const SECRET_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx']
const SECRET_PREFIXES = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa']

/**
 * Why reading this file asks first, or null. Its content would go into the
 * prompt and the saved transcript: .env files, private keys, registry and
 * git credentials.
 */
export function secretReason(absolutePath: string): string | null {
  const name = path.basename(absolutePath.replace(/\\/g, '/')).toLowerCase()
  if ((name === '.env' || name.startsWith('.env.')) && !SECRET_EXEMPT.has(name)) return `${name} usually holds secrets`
  if (SECRET_NAMES.has(name)) return `${name} can hold credentials`
  if (SECRET_EXTENSIONS.some((ext) => name.endsWith(ext))) return `${name} looks like a key or certificate`
  if (SECRET_PREFIXES.some((p) => name.startsWith(p))) return `${name} looks like an SSH key`
  return null
}
