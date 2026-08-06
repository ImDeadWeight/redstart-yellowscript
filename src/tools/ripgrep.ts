// =============================================================================
// Locating and running VSCode's bundled ripgrep.
// =============================================================================
// Both ws_glob and ws_grep run through here, so the two agree about what is in
// the workspace. That matters more than it sounds: rg honours .gitignore and
// `workspace.findFiles` does NOT (its own docs say `files.exclude` applies "but
// not search.exclude", and ignore files are not mentioned). A glob that lists
// node_modules and a grep that skips it would be an incoherent pair of tools.
//
// WHY RIPGREP AND NOT A NODE REGEX WALK — this is a safety property, not a
// performance preference:
//
//   ws_grep's pattern comes from the model, which can be influenced by file
//   content it just read. A pattern like (a+)+$ makes JS RegExp backtrack
//   catastrophically, SYNCHRONOUSLY, on the extension host's event loop. There
//   is no timeout that stops it and no way to abort it — VSCode simply freezes.
//   Rust's regex engine is linear-time by construction, and rg runs in a child
//   process we can kill when the user cancels.
//
// Consequently the fallback for a missing binary is deliberately DEGRADED to
// literal substring search rather than a JS regex engine: a fallback that
// reintroduced the hazard would be worse than no fallback at all.
//
// THE PATH IS NOT HARDCODED, because the obvious hardcoded path is wrong. On
// VSCode 1.129 the binary is at
//   <appRoot>/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/win32-x64/rg.exe
// which differs from the long-standing `node_modules/@vscode/ripgrep/bin/rg`
// in four ways at once: the asar-unpacked directory, the `-universal` package
// name, a platform-nested bin directory, and the .exe suffix. `appRoot` is also
// commit-hashed on current builds. Every known layout is tried in turn and the
// result is probed once at activation — see `locateRipgrep`.
//
// No `vscode` import: the caller passes `appRoot` in.
// =============================================================================

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Injected so the locator is testable on a machine with no VSCode install. */
export type ExistsFn = (candidate: string) => boolean

export interface LocateOptions {
  exists?: ExistsFn
  platform?: NodeJS.Platform
  arch?: string
}

/**
 * Every place the bundled binary has been known to live, most recent layout
 * first. Returned rather than probed so the list itself can be asserted in
 * tests without a filesystem.
 */
export function ripgrepCandidatePaths(
  appRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string[] {
  const exe = platform === 'win32' ? 'rg.exe' : 'rg'
  const triple = `${platform}-${arch}`

  // asar-unpacked first: on a packaged build the plain node_modules path may
  // exist inside the archive and not be executable.
  const containers = ['node_modules.asar.unpacked', 'node_modules']
  const packages = ['@vscode/ripgrep-universal', '@vscode/ripgrep']
  // Platform-nested is the current layout; flat is the historical one.
  const binDirs = [path.join('bin', triple), 'bin']

  const candidates: string[] = []
  for (const container of containers) {
    for (const pkg of packages) {
      for (const binDir of binDirs) {
        candidates.push(path.join(appRoot, container, ...pkg.split('/'), binDir, exe))
      }
    }
  }
  return candidates
}

/**
 * The first candidate that exists, or null.
 *
 * Call once at activation, not per search: a missing binary should disable
 * ws_grep with a stated reason rather than handing the model a tool that fails
 * on every call. HANDOFF.md applies the same rule to missing Nest endpoints —
 * degrade to a disabled feature, never a hard failure.
 */
export function locateRipgrep(appRoot: string, options: LocateOptions = {}): string | null {
  const exists = options.exists ?? ((candidate: string) => fs.existsSync(candidate))
  if (!appRoot) return null
  for (const candidate of ripgrepCandidatePaths(appRoot, options.platform, options.arch)) {
    if (exists(candidate)) return candidate
  }
  return null
}

/** rg's exit codes. `1` means "searched fine, found nothing" and must not be
 *  reported as an error — conflating the two would have the model conclude a
 *  search failed when it simply had no hits. */
export type RipgrepOutcome = 'matches' | 'no-matches' | 'error'

export function interpretExitCode(code: number | null): RipgrepOutcome {
  if (code === 0) return 'matches'
  if (code === 1) return 'no-matches'
  return 'error'
}

export interface RipgrepRun {
  outcome: RipgrepOutcome
  stdout: string
  stderr: string
  /** True when output hit the byte cap and the child was stopped early. */
  truncated: boolean
}

export interface RipgrepOptions {
  cwd: string
  signal?: AbortSignal
  /** Hard ceiling on captured stdout. rg is fast enough to produce far more
   *  than the context window can hold before anyone notices. */
  maxBytes?: number
  timeoutMs?: number
}

const DEFAULT_MAX_BYTES = 512 * 1024
const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Run rg and collect its output.
 *
 * `args` are passed as argv with NO SHELL. That is what makes it safe to put a
 * model-supplied pattern on the command line: there is no interpreter to
 * escape into, so shell metacharacters are inert data. Never add `shell: true`
 * here, and never build a command string.
 */
export function runRipgrep(
  binary: string,
  args: readonly string[],
  options: RipgrepOptions,
): Promise<RipgrepRun> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<RipgrepRun>((resolve, reject) => {
    const child = spawn(binary, [...args], {
      cwd: options.cwd,
      shell: false, // load-bearing — see above
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let truncated = false
    let settled = false

    const finish = (run: RipgrepRun): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve(run)
    }

    const stop = (): void => {
      truncated = true
      child.kill()
    }

    const timer = setTimeout(stop, timeoutMs)
    const onAbort = (): void => {
      // A cancelled turn must actually stop the work, not just ignore it.
      child.kill()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length >= maxBytes) return
      stdout += chunk
      if (stdout.length >= maxBytes) {
        stdout = stdout.slice(0, maxBytes)
        stop()
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      // Bounded separately: a permissions storm can produce a lot of these.
      if (stderr.length < 8_000) stderr += chunk
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })

    child.on('close', (code) => {
      // A killed child reports a null/signal code. If we stopped it on purpose
      // after collecting output, that is a truncated success, not an error.
      const outcome = truncated && stdout.length > 0 ? 'matches' : interpretExitCode(code)
      finish({ outcome, stdout, stderr, truncated })
    })
  })
}
