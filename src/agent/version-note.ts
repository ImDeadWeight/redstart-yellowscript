// =============================================================================
// The "newer than you know" note: after the model reads a package.json, or
// runs a command that writes one (an install, a scaffold, an add-on), say
// which dependencies are past the versions it is likely to know, and that
// web_search has their current docs.
// =============================================================================
// The Crestline run (2026-11-24) scaffolded SvelteKit 3 and read its
// package.json, with "#lib/*" imports and "@sveltejs/kit": "^3.2.0" in it,
// then wrote `$lib/quote` the way SvelteKit 2 did and hunted for a tsconfig
// that version no longer writes. What is newer, and the note's text, are
// agent-core's (lookup.mjs); this decides when to say it, and reads the file.
//
// Said once per manifest per run: the same note on every read is noise.
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { manifestNote } from './agent-core.ts'
import { tryResolveWithinWorkspace } from '../tools/workspace-path.ts'

/** Commands that create or change a package.json's dependencies. */
const WRITES_MANIFEST =
  /^(?:(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|ci|create|init)\b|(?:npx|pnpm\s+dlx|bunx)\s+(?:-y\s+|--yes\s+)?(?:sv(?:@\S+)?\s+(?:create|add)|create-[\w-]+)\b)/i

/** Reads a file, or null. The tests pass their own. */
export type ReadText = (absolutePath: string) => string | null

const readText: ReadText = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/**
 * One run's note-giver. Returns the note for a call that just succeeded, or
 * null: nothing newer, no web tool, not a call that shows a manifest, or
 * already said.
 */
export function createVersionNotes(tools: readonly string[], roots: readonly string[], read: ReadText = readText) {
  const said = new Set<string>()
  return (name: string, args: string, ok: boolean): string | null => {
    if (!ok || roots.length === 0) return null
    const manifest = manifestFor(name, args, roots)
    if (!manifest || said.has(manifest)) return null
    const text = read(manifest)
    if (text === null) return null
    const note = manifestNote(text, tools)
    if (!note) return null
    said.add(manifest)
    return note
  }
}

/** The package.json a call read or may have written, absolute, or null. */
function manifestFor(name: string, args: string, roots: readonly string[]): string | null {
  let parsed: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(args)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    parsed = value as Record<string, unknown>
  } catch {
    return null
  }
  if (name === 'ys_read_file') {
    const p = typeof parsed.path === 'string' ? parsed.path : ''
    if (path.basename(p).toLowerCase() !== 'package.json') return null
    return tryResolveWithinWorkspace(roots, p)
  }
  if (name === 'ys_run_command') {
    const command = typeof parsed.command === 'string' ? parsed.command.trim() : ''
    if (!WRITES_MANIFEST.test(command)) return null
    const cwd = typeof parsed.cwd === 'string' && parsed.cwd.trim() ? parsed.cwd : '.'
    return tryResolveWithinWorkspace(roots, path.join(cwd, 'package.json'))
  }
  return null
}
