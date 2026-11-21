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
// what is new with ys_process "output" and ends it with "stop". Every
// background process dies with the window.
//
// The line runs only after the person approved it (or it matched their
// allowlist); nothing here decides that. No `vscode` import.
// =============================================================================

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { pidsIn, redactUrlCredentials } from './safe-commands.ts'

/** Default and maximum time a one-shot command may take. */
export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 900_000
/** Each stream is kept to its first and last part, this many characters in all. */
export const STREAM_CAP_CHARS = 8_000
/** A background process keeps at most this much of its newest output. */
export const BACKGROUND_BUFFER_CHARS = 200_000
/** How many background processes may run at once. */
export const MAX_BACKGROUND = 4
/** A one-shot command quiet this long, its last line a prompt, is waiting
 *  for an answer it can never get: it is stopped then, not at its timeout. */
export const INPUT_WAIT_MS = 10_000
/** Finished one-shot commands kept for ys_process list. */
export const KEPT_COMMANDS = 20

/**
 * What every process Yellowscript starts carries in its environment, and so
 * does everything it starts in turn: which run it belongs to and which chat.
 * A person (or a script) can tell Yellowscript's processes from anything else
 * by these; the model is told its own through ys_process list instead.
 */
export const LABEL_RUN = 'YELLOWSCRIPT_RUN'
export const LABEL_CHAT = 'YELLOWSCRIPT_CHAT'

export interface ProcessLabel {
  /** c1, p1: the id the model and the log use. */
  id: string
  /** The conversation that started it. */
  chat?: string
}

/** The environment additions that label a process. */
export function labelEnv(label: ProcessLabel): Record<string, string> {
  return { [LABEL_RUN]: label.id, ...(label.chat ? { [LABEL_CHAT]: label.chat } : {}) }
}

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
  /** Stopped because it sat waiting for input: the prompt it showed. */
  waitingForInput?: string
  /** Exited on its own with a prompt as its last output: with no one to
   *  answer, it took the default (often No) and most likely did nothing. */
  endedAtPrompt?: string
  /** Stopped by ys_process stop, or by the person. */
  stopped?: boolean
  /** Its id in ys_process list, and its OS process id. */
  id?: string
  pid?: number
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
  else if (run.waitingForInput !== undefined)
    head =
      `Stopped after ${seconds}s: it was waiting for input, and a command run here cannot answer a prompt` +
      `${run.waitingForInput ? ` (it asked: "${run.waitingForInput}")` : ''}. It and everything it started have ended. ` +
      'Run it again non-interactively: give the answer as an option (often --yes, -y, --no-interactive or --force, ' +
      "or the option for that specific question), as the tool's --help describes."
  else if (run.stopped) head = `Stopped after ${seconds}s, with everything it started.`
  else if (run.timedOut) head = `Timed out after ${seconds}s and was stopped (exit code ${run.exitCode ?? 'none'}). For a server or watcher, use ys_process (action "start").`
  else if (run.exitCode === null) head = `Ended by signal ${run.signal ?? 'unknown'} · ${seconds}s`
  else head = `Exit code ${run.exitCode} · ${seconds}s`
  if (run.id) head += ` · ${run.id}${run.pid ? ` (pid ${run.pid})` : ''}`

  const parts = [head]
  if (run.endedAtPrompt !== undefined) {
    parts.push(
      `It ended on a prompt nobody could answer ("${run.endedAtPrompt}"), so it took the default and most likely did ` +
        'NOT do the work, whatever the exit code says. Check, then run it again with the answer as an option ' +
        "(often --yes, -y or --force, or the option for that question, as the tool's --help describes).",
    )
  }
  // `git remote -v` and `npm view` can print a token inside a URL.
  const stdout = redactUrlCredentials(run.stdout.trimEnd())
  const stderr = redactUrlCredentials(run.stderr.trimEnd())
  if (stdout) parts.push(`--- stdout ---\n${capHeadTail(stdout)}`)
  if (stderr) parts.push(`--- stderr ---\n${capHeadTail(stderr)}`)
  if (!stdout && !stderr && !run.spawnError) parts.push('(no output)')
  return parts.join('\n')
}

