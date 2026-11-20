// =============================================================================
// The run log — what an earlier message's run did, for the next message.
// =============================================================================
// Across messages the request carries only user and assistant text, so a
// second message used to start without knowing what the first one built.
// After a run, its tool effects (ToolResult.effect: writes, commands, process
// starts, page checks) are stored on the assistant message, and this renders
// them as one compact block sent after that message's text:
//
//   [What this run did]
//   created src/game.js, src/art.js; changed index.html
//   moved img/logo.png → assets/logo.png
//   ran `npm test` → exit 1 (2 failing)
//   started p1 `npm run dev` → http://localhost:5173
//   checked http://localhost:5173 → 1 problem: player is undefined
//
// Reads, searches and questions are left out; they changed nothing. Rejected
// writes and commands are listed as rejected, so the model does not assume
// they happened. Logs older than the last FULL_LOGS_KEPT assistant messages
// collapse to one line here, not in the context budget, so the prefix stays
// the same from request to request and the prompt cache holds.
//
// Pure: no `vscode`, no I/O.
// =============================================================================

import type { ToolEffect } from '../tools/types.ts'

/** Characters a full log may take; over that the earliest lines go. */
export const RUN_LOG_CAP = 600
/** How many of the newest assistant messages keep their full log. */
export const FULL_LOGS_KEPT = 6
/** Names listed on one line before "and N more". */
const NAMES_PER_LINE = 8
/** Commands listed before the earlier ones are counted instead. */
const COMMANDS_LISTED = 4

export const RUN_LOG_HEADER = '[What this run did]'

type FileState = 'created' | 'changed' | 'deleted'

function listNames(names: readonly string[]): string {
  if (names.length <= NAMES_PER_LINE) return names.join(', ')
  return `${names.slice(0, NAMES_PER_LINE).join(', ')} and ${names.length - NAMES_PER_LINE} more`
}

/** A write that is exactly one file created and one deleted is a move. */
function asMove(effect: Extract<ToolEffect, { kind: 'write' }>): { from: string; to: string } | null {
  if (effect.files.length !== 2) return null
  const to = effect.files.find((f) => f.isNew)
  const from = effect.files.find((f) => f.isDeleted)
  return to && from ? { from: from.path, to: to.path } : null
}

/** The run's lines, in a fixed order: files, moves, commands, processes, the check. */
export function runLogLines(effects: readonly ToolEffect[]): string[] {
  const files = new Map<string, FileState>()
  const moves: string[] = []
  const rejectedWrites: string[] = []
  const ran: string[] = []
  const rejectedCommands: string[] = []
  const started: string[] = []
  const stopped: string[] = []
  let check: Extract<ToolEffect, { kind: 'check' }> | null = null

  const setFile = (path: string, state: FileState) => {
    const before = files.get(path)
    if (state === 'changed' && before === 'created') return
    // Created and deleted in one run: it was never there.
    if (state === 'deleted' && before === 'created') {
      files.delete(path)
      return
    }
    files.set(path, state)
  }

  for (const effect of effects) {
    switch (effect.kind) {
      case 'write': {
        if (!effect.applied) {
          rejectedWrites.push(...effect.files.map((f) => f.path))
          break
        }
        const move = asMove(effect)
        if (move) {
          moves.push(`${move.from} → ${move.to}`)
          break
        }
        for (const f of effect.files) setFile(f.path, f.isNew ? 'created' : f.isDeleted ? 'deleted' : 'changed')
        break
      }
      case 'command': {
        const line = `\`${effect.command}\``
        if (!effect.ran) rejectedCommands.push(line)
        else if (effect.processId) {
          started.push(
            effect.exitCode !== null
              ? `${effect.processId} ${line} → exited ${effect.exitCode}`
              : `${effect.processId} ${line}${effect.url ? ` → ${effect.url}` : ''}`,
          )
        } else {
          const outcome = effect.exitCode !== null ? `exit ${effect.exitCode}` : 'did not finish'
          const detail = effect.failed && effect.lastLine ? ` (${effect.lastLine})` : ''
          ran.push(`${line} → ${outcome}${detail}`)
        }
        break
      }
      case 'stop':
        stopped.push(effect.processId)
        break
      case 'check':
        check = effect
        break
    }
  }

  const lines: string[] = []
  const byState = (state: FileState) => [...files].filter(([, s]) => s === state).map(([p]) => p)
  const fileParts = (['created', 'changed', 'deleted'] as const)
    .map((state) => [state, byState(state)] as const)
    .filter(([, names]) => names.length > 0)
    .map(([state, names]) => `${state} ${listNames(names)}`)
  if (fileParts.length) lines.push(fileParts.join('; '))
  if (moves.length) lines.push(`moved ${listNames(moves)}`)
  if (rejectedWrites.length) lines.push(`rejected, NOT written: ${listNames([...new Set(rejectedWrites)])}`)
  if (ran.length) {
    const earlier = ran.length - COMMANDS_LISTED
    lines.push(`ran ${ran.slice(-COMMANDS_LISTED).join('; ')}${earlier > 0 ? ` (and ${earlier} earlier)` : ''}`)
  }
  if (rejectedCommands.length) lines.push(`rejected, NOT run: ${listNames(rejectedCommands)}`)
  if (started.length) lines.push(`started ${started.join('; ')}`)
  if (stopped.length) lines.push(`stopped ${stopped.join(', ')}`)
  if (check) {
    lines.push(
      check.problems === 0
        ? `checked ${check.target} → no problems`
        : `checked ${check.target} → ${check.problems} problem${check.problems === 1 ? '' : 's'}${check.first ? `: ${check.first}` : ''}`,
    )
  }
  return lines
}

