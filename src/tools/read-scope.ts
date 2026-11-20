// =============================================================================
// Reading outside the workspace — asked once per folder, read-only.
// =============================================================================
// The read tools used to refuse any path outside the workspace. Reading a
// sibling repository (E:\redstart-project) or a global config is sometimes
// the right move, so for READS the refusal becomes a question: allow this
// time, always for this folder (redstartYellowscript.extraReadRoots), or deny.
// Writes outside the workspace stay refused with no option.
//
// Never offered, refused as before: the home directory itself and anything
// above it, the credential folders in it (~/.ssh, ~/.aws, ~/.gnupg,
// ~/.config/gh, ~/.docker, %APPDATA%\npm) and the system directories. The
// secrets-file rule (protected-paths.ts) still applies inside an extra root.
//
// No `vscode` import.
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { ToolContext } from './types.ts'
import { PathScopeError, resolveWithinWorkspace } from './workspace-path.ts'
import { workspaceRelative } from './protected-paths.ts'

export interface Environment {
  home: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
}

const here = (): Environment => ({ home: os.homedir(), platform: process.platform, env: process.env })

/** Folders that are never read from outside the workspace, whatever is allowed. */
export function neverReadable(environment: Environment = here()): string[] {
  const { home, platform, env } = environment
  const inHome = ['.ssh', '.aws', '.gnupg', path.join('.config', 'gh'), '.docker', '.kube', '.azure'].map((p) => path.join(home, p))
  if (platform === 'win32') {
    const system = [env.SystemRoot ?? 'C:\\Windows', env.ProgramFiles ?? 'C:\\Program Files', env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', env.ProgramData ?? 'C:\\ProgramData']
    const appData = env.APPDATA ? [path.join(env.APPDATA, 'npm'), path.join(env.APPDATA, 'gh')] : []
    return [...inHome, ...appData, ...system]
  }
  return [...inHome, '/etc', '/usr', '/bin', '/sbin', '/var', '/proc', '/dev', '/root', '/boot', '/System', '/Library', '/private']
}

const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const within = (parent: string, child: string) => workspaceRelative([parent], child) !== null

/** Why `absolutePath` may never be read from outside the workspace, or null. */
export function refusedOutside(absolutePath: string, environment: Environment = here()): string | null {
  const { home } = environment
  // Home itself, and every folder above it (C:\Users, C:\, /home, /).
  if (same(absolutePath, home) || within(absolutePath, home)) return 'the home folder and the folders above it are never read'
  const denied = neverReadable(environment).find((dir) => within(dir, absolutePath))
  return denied ? `${denied} is never read` : null
}

/**
 * The folder to offer "Always for this folder" on: the nearest project root
 * above the file (a folder with .git or package.json), else its own folder;
 * never home or above it.
 */
export function suggestReadRoot(absolutePath: string, environment: Environment = here(), exists = fs.existsSync): string {
  const own = exists(absolutePath) && fs.statSync(absolutePath).isDirectory() ? absolutePath : path.dirname(absolutePath)
  let dir = own
  for (;;) {
    if (refusedOutside(dir, environment)) return own
    if (exists(path.join(dir, '.git')) || exists(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return own
    dir = parent
  }
}

/** The extra roots that are still allowed (a setting can hold anything). */
export function usableReadRoots(roots: readonly string[] | undefined, environment: Environment = here()): string[] {
  return (roots ?? []).filter((root) => path.isAbsolute(root) && !refusedOutside(root, environment))
}

function real(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p
  }
}

/**
 * Resolve a path for a read tool: inside the workspace as before; outside it
 * only in an allowed folder, or after asking. Throws PathScopeError, as
 * resolveWithinWorkspace does, so the callers' messages stay the same.
 */
export async function resolveReadPath(context: ToolContext, requested: string, environment: Environment = here()): Promise<string> {
  try {
    return resolveWithinWorkspace(context.workspaceRoots, requested)
  } catch (err) {
    if (!(err instanceof PathScopeError) || err.reason !== 'escapes-workspace') throw err
  }
  const base = context.workspaceRoots[0]
  if (!base) throw new PathScopeError('no-workspace', 'No workspace folder is open')
  const absolute = real(path.resolve(base, requested))

  const refused = refusedOutside(absolute, environment)
  if (refused) throw new PathScopeError('escapes-workspace', `Path escapes the workspace: ${requested} (${refused})`)
  if (usableReadRoots(context.readRoots, environment).some((root) => within(real(root), absolute))) return absolute

  if (context.askRead) {
    const folder = suggestReadRoot(absolute, environment)
    const allowed = await context.askRead({ absolutePath: absolute, label: absolute, reason: 'it is outside the workspace', outsideFolder: folder })
    if (allowed) return absolute
  }
  throw new PathScopeError('escapes-workspace', `Path escapes the workspace: ${requested}`)
}