/** A run failed when it did not start, timed out, or exited non-zero. */
export function runFailed(run: CommandRun): boolean {
  return !!run.spawnError || run.timedOut || run.waitingForInput !== undefined || run.endedAtPrompt !== undefined || !!run.stopped || run.exitCode !== 0
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
  /** Added to the environment (a hardened git line's GIT_TERMINAL_PROMPT=0). */
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  /** Every chunk as it arrives, for a live view. */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void
  /** Labels the process and everything it starts (see LABEL_RUN). */
  label?: ProcessLabel
  /** Set CI=1 (unless the environment already sets CI), which makes most
   *  CLIs skip their prompts and test runners skip watch mode. */
  nonInteractive?: boolean
  /** Quiet time before a prompt-like last line counts as waiting for input;
   *  0 turns the check off. Default INPUT_WAIT_MS. */
  inputWaitMs?: number
  /** The child, once started: for whoever tracks it. */
  onSpawn?: (child: ChildProcess) => void
}

function spawnShell(command: string, cwd: string, env?: Record<string, string>): ChildProcess {
  return spawn(command, {
    cwd,
    shell: true,
    env: env ? { ...process.env, ...env } : process.env,
    windowsHide: true,
    // Its own process group on POSIX, so killTree can end the whole tree.
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

const ANSI_ALL = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\u001b[()][A-Z0-9]/g

/**
 * The question, when the end of a command's output is a prompt waiting for an
 * answer: `Continue? (y/N)`, clack's `◆  Which template?` with its options
 * below, `Password:`, `Press any key`. Null for anything else: a quiet build
 * is not a prompt. Only consulted after the command has been quiet a while.
 */
export function looksLikePrompt(tail: string): string | null {
  const lines = tail
    .replace(ANSI_ALL, '')
    .replace(/\r(?!\n)/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
  if (lines.length === 0) return null
  const last = lines[lines.length - 1]!.trim()
  const clean = (l: string) => l.replace(/^[\s│|◆◇●○◯❯>?✔✖•*-]+/u, '').trim()
  if (/\((y\/n|yes\/no)\)|\[(y\/n|yes\/no)\]/i.test(last)) return clean(last)
  if (/press (enter|return|any key)/i.test(last)) return clean(last)
  if (/\b(password|passphrase|username|token|otp|one-time code)\b[^:]*:\s*$/i.test(last)) return clean(last)
  // A question as the last line: "Continue?", "? Project name ›".
  if (/\?\s*(›|»|\(.*\))?\s*$/.test(last) || /^\?\s/.test(last) || /[›»]\s*\S*$/.test(last)) return clean(last)
  // clack and inquirer: an open question (◆ or ?) with its choices below it.
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i--) {
    const line = lines[i]!.trim()
    if (/^[◆?]\s+\S/u.test(line)) {
      // The header, and the question under it when it is on its own line:
      // "Directory not empty: … Continue?".
      const question = lines
        .slice(i + 1)
        .map(clean)
        .find((l) => /\?\s*$/.test(l))
      return question ? `${clean(line)} … ${question}` : clean(line)
    }
    // An answered question (◇) above means nothing is open. clack's └ only
    // closes the box under the open one.
    if (/^◇/u.test(line)) break
  }
  return null
}

/** Run one approved command line to completion (or its timeout). */
export function runCommandLine(options: RunOptions): Promise<CommandRun> {
  const timeoutMs = Math.min(Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS)
  const inputWaitMs = options.inputWaitMs ?? INPUT_WAIT_MS
  const started = Date.now()
  const env = {
    ...(options.nonInteractive && process.env.CI === undefined ? { CI: '1' } : {}),
    ...(options.label ? labelEnv(options.label) : {}),
    ...options.env,
  }
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawnShell(options.command, options.cwd, Object.keys(env).length ? env : undefined)
      options.onSpawn?.(child)
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
    let waitingForInput: string | undefined
    // Both streams interleaved, newest part only: what the prompt check reads.
    let recent = ''
    let lastOutputAt = Date.now()
    const keep = (buf: string, chunk: string) => (buf.length > 4 * BACKGROUND_BUFFER_CHARS ? buf : buf + chunk)
    const heard = (c: string) => {
      recent = (recent + c).slice(-2_000)
      lastOutputAt = Date.now()
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (c: string) => {
      stdout = keep(stdout, c)
      heard(c)
      options.onOutput?.(c, 'stdout')
    })
    child.stderr?.on('data', (c: string) => {
      stderr = keep(stderr, c)
      heard(c)
      options.onOutput?.(c, 'stderr')
    })

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    // Waiting on a prompt nobody can answer: end it now, and say so.
    const watchdog =
      inputWaitMs > 0
        ? setInterval(() => {
            if (waitingForInput !== undefined || Date.now() - lastOutputAt < inputWaitMs) return
            const prompt = looksLikePrompt(recent)
            if (prompt === null) return
            waitingForInput = prompt
            killTree(child)
          }, Math.min(500, inputWaitMs))
        : null
    const onAbort = () => killTree(child)
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err) => {
      spawnError = err.message
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (watchdog) clearInterval(watchdog)
      options.signal?.removeEventListener('abort', onAbort)
      const run: CommandRun = { exitCode: code, signal: signal ?? null, stdout, stderr, durationMs: Date.now() - started, timedOut }
      if (spawnError) run.spawnError = spawnError
      if (waitingForInput !== undefined && !timedOut) run.waitingForInput = waitingForInput
      else if (!timedOut && !spawnError && options.inputWaitMs !== 0) {
        const prompt = looksLikePrompt(recent)
        if (prompt !== null) run.endedAtPrompt = prompt
      }
      if (options.label) run.id = options.label.id
      if (child.pid !== undefined) run.pid = child.pid
      resolve(run)
    })
  })
}

