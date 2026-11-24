// =============================================================================
// Background processes, and the registry of every process Yellowscript starts.
// =============================================================================
// A long-running command (npm run dev) keeps running, its output is kept in a
// bounded buffer, and the model reads what is new with ys_process "output" and
// ends it with "stop". Every background process dies with the window.
//
// The registry also lists one-shot commands (c1, c2…) next to background ones
// (p1, p2…), so ys_process list shows everything Yellowscript started and
// nothing else. No `vscode` import.
// =============================================================================

import type { ChildProcess } from 'node:child_process'
import { pidsIn, redactUrlCredentials } from './safe-commands.ts'
import {
  ANSI_ALL,
  BACKGROUND_BUFFER_CHARS,
  LABEL_RUN,
  killTree,
  labelEnv,
  runCommandLine,
  spawnShell,
  type CommandRun,
  type RunOptions,
} from './command-run.ts'

/** How many background processes may run at once. */
export const MAX_BACKGROUND = 4
/** Finished one-shot commands kept for ys_process list. */
export const KEPT_COMMANDS = 20

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
