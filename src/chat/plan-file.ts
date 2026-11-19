// =============================================================================
// The plan on disk: .yellowscript/PLAN.md.
// =============================================================================
// A multi-session project outlives a conversation. The update_plan checklist
// lived only in the conversation that made it, so a new chat started from
// nothing. It is now mirrored to a markdown checklist in the workspace, which
// a new conversation there picks up while steps are still open.
//
// The file is for people too: readable, and editable by hand. The format is a
// task list whose box says the status:
//
//   - [ ] pending      - [~] in progress      - [x] done      - [-] skipped
//     > a note, indented under its step
//
// No `vscode` import.
// =============================================================================

import type { PlanStep } from '../agent/agent-core.ts'

export const PLAN_FILE = 'PLAN.md'
/** Inside the workspace's .yellowscript folder (which also holds the shadow). */
export const PLAN_DIR = '.yellowscript'

const BOX: Record<PlanStep['status'], string> = { pending: ' ', in_progress: '~', done: 'x', skipped: '-' }
const STATUS: Record<string, PlanStep['status']> = { ' ': 'pending', '~': 'in_progress', x: 'done', X: 'done', '-': 'skipped' }

/** The file's text for these steps. */
export function formatPlanFile(steps: readonly PlanStep[]): string {
  const lines = [
    '# Yellowscript plan',
    '',
    '<!-- Kept by Yellowscript as the plan changes. A new conversation in this',
    '     workspace picks it up while steps are open. Edit it freely:',
    '     [ ] pending, [~] in progress, [x] done, [-] skipped. -->',
    '',
  ]
  for (const step of steps) {
    lines.push(`- [${BOX[step.status]}] ${step.text.replace(/\s*\n\s*/g, ' ').trim()}`)
    if (step.note) lines.push(`  > ${step.note.replace(/\s*\n\s*/g, ' ').trim()}`)
  }
  return `${lines.join('\n')}\n`
}

/** The steps in a plan file, or null when it holds none. Unknown lines are ignored. */
export function parsePlanFile(text: string): PlanStep[] | null {
  const steps: PlanStep[] = []
  for (const raw of text.split(/\r?\n/)) {
    const step = /^\s*[-*]\s+\[([ ~xX-])\]\s+(.+?)\s*$/.exec(raw)
    if (step) {
      steps.push({ text: step[2]!, status: STATUS[step[1]!]! })
      continue
    }
    const note = /^\s+>\s?(.*?)\s*$/.exec(raw)
    const last = steps[steps.length - 1]
    if (note && last && note[1]) last.note = last.note ? `${last.note} ${note[1]}` : note[1]
  }
  return steps.length > 0 ? steps : null
}

/** True when some step is still pending or in progress. */
export function hasOpenSteps(steps: readonly PlanStep[] | null): boolean {
  return !!steps && steps.some((s) => s.status === 'pending' || s.status === 'in_progress')
}
