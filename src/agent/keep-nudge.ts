// =============================================================================
// Asking the model to keep what it learned, when it has just learned it.
// =============================================================================
// The workspace message says what ys_note is for, once, among other things,
// and a small model does not act on it: in the steered Crestline run
// (2026-11-24) Ornith wrote one note, a summary of the task (which is the
// plan's job), and none of what the run paid for: `sv add` needs
// --no-git-check and vitest="usages:unit", sv create has no --yes. The next
// chat would rediscover all of it.
//
// agent-core's teaching.mjs found the same about tool names: a model sure of
// itself looks nothing up, but it reads what comes back. So this asks at the
// moment, in the next request's tail note (loop.ts withTailNotes):
//
//   recovered  a command family that failed earlier in this run now worked:
//              how it worked is the fact worth keeping
//   wrap-up    every plan step is closed, and the run recovered from
//              something on the way: one last look before the answer
//
// It asks at most MAX_NUDGES times a run, once per family, and stops once
// the model writes a note: it is a reminder, not a demand.
//
// Pure: the loop reports calls and outcomes, and reads the note to send.
// =============================================================================

import { actionFamily, failureLine, type CallInfo, type CallOutcome } from './agent-core.ts'

/** The most reminders one run gets. */
export const MAX_NUDGES = 2

export interface KeepNudge {
  /** After a call ran (or was refused). */
  observe(info: CallInfo, outcome: CallOutcome): void
  /** The note for the next request, if one is owed. `plan` is the current plan's statuses. */
  take(plan?: ReadonlyArray<{ status: string }> | null): string | null
}

function commandOf(args: string): { command: string; cwd?: string } | null {
  try {
    const parsed = JSON.parse(args) as { command?: unknown; cwd?: unknown }
    if (typeof parsed.command !== 'string') return null
    return typeof parsed.cwd === 'string' && parsed.cwd !== '' && parsed.cwd !== '.'
      ? { command: parsed.command, cwd: parsed.cwd }
      : { command: parsed.command }
  } catch {
    return null
  }
}

export function createKeepNudge(enabled = true): KeepNudge {
  /** Failed attempts per command family, with the last failure's line. */
  const failed = new Map<string, { times: number; line: string }>()
  const nudged = new Set<string>()
  let sent = 0
  let recoveries = 0
  let noted = false
  let wrappedUp = false
  let owed: string | null = null

  return {
    observe(info, outcome) {
      if (!enabled) return
      if (info.name === 'ys_note' && outcome.ok) {
        noted = true
        owed = null
        return
      }
      if (info.kind !== 'command' || outcome.refused || outcome.rejected) return
      const family = info.family ?? actionFamily(info.name, info.args, info.kind)
      const before = failed.get(family)
      if (!outcome.ok) {
        failed.set(family, { times: (before?.times ?? 0) + 1, line: failureLine(outcome.text ?? '') })
        return
      }
      if (!before) return
      failed.delete(family)
      recoveries++
      if (noted || nudged.has(family) || sent >= MAX_NUDGES) return
      nudged.add(family)
      const run = commandOf(info.args)
      const how = run ? ` It worked as \`${run.command}\`${run.cwd ? ` (cwd "${run.cwd}")` : ''}.` : ''
      const tries = before.times === 1 ? 'one failed try' : `${before.times} failed tries`
      const earlier = before.line ? ` Before that it failed with: "${before.line.slice(0, 120)}".` : ''
      // "ys_run_command:npx sv add" names the command as the model wrote it.
      const named = family.replace(/^[\w.-]+:/, '')
      owed =
        `\`${named}\` worked after ${tries}.${how}${earlier} A later chat in this workspace would hit the same ` +
        'thing and pay for it again. If what made it work is true of this project (a flag it needs, a version ' +
        'difference, where it must run), keep it now with ys_note, a line or two in a section such as "How to run". ' +
        'Then carry on.'
    },

    take(plan) {
      if (!enabled || noted || sent >= MAX_NUDGES) return null
      if (owed) {
        const note = owed
        owed = null
        sent++
        return note
      }
      const closed = plan && plan.length > 0 && plan.every((s) => s.status === 'done' || s.status === 'skipped')
      if (closed && !wrappedUp && recoveries > 0) {
        wrappedUp = true
        sent++
        return (
          'Every step of the plan is closed. Before you answer: this run got past failures on the way. If any of ' +
          'it is something a later chat would otherwise rediscover (how to build, check or run this project, a ' +
          'command that needs a flag or a cwd, a version that differs from what you expected), keep it with ys_note. ' +
          'Not the task or what you did; only what stays true of the project.'
        )
      }
      return null
    },
  }
}
