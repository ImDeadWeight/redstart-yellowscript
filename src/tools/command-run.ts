// =============================================================================
// Running approved commands: one-shot runs.
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
// A long-running command (npm run dev) is a background process instead: see
// background-processes.ts.
//
// The line runs only after the person approved it (or it matched their
// allowlist); nothing here decides that. No `vscode` import.
// =============================================================================

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { redactUrlCredentials } from './safe-commands.ts'

/** Default and maximum time a one-shot command may take. */
export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 900_000
/** Each stream is kept to its first and last part, this many characters in all. */
export const STREAM_CAP_CHARS = 8_000
/** A background process keeps at most this much of its newest output. */
export const BACKGROUND_BUFFER_CHARS = 200_000
/** A one-shot command quiet this long, its last line a prompt, is waiting
 *  for an answer it can never get: it is stopped then, not at its timeout. */
export const INPUT_WAIT_MS = 10_000

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
      "or the option for that specific question), as the tool's --help describes. " +
      'The person cannot answer it either: ask_user does not reach a running program.'
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
        "(often --yes, -y or --force, or the option for that question, as the tool's --help describes). " +
        'The person cannot answer it either: ask_user does not reach a running program.',
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

export function spawnShell(command: string, cwd: string, env?: Record<string, string>): ChildProcess {
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

export const ANSI_ALL = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\u001b[()][A-Z0-9]/g

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
  // clack's outro (`└  You're all set!`) means the run finished. An open
  // question's box closes with a bare └. Until 2026-11-24 the ◆ above a
  // success ("◆  Successfully setup add-ons: vitest") read as a question,
  // and the model was told a working `sv add` had done nothing.
  if (/^└\s*\S/u.test(last)) return null
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
      // A question asks something, or offers choices under it (radios,
      // checkboxes, the arrow-key hint); "◆  Successfully …" does neither.
      const below = lines.slice(i + 1).join('\n')
      if (!/\?/.test(line) && !/\?\s*$/m.test(below) && !/[○◯◻◼]|↑\/↓|›/u.test(below)) continue
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
