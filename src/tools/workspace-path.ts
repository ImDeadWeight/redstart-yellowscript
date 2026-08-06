// =============================================================================
// Workspace path containment — the guard every ws_* tool goes through.
// =============================================================================
// Reimplemented from redstart-nest's electron/main/path-scope.mjs (@ dde78ce).
// HANDOFF.md section 6 calls for exactly this: the *test cases* transplant, the
// code does not, because the two are confining to different things.
//
//   Nest:         ONE admin-configured root directory.
//   Yellowscript: the workspace's folders — of which VSCode allows SEVERAL.
//
// So the invariant here is "the resolved path lies inside SOME workspace
// folder", not "inside the root". With a single folder open the two collapse to
// the same thing, which is why Nest's cases still apply verbatim.
//
// THREAT MODEL (unchanged from the original, and the reason this file exists at
// all): the model — or a prompt injection riding in a file it read — supplies a
// path trying to reach outside the workspace, via `..`, an absolute path, a
// win32 drive-qualified path, or a symlink planted inside the workspace that
// points out of it. A lexical resolve()+startsWith() check catches the first
// three and NOT the fourth, so containment is decided against the real,
// symlink-resolved path.
//
// SYMLINKS INTO THE WORKSPACE ARE NOT FOLLOWED, deliberately. A path is checked
// lexically first and refused there if it is already outside every folder, so
// an outside path that would have *realpath'd* back inside (say /tmp/link ->
// the workspace) is refused rather than accepted. That is fail-closed, and it
// is also what keeps the guard fast: the overwhelmingly common rejection — a
// `..` that climbed out — costs one string comparison instead of a walk up the
// filesystem. Reaching a workspace file by its real path always works; reaching
// it through an alias outside the workspace does not.
//
// No `vscode` import on purpose: this is the piece that most needs to be
// testable without an extension host. The adapter that reads
// `workspace.workspaceFolders` and hands the paths in lives in the tool layer.
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'

/** Why a path was refused. Distinguished so the tool layer can tell the model
 *  something it can act on, and so a misconfiguration isn't reported as an
 *  attempted escape. */
export type PathRejection =
  | 'no-workspace' // nothing open, or every folder has vanished — not the model's fault
  | 'not-a-string'
  | 'invalid-character'
  | 'escapes-workspace'

export class PathScopeError extends Error {
  // Declared and assigned rather than a parameter property: Node's native type
  // stripping (what lets `npm test` run the .ts sources) rejects that syntax.
  readonly reason: PathRejection

  constructor(reason: PathRejection, message: string) {
    super(message)
    this.name = 'PathScopeError'
    this.reason = reason
  }

  /** True when the cause is the environment rather than the supplied path.
   *  Callers surface these differently: there is nothing for the model to
   *  correct by trying another path. */
  get isConfigurationError(): boolean {
    return this.reason === 'no-workspace'
  }
}

// Windows filesystems are case-insensitive, so a case-sensitive containment
// check could be walked around with "C:\WORK\..\..". Fold case on win32 only —
// POSIX paths stay case-sensitive, where that folding would itself be a bug.
function comparable(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/**
 * Resolve symlinks on the deepest ancestor of `p` that actually exists.
 *
 * The target itself may legitimately not exist — `ws_read_file` on a missing
 * file must fail as "not found", not as "escape", and Phase 3's write tools
 * address files before creating them. Every escape still has to travel through
 * some directory that *does* exist, so realpath-ing the existing portion is
 * enough to expose a planted link.
 */
function realpathDeepestExisting(p: string): string {
  let current = p
  const tail: string[] = []
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) return p // nothing on this drive exists — stay lexical
    tail.unshift(path.basename(current))
    current = parent
  }
  try {
    return path.join(fs.realpathSync.native(current), ...tail)
  } catch {
    // A race (the directory went away between existsSync and realpath) or a
    // permission error. Fall back to the lexical path: it is still subjected to
    // the containment check below, so this cannot open an escape.
    return p
  }
}

function isInside(realRoot: string, candidate: string): boolean {
  const root = comparable(realRoot)
  const target = comparable(candidate)
  // The trailing separator is load-bearing: without it "…/work-extra" passes a
  // startsWith test for "…/work" while being a different directory entirely.
  return target === root || target.startsWith(root + path.sep)
}

