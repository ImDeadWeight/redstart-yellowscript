// =============================================================================
// Running approved commands: one-shot, and in the background.
// =============================================================================
// ys_run_command used to run in the integrated terminal and read its output
// through shell integration. Without shell integration it captured nothing, and
// even with it there was no exit code, no timeout, and a dev server (which
// never exits) hung the whole run.
//
// This runs the approved line through child_process with the user's shell, so
// the line means what it would mean typed into a terminal, and returns the
// result in the shape Nest's own runner uses (agent-runtime plan D15):
//
//   Exit code 1 · 2.4s
//   --- stdout ---
//   ...first and last part...
//   --- stderr ---
//   ...
//
// The exit code is the first line because ignoring it is the failure that
// matters: a model that reads "tests ran" and not "Exit code 1".
//
// A long-running command (npm run dev) is a background process instead: it
// keeps running, its output is kept in a bounded buffer, and the model reads
// what is new with ys_process_output and ends it with ys_process_stop. Every
// background process dies with the window.
//
// The line runs only after the person approved it (or it matched their
// allowlist); nothing here decides that. No `vscode` import.
// =============================================================================

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

/** Default and maximum time a one-shot command may take. */
export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 900_000
/** Each stream is kept to its first and last part, this many characters in all. */
export const STREAM_CAP_CHARS = 8_000
/** A background process keeps at most this much of its newest output. */
export const BACKGROUND_BUFFER_CHARS = 200_000
/** How many background processes may run at once. */
export const MAX_BACKGROUND = 4

export interface CommandRun {
  exitCode: number | null
  /** The signal that ended it, when one did. */
  signal: string | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  /** Could not start at all (shell missing, bad cwd). */
  spawnError?: string
}

/** Keep the first and last part of a long text, saying how much was cut. */
export function capHeadTail(text: string, cap = STREAM_CAP_CHARS): string {
  if (text.length <= cap) return text
  const half = Math.floor(cap / 2)
  const cut = text.length - half * 2
  return `${text.slice(0, half)}\n…[${cut.toLocaleString('en-US')} characters omitted]…\n${text.slice(-half)}`
}

/** The result the model reads. */
export function formatCommandRun(run: CommandRun): string {
  const seconds = (run.durationMs / 1000).toFixed(1)
  let head: string
  if (run.spawnError) head = `Could not start the command: ${run.spawnError}`
  else if (run.timedOut) head = `Timed out after ${seconds}s and was stopped (exit code ${run.exitCode ?? 'none'}). For a server or watcher, use ys_process_start.`
  else if (run.exitCode === null) head = `Ended by signal ${run.signal ?? 'unknown'} · ${seconds}s`
  else head = `Exit code ${run.exitCode} · ${seconds}s`

  const parts = [head]
  const stdout = run.stdout.trimEnd()
  const stderr = run.stderr.trimEnd()
  if (stdout) parts.push(`--- stdout ---\n${capHeadTail(stdout)}`)
  if (stderr) parts.push(`--- stderr ---\n${capHeadTail(stderr)}`)
  if (!stdout && !stderr && !run.spawnError) parts.push('(no output)')
  return parts.join('\n')
}

/** A run failed when it did not start, timed out, or exited non-zero. */
export function runFailed(run: CommandRun): boolean {
  return !!run.spawnError || run.timedOut || run.exitCode !== 0
}

/** End a process and everything it started (a shell's children too). */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      // Started detached, so the shell leads its own group: kill the group.
      process.kill(-child.pid, 'SIGTERM')
    }
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

export interface RunOptions {
  command: string
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Every chunk as it arrives, for a live view. */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void
}

function spawnShell(command: string, cwd: string): ChildProcess {
  return spawn(command, {
    cwd,
    shell: true,
    env: process.env,
    windowsHide: true,
    // Its own process group on POSIX, so killTree can end the whole tree.
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Run one approved command line to completion (or its timeout). */
export function runCommandLine(options: RunOptions): Promise<CommandRun> {
  const timeoutMs = Math.min(Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS)
  const started = Date.now()
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawnShell(options.command, options.cwd)
    } catch (err) {
      resolve({ exitCode: null, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false, spawnError: err instanceof Error ? err.message : String(err) })
      return
    }
    // Kept whole while running (capped only when formatted), but bounded so a
    // runaway command cannot exhaust memory.
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let spawnError: string | undefined
    const keep = (buf: string, chunk: string) => (buf.length > 4 * BACKGROUND_BUFFER_CHARS ? buf : buf + chunk)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (c: string) => {
      stdout = keep(stdout, c)
      options.onOutput?.(c, 'stdout')
    })
    child.stderr?.on('data', (c: string) => {
      stderr = keep(stderr, c)
      options.onOutput?.(c, 'stderr')
    })

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    const onAbort = () => killTree(child)
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err) => {
      spawnError = err.message
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      const run: CommandRun = { exitCode: code, signal: signal ?? null, stdout, stderr, durationMs: Date.now() - started, timedOut }
      if (spawnError) run.spawnError = spawnError
      resolve(run)
    })
  })
}