/** The full block, capped at RUN_LOG_CAP; null when the run changed nothing. */
export function formatRunLog(effects: readonly ToolEffect[]): string | null {
  const lines = runLogLines(effects)
  if (lines.length === 0) return null
  let dropped = 0
  const size = () => RUN_LOG_HEADER.length + lines.reduce((n, l) => n + l.length + 1, 0)
  while (lines.length > 1 && size() > RUN_LOG_CAP) {
    lines.shift()
    dropped++
  }
  if (lines.length === 1 && size() > RUN_LOG_CAP) lines[0] = `${lines[0]!.slice(0, RUN_LOG_CAP - RUN_LOG_HEADER.length - 2)}…`
  const note = dropped > 0 ? [`(${dropped} earlier line${dropped === 1 ? '' : 's'} not shown)`] : []
  return [RUN_LOG_HEADER, ...note, ...lines].join('\n')
}

/** One line for an older run: `[Earlier run: wrote 4 files, ran 3 commands]`. */
export function collapsedRunLog(effects: readonly ToolEffect[]): string | null {
  const written = new Set<string>()
  let commands = 0
  let rejected = 0
  for (const effect of effects) {
    if (effect.kind === 'write') {
      if (effect.applied) for (const f of effect.files) written.add(f.path)
      else rejected++
    } else if (effect.kind === 'command') {
      if (effect.ran) commands++
      else rejected++
    }
  }
  const parts: string[] = []
  if (written.size) parts.push(`wrote ${written.size} file${written.size === 1 ? '' : 's'}`)
  if (commands) parts.push(`ran ${commands} command${commands === 1 ? '' : 's'}`)
  if (rejected) parts.push(`${rejected} rejected`)
  return parts.length ? `[Earlier run: ${parts.join(', ')}]` : null
}

// ---------------------------------------------------------------------------
// The task summary card: the same effects, for the person.
// ---------------------------------------------------------------------------

export interface TaskSummaryView {
  files: { path: string; change: 'created' | 'changed' | 'deleted' }[]
  moves: { from: string; to: string }[]
  rejectedFiles: string[]
  commands: { command: string; exitCode: number | null; failed: boolean; rejected: boolean }[]
  processes: { id: string; command: string; url?: string; exited?: number }[]
  /** At least one applied write has a checkpoint, so the task can be reverted. */
  revertible: boolean
}

/** What the card shows; null when the run wrote nothing and ran nothing. */
export function taskSummary(effects: readonly ToolEffect[] | undefined): TaskSummaryView | null {
  if (!effects?.length) return null
  const files = new Map<string, FileState>()
  const view: TaskSummaryView = { files: [], moves: [], rejectedFiles: [], commands: [], processes: [], revertible: false }
  for (const effect of effects) {
    if (effect.kind === 'write') {
      if (!effect.applied) {
        for (const f of effect.files) if (!view.rejectedFiles.includes(f.path)) view.rejectedFiles.push(f.path)
        continue
      }
      if (effect.checkpoint) view.revertible = true
      const move = asMove(effect)
      if (move) {
        view.moves.push(move)
        continue
      }
      for (const f of effect.files) {
        const state: FileState = f.isNew ? 'created' : f.isDeleted ? 'deleted' : 'changed'
        const before = files.get(f.path)
        if (state === 'changed' && before === 'created') continue
        if (state === 'deleted' && before === 'created') files.delete(f.path)
        else files.set(f.path, state)
      }
    } else if (effect.kind === 'command') {
      if (effect.ran && effect.processId) {
        view.processes.push({
          id: effect.processId,
          command: effect.command,
          ...(effect.url ? { url: effect.url } : {}),
          ...(effect.exitCode !== null ? { exited: effect.exitCode } : {}),
        })
      } else {
        view.commands.push({ command: effect.command, exitCode: effect.exitCode, failed: effect.failed === true, rejected: !effect.ran })
      }
    }
  }
  view.files = [...files].map(([path, change]) => ({ path, change }))
  const empty = !view.files.length && !view.moves.length && !view.rejectedFiles.length && !view.commands.length && !view.processes.length
  return empty ? null : view
}

/** Where a file's diff "since the task started" begins: the first applied
 *  write in the run that touched it, and whether it did not exist before. */
export function fileBaseline(
  effects: readonly ToolEffect[],
  path: string,
): { revision: string; root: string; absolutePath: string; wasAbsent: boolean } | null {
  for (const effect of effects) {
    if (effect.kind !== 'write' || !effect.applied || !effect.checkpoint) continue
    const file = effect.files.find((f) => f.path === path)
    if (file?.absolutePath) return { ...effect.checkpoint, absolutePath: file.absolutePath, wasAbsent: file.isNew }
  }
  return null
}

/** The run's checkpointed writes, newest first: the order a revert undoes them,
 *  so a file written twice ends at its state before the task. */
export function revertSteps(
  effects: readonly ToolEffect[],
): { revision: string; root: string; files: { absolutePath: string; wasAbsent: boolean }[] }[] {
  const steps: { revision: string; root: string; files: { absolutePath: string; wasAbsent: boolean }[] }[] = []
  for (const effect of effects) {
    if (effect.kind !== 'write' || !effect.applied || !effect.checkpoint) continue
    const files = effect.files.flatMap((f) => (f.absolutePath ? [{ absolutePath: f.absolutePath, wasAbsent: f.isNew }] : []))
    if (files.length) steps.push({ ...effect.checkpoint, files })
  }
  return steps.reverse()
}