// ---------------------------------------------------------------------------
// Every process Yellowscript starts: one-shot commands (c1, c2…) and
// background ones (p1, p2…), each with its OS process id and its labels.
// ---------------------------------------------------------------------------

export interface BackgroundProcess {
  id: string
  command: string
  cwd: string
  startedAt: number
  /** null while running. */
  exitCode: number | null
  running: boolean
  /** The first local address it printed (a dev server's banner), if any. */
  url?: string
  /** The OS process id of the shell it runs in. */
  pid?: number
}

/** One thing Yellowscript started, as ys_process list shows it. */
export interface ProcessRecord extends BackgroundProcess {
  kind: 'command' | 'background'
  /** How it ended when it did not simply exit. */
  ended?: 'timed out' | 'waiting for input' | 'stopped'
  endedAt?: number
  /** The last line it printed. */
  lastLine?: string
  /** The conversation that started it. */
  chat?: string
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{2,5}(?:\/[^\s'"()<>\]]*)?/i

/**
 * The first local address in a process's output: the line a dev server prints
 * when it is ready. Colour codes are stripped first (Vite bolds the port), and
 * 0.0.0.0 and [::] become localhost, which is where ys_check_page looks.
 */
export function detectServerUrl(text: string): string | null {
  const match = LOCAL_URL.exec(text.replace(ANSI, ''))
  if (!match) return null
  return match[0].replace(/[.,;:]+$/, '').replace(/\/\/(?:0\.0\.0\.0|\[::\])(?=:)/, '//localhost')
}

/** The last line with something on it, for a list entry. */
export function lastLineOf(text: string): string | null {
  const lines = text.replace(ANSI_ALL, '').split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean)
  const last = lines[lines.length - 1]
  if (!last) return null
  return last.length > 160 ? `${last.slice(0, 159)}…` : last
}

/** What starting a background command produced, for the model and the log. */
export interface BackgroundStart {
  text: string
  isError: boolean
  exitCode: number | null
  processId: string
  url?: string
}

/** How long a start waits for an address or an exit before answering. */
export const START_WAIT_MS = 5_000

/**
 * Start an approved background command and wait up to `waitMs` for it to
 * print a local address or exit, so the model is told which instead of
 * polling and parsing a banner. Throws as `start` does when too many run.
 */
export async function startInBackground(
  processes: BackgroundProcesses,
  command: string,
  cwd: string,
  waitMs = START_WAIT_MS,
  chat?: string,
): Promise<BackgroundStart> {
  const started = processes.start(command, cwd, chat)
  const settled = await processes.waitForStart(started.id, waitMs)
  const first = await processes.output(started.id)
  const output = redactUrlCredentials(first?.text.trimEnd() ?? '')
  const tail = output ? `\n--- output ---\n${output.slice(-4_000)}` : ''
  const id = started.id
  const named = `${id}${started.pid ? ` (pid ${started.pid})` : ''}`
  const more = `Read more with ys_process {"action":"output","id":"${id}"}; end it with "action":"stop".`

  if (!settled.running) {
    const code = settled.exitCode
    return {
      text: `${named} exited with code ${code ?? 'none'}: ${command}${tail || '\n(no output)'}`,
      isError: code !== 0,
      exitCode: code,
      processId: id,
    }
  }
  if (settled.url) {
    return {
      text: `${named} is serving ${settled.url} (${command}). Check it with ys_check_page.${tail}\n${more}`,
      isError: false,
      exitCode: null,
      processId: id,
      url: settled.url,
    }
  }
  return {
    text: `${named} is running (${command}); no address seen in its first ${Math.round(waitMs / 1000)}s.${tail || '\n(no output yet)'}\n${more}`,
    isError: false,
    exitCode: null,
    processId: id,
  }
}

/**
 * The live line for the workspace message: what is running now, so a new
 * message knows the dev server is up. Null when nothing runs.
 */
export function describeRunning(list: readonly BackgroundProcess[], now = Date.now()): string | null {
  const running = list.filter((p) => p.running)
  if (running.length === 0) return null
  const parts = running.map((p) => {
    const minutes = Math.max(0, Math.round((now - p.startedAt) / 60_000))
    const age = minutes < 1 ? 'just started' : `started ${minutes} min ago`
    return `${p.id} "${p.command}"${p.url ? ` → ${p.url}` : ''} (${p.pid ? `pid ${p.pid}, ` : ''}${age})`
  })
  return `Running now: ${parts.join('; ')}`
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

/**
 * ys_process list: everything this window started, oldest first. This is the
 * whole set: a process not on it is not Yellowscript's.
 */
export function formatProcessList(records: readonly ProcessRecord[], now = Date.now()): string {
  if (records.length === 0) {
    return 'Nothing started yet. Every process Yellowscript starts is listed here; any other process on this machine is not yours, so do not end it.'
  }
  const rows = records.map((r) => {
    const pid = r.pid ? `pid ${r.pid}` : 'pid ?'
    let state: string
    if (r.running) state = `running ${ago(now - r.startedAt)}${r.url ? ` → ${r.url}` : ''}`
    else if (r.ended === 'waiting for input') state = 'stopped: it was waiting for input'
    else if (r.ended === 'timed out') state = 'stopped: timed out'
    else if (r.ended === 'stopped') state = 'stopped'
    else state = `exited ${r.exitCode ?? '?'}`
    const finished = !r.running && r.endedAt ? `, ${ago(now - r.endedAt)} ago` : ''
    const last = r.lastLine ? `\n      last output: ${r.lastLine}` : ''
    return `${r.id}  ${pid}  ${r.kind === 'background' ? 'background' : 'command'}  ${state}${finished}\n      ${r.command}${last}`
  })
  return (
    `Started by Yellowscript in this window (${records.filter((r) => r.running).length} running). ` +
    `Each carries ${LABEL_RUN}=<id> in its environment, as does everything it started. ` +
    'A process not listed here is not yours: do not end it.\n' +
    rows.join('\n')
  )
}

interface Entry extends BackgroundProcess {
  child: ChildProcess
  /** The newest output, bounded. */
  buffer: string
  /** Characters dropped from the front of the buffer so far. */
  dropped: number
  /** Absolute offset (dropped + position) the model has read up to. */
  readTo: number
  chat?: string
  stopRequested: boolean
  endedAt?: number
}

interface CommandEntry extends ProcessRecord {
  child: ChildProcess | null
  stopRequested: boolean
}

export interface TrackedRunOptions extends Omit<RunOptions, 'label' | 'onSpawn'> {
  /** The conversation that runs it, for its label. */
  chat?: string
}

export class BackgroundProcesses {
  private readonly entries = new Map<string, Entry>()
  private readonly commands = new Map<string, CommandEntry>()
  private next = 1
  private nextCommand = 1
  private readonly onOutput: ((id: string, chunk: string) => void) | undefined

  constructor(onOutput?: (id: string, chunk: string) => void) {
    this.onOutput = onOutput
  }

  /**
   * Run an approved one-shot command to its end, as `c<n>`: labelled, listed
   * by ys_process list while it runs and after, and stoppable by its id.
   */
  async run(options: TrackedRunOptions): Promise<CommandRun> {
    const id = `c${this.nextCommand++}`
    const { chat, ...rest } = options
    const entry: CommandEntry = {
      id,
      kind: 'command',
      command: options.command,
      cwd: options.cwd,
      startedAt: Date.now(),
      exitCode: null,
      running: true,
      child: null,
      stopRequested: false,
      ...(chat ? { chat } : {}),
    }
    this.commands.set(id, entry)
    this.forgetOldCommands()
    const run = await runCommandLine({
      ...rest,
      label: chat ? { id, chat } : { id },
      onSpawn: (child) => {
        entry.child = child
        if (child.pid !== undefined) entry.pid = child.pid
      },
      onOutput: (chunk, stream) => {
        const line = lastLineOf(chunk)
        if (line) entry.lastLine = line
        options.onOutput?.(chunk, stream)
      },
    })
    if (entry.stopRequested && !run.timedOut && run.waitingForInput === undefined) run.stopped = true
    entry.running = false
    entry.exitCode = run.exitCode
    entry.endedAt = Date.now()
    entry.child = null
    if (run.waitingForInput !== undefined) entry.ended = 'waiting for input'
    else if (run.timedOut) entry.ended = 'timed out'
    else if (run.stopped) entry.ended = 'stopped'
    return run
  }

  /** Keep the newest finished commands only. */
  private forgetOldCommands(): void {
    const finished = [...this.commands.values()].filter((c) => !c.running)
    for (const old of finished.slice(0, Math.max(0, finished.length - KEPT_COMMANDS))) this.commands.delete(old.id)
  }

  /** Start an approved command. Throws when too many are running. */
  start(command: string, cwd: string, chat?: string): BackgroundProcess {
    const running = [...this.entries.values()].filter((e) => e.running)
    if (running.length >= MAX_BACKGROUND) {
      throw new Error(
        `${running.length} background processes are already running (${running.map((e) => e.id).join(', ')}). Stop one with ys_process (action "stop") first.`,
      )
    }
    const id = `p${this.next++}`
    const child = spawnShell(command, cwd, labelEnv(chat ? { id, chat } : { id }))
    const entry: Entry = {
      id,
      command,
      cwd,
      startedAt: Date.now(),
      exitCode: null,
      running: true,
      child,
      buffer: '',
      dropped: 0,
      readTo: 0,
      stopRequested: false,
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
      ...(chat ? { chat } : {}),
    }
    const append = (chunk: string) => {
      entry.buffer += chunk
      // Look at the tail, so a banner split across two chunks is still seen.
      if (!entry.url) {
        const url = detectServerUrl(entry.buffer.slice(-(chunk.length + 400)))
        if (url) entry.url = url
      }
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
      entry.endedAt = Date.now()
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

  /**
   * Wait up to `waitMs` for the process to print a local address or to exit,
   * whichever comes first.
   */
  async waitForStart(id: string, waitMs = START_WAIT_MS): Promise<BackgroundProcess> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`There is no background process "${id}".`)
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline && entry.running && !entry.url) {
      await new Promise((r) => setTimeout(r, 100))
    }
    return this.view(entry)
  }

  /** End a process this window started, and everything it started: a
   *  background one (p1) or a command still running (c1). */
  stop(id: string): ProcessRecord | null {
    const command = this.commands.get(id)
    if (command) {
      if (command.running && command.child) {
        command.stopRequested = true
        killTree(command.child)
      }
      return this.commandView(command)
    }
    const entry = this.entries.get(id)
    if (!entry) return null
    if (entry.running) {
      entry.stopRequested = true
      killTree(entry.child)
    }
    return this.record(entry)
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
    for (const command of this.commands.values()) {
      if (command.running && command.child) {
        killTree(command.child)
        n++
      }
    }
    return n
  }

  /** The background processes. */
  list(): BackgroundProcess[] {
    return [...this.entries.values()].map((e) => this.view(e))
  }

  /** Everything this window started, commands and background, oldest first. */
  records(): ProcessRecord[] {
    return [...[...this.entries.values()].map((e) => this.record(e)), ...[...this.commands.values()].map((c) => this.commandView(c))].sort(
      (a, b) => a.startedAt - b.startedAt,
    )
  }

  /** Is this one of ours: an id (c1, p1) or an OS process id we started? */
  owns(idOrPid: string | number): ProcessRecord | null {
    return this.records().find((r) => r.id === String(idOrPid) || (r.pid !== undefined && String(r.pid) === String(idOrPid))) ?? null
  }

  private view(e: Entry): BackgroundProcess {
    const view: BackgroundProcess = { id: e.id, command: e.command, cwd: e.cwd, startedAt: e.startedAt, exitCode: e.exitCode, running: e.running }
    if (e.url) view.url = e.url
    if (e.pid !== undefined) view.pid = e.pid
    return view
  }

  private record(e: Entry): ProcessRecord {
    const record: ProcessRecord = { ...this.view(e), kind: 'background' }
    const line = lastLineOf(e.buffer.slice(-2_000))
    if (line) record.lastLine = line
    if (e.chat) record.chat = e.chat
    if (e.endedAt) record.endedAt = e.endedAt
    if (!e.running && e.stopRequested) record.ended = 'stopped'
    return record
  }

  private commandView(c: CommandEntry): ProcessRecord {
    const { child: _child, stopRequested: _stop, ...record } = c
    return { ...record }
  }
}

/**
 * For a line that ends processes: which of the pids it names Yellowscript
 * started, and which it did not, so the person approving it knows.
 */
export function describeKillTargets(command: string, processes: BackgroundProcesses): string {
  const pids = pidsIn(command)
  const ours = processes.records()
  const mine = (pid: number) => ours.find((r) => r.pid === pid)
  const parts: string[] = []
  for (const pid of pids) {
    const r = mine(pid)
    parts.push(r ? `pid ${pid} is Yellowscript's ${r.id} (${r.command})` : `pid ${pid} was NOT started by Yellowscript`)
  }
  if (pids.length === 0) parts.push('It names no pid Yellowscript can check')
  const running = ours.filter((r) => r.running && r.pid)
  const list = running.length ? running.map((r) => `${r.id} pid ${r.pid}`).join(', ') : 'none'
  return `${parts.join('; ')}. Yellowscript's running processes: ${list}.`
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
      `Commands (ys_run_command, ys_process) run in Windows ${shell}, not bash: use dir, type, ` +
      'findstr, cd (no ls, cat, rm, pwd, grep, true). Node, npm and npx work as usual. ' +
      FILES_NOTE
    )
  }
  return `Commands (ys_run_command, ys_process) run in /bin/sh (POSIX shell). ${FILES_NOTE}`
}

/** Said with the shell: read-only and check commands run without asking;
 *  changing files belongs to the ys_ tools, which checkpoint; and where the
 *  processes it started are. */
const FILES_NOTE =
  'Read-only commands and the project\'s test, build and lint scripts run without asking; a chained or piped ' +
  'line asks. Change files with the ys_ tools (they keep a checkpoint), not with del, move, copy or mkdir. ' +
  'Commands cannot answer prompts: pass the non-interactive flag (--yes, -y, …); one that waits for input is stopped. ' +
  'Every process you start gets an id (c1 for a command, p1 for a background one) and its pid in the result, and ' +
  'ys_process {"action":"list"} shows them all; do not look for your processes with tasklist, Get-Process or ps, ' +
  'and never end a process that is not on that list.'