// ---------------------------------------------------------------------------
// Background processes.
// ---------------------------------------------------------------------------

export interface BackgroundProcess {
  id: string
  command: string
  cwd: string
  startedAt: number
  /** null while running. */
  exitCode: number | null
  running: boolean
}

interface Entry extends BackgroundProcess {
  child: ChildProcess
  /** The newest output, bounded. */
  buffer: string
  /** Characters dropped from the front of the buffer so far. */
  dropped: number
  /** Absolute offset (dropped + position) the model has read up to. */
  readTo: number
}

export class BackgroundProcesses {
  private readonly entries = new Map<string, Entry>()
  private next = 1
  private readonly onOutput: ((id: string, chunk: string) => void) | undefined

  constructor(onOutput?: (id: string, chunk: string) => void) {
    this.onOutput = onOutput
  }

  /** Start an approved command. Throws when too many are running. */
  start(command: string, cwd: string): BackgroundProcess {
    const running = [...this.entries.values()].filter((e) => e.running)
    if (running.length >= MAX_BACKGROUND) {
      throw new Error(
        `${running.length} background processes are already running (${running.map((e) => e.id).join(', ')}). Stop one with ys_process_stop first.`,
      )
    }
    const id = `p${this.next++}`
    const child = spawnShell(command, cwd)
    const entry: Entry = { id, command, cwd, startedAt: Date.now(), exitCode: null, running: true, child, buffer: '', dropped: 0, readTo: 0 }
    const append = (chunk: string) => {
      entry.buffer += chunk
      if (entry.buffer.length > BACKGROUND_BUFFER_CHARS) {
        const over = entry.buffer.length - BACKGROUND_BUFFER_CHARS
        entry.buffer = entry.buffer.slice(over)
        entry.dropped += over
      }
      this.onOutput?.(id, chunk)
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (err) => append(`\n[could not start: ${err.message}]\n`))
    child.on('close', (code) => {
      entry.running = false
      entry.exitCode = code
    })
    this.entries.set(id, entry)
    return this.view(entry)
  }

  /**
   * What is new since the last read (or everything, `all`), after waiting up
   * to `waitMs` for the first output or for more.
   */
  async output(id: string, options: { waitMs?: number; all?: boolean } = {}): Promise<{ process: BackgroundProcess; text: string; missed: number } | null> {
    const entry = this.entries.get(id)
    if (!entry) return null
    const waitMs = Math.min(Math.max(0, options.waitMs ?? 0), 30_000)
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline && entry.running && entry.dropped + entry.buffer.length <= entry.readTo) {
      await new Promise((r) => setTimeout(r, 100))
    }
    const end = entry.dropped + entry.buffer.length
    const from = options.all ? entry.dropped : Math.max(entry.readTo, entry.dropped)
    const missed = options.all ? entry.dropped : Math.max(0, entry.dropped - entry.readTo)
    entry.readTo = end
    return { process: this.view(entry), text: entry.buffer.slice(from - entry.dropped), missed }
  }

  stop(id: string): BackgroundProcess | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    if (entry.running) killTree(entry.child)
    return this.view(entry)
  }

  /** End every process (the window is closing). */
  stopAll(): number {
    let n = 0
    for (const entry of this.entries.values()) {
      if (entry.running) {
        killTree(entry.child)
        n++
      }
    }
    return n
  }

  list(): BackgroundProcess[] {
    return [...this.entries.values()].map((e) => this.view(e))
  }

  private view(e: Entry): BackgroundProcess {
    return { id: e.id, command: e.command, cwd: e.cwd, startedAt: e.startedAt, exitCode: e.exitCode, running: e.running }
  }
}

/**
 * Which shell runs the approved lines, said the way a model needs it. Node's
 * `shell: true` is %ComSpec% (cmd.exe) on Windows and /bin/sh elsewhere, and
 * a model that assumes bash on Windows wastes turns on `ls`, `pwd`, `true`.
 */
export function shellNote(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') {
    const shell = (env.ComSpec ?? 'cmd.exe').split(/[\\/]/).pop() ?? 'cmd.exe'
    return (
      `Commands (ys_run_command, ys_process_start) run in Windows ${shell}, not bash: use dir, type, ` +
      'copy, move, del, mkdir, findstr, cd (no ls, cat, rm, pwd, grep, true). Chain with &&. ' +
      'Node, npm and npx work as usual.'
    )
  }
  return 'Commands (ys_run_command, ys_process_start) run in /bin/sh (POSIX shell).'
}