/** Workspace folders, symlink-resolved once so every check compares like with
 *  like. Folders that have disappeared are dropped rather than throwing — a
 *  removed folder shouldn't take the whole tool layer down with it. */
function realRootsOf(roots: readonly string[]): string[] {
  const resolved: string[] = []
  for (const root of roots) {
    if (typeof root !== 'string' || root.length === 0) continue
    try {
      resolved.push(fs.realpathSync.native(path.resolve(root)))
    } catch {
      // Folder no longer exists — skip it.
    }
  }
  return resolved
}

/**
 * Resolve a model-supplied path against the workspace and prove it stays
 * inside. Returns the resolved absolute path; throws `PathScopeError` on any
 * escape.
 *
 * An absolute path is taken as-is. A relative one is tried against each folder
 * in turn, preferring a folder where it actually exists — which is what makes
 * a bare `src/index.ts` do the obvious thing in a multi-root workspace instead
 * of resolving against folder #1 and reporting "not found".
 *
 * Containment is judged against ALL folders regardless of which one the
 * candidate came from, so `../other-folder/file.ts` is allowed when
 * `other-folder` is itself part of the workspace. The invariant is membership
 * of the workspace, not of any particular folder.
 */
export function resolveWithinWorkspace(roots: readonly string[], userPath: string): string {
  const realRoots = realRootsOf(roots)
  if (realRoots.length === 0) {
    throw new PathScopeError('no-workspace', 'No workspace folder is open')
  }
  if (typeof userPath !== 'string') {
    throw new PathScopeError('not-a-string', 'Path must be a string')
  }
  // A NUL byte truncates the path at the native layer, so what the check sees
  // and what the syscall opens can differ. Refuse outright.
  if (userPath.includes('\0')) {
    throw new PathScopeError('invalid-character', 'Path contains an invalid character')
  }

  const candidates = path.isAbsolute(userPath)
    ? [path.resolve(userPath)]
    : realRoots.map((root) => path.resolve(root, userPath))

  let firstContained: string | undefined
  for (const candidate of candidates) {
    // Lexical check first, and it is a rejection in its own right — see
    // "Symlinks INTO the workspace" below. It also keeps the common refusal
    // cheap: a path that has climbed out with `..` is settled with string
    // comparison, no filesystem calls at all.
    if (!realRoots.some((root) => isInside(root, candidate))) continue
    // Contained on paper. Now prove it on the actual filesystem, which is what
    // catches a link inside the workspace pointing out of it.
    const real = realpathDeepestExisting(candidate)
    if (!realRoots.some((root) => isInside(root, real))) continue
    // Prefer a candidate that exists; fall back to the first that is merely
    // contained, which is the right answer for a not-yet-created file.
    if (fs.existsSync(real)) return real
    firstContained ??= real
  }
  if (firstContained !== undefined) return firstContained

  throw new PathScopeError('escapes-workspace', `Path escapes the workspace: ${userPath}`)
}

/**
 * As `resolveWithinWorkspace`, but returns null when the *supplied path* is
 * refused, for call sites that would rather branch than catch.
 *
 * A missing workspace still throws: that is the environment being wrong, not
 * the path, and silently treating it as "denied" would have every tool report
 * an escape attempt to a user who simply has no folder open.
 */
export function tryResolveWithinWorkspace(
  roots: readonly string[],
  userPath: string,
): string | null {
  try {
    return resolveWithinWorkspace(roots, userPath)
  } catch (err) {
    if (err instanceof PathScopeError && !err.isConfigurationError) return null
    throw err
  }
}

/**
 * A short, stable label for an absolute path — what tool output and approval
 * cards should show instead of a machine-specific absolute path.
 *
 * Multi-root workspaces get a `folder/…` prefix, because `src/index.ts` is
 * ambiguous when two folders both have one. Anything not inside the workspace
 * comes back unchanged; callers should not be handing those in.
 */
export function describeWorkspacePath(roots: readonly string[], absolutePath: string): string {
  const realRoots = realRootsOf(roots)
  const target = realpathDeepestExisting(path.resolve(absolutePath))

  for (const root of realRoots) {
    if (!isInside(root, target)) continue
    const relative = path.relative(root, target)
    const label = relative === '' ? '.' : relative.split(path.sep).join('/')
    return realRoots.length > 1 ? `${path.basename(root)}/${label}` : label
  }
  return absolutePath
}
