// =============================================================================
// Tasks: what one user message's run wrote, and undoing it.
// =============================================================================
// A task is one user message's run: it starts when that message runs (not when
// it queues) and ends with the turn. "Apply all in this task" lasts until then;
// its checkpoints stay for Revert Last Task. The last checkpoint per workspace
// root is kept too, for Revert Last Write.
//
// Also here: the workspace's plan file (.yellowscript/PLAN.md), which a new
// conversation carries on while it has open steps.
// =============================================================================

import * as vscode from 'vscode'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import { tmpdir } from 'node:os'

import type { PlanStep } from '../agent/agent-core.ts'
import { PLAN_DIR, PLAN_FILE, formatPlanFile, hasOpenSteps, parsePlanFile } from '../chat/plan-file.ts'
import { fileBaseline, revertSteps } from '../chat/run-log.ts'
import type { Checkpoint, StagedFile } from '../tools/checkpoint.ts'
import type { ToolEffect } from '../tools/types.ts'
import { checkpointForWorkspace, shadowKey } from '../ui/write-approval.ts'

/** One checkpointed write of a task. */
export interface TaskCheckpoint {
  root: string
  checkpoint: Checkpoint
  files: readonly StagedFile[]
}

export interface TasksDeps {
  log: Pick<vscode.LogOutputChannel, 'info' | 'warn' | 'error'>
  /** The open workspace folders. */
  roots: () => string[]
}

export interface Tasks {
  /** A user message started running: a new task, untrusted, no checkpoints. */
  start(conversationId: string): void
  /** Its turn ended: "Apply all in this task" lapses; the checkpoints stay. */
  end(conversationId: string): void
  trusted(conversationId: string): boolean
  trust(conversationId: string): void
  /** A write of this conversation's task was checkpointed. */
  recordCheckpoint(conversationId: string, root: string, checkpoint: Checkpoint, files: readonly StagedFile[]): void
  /** The running (or last) task's checkpoints, oldest first. */
  checkpoints(conversationId: string): readonly TaskCheckpoint[]
  /** The command: restore the files of the most recent write. */
  revertLastWrite(): Promise<void>
  /** The command: undo every write of the last task. */
  revertLastTask(): Promise<void>
  /** A task summary's file link. */
  openDiff(run: readonly ToolEffect[], file: string): Promise<void>
  /** A task summary's Revert. */
  revert(run: readonly ToolEffect[]): Promise<void>
  /** The open plan in the workspace, or null. */
  readPlan(): PlanStep[] | null
  /** Keep the plan on disk; null or empty removes the file. */
  writePlan(steps: PlanStep[] | null): void
}

export function createTasks(deps: TasksDeps): Tasks {
  /** Last successful write checkpoint per workspace root, for `Revert Last Write`.
   *  Only the most recent is kept — a multistep revert is out of scope for now. */
  const lastCheckpoint = new Map<string, { checkpoint: Checkpoint; files: readonly StagedFile[] }>()
  /** Per conversation: the running task's trust, and every write it checkpointed. */
  const tasks = new Map<string, { trusted: boolean; checkpoints: TaskCheckpoint[] }>()
  /** The conversation whose task wrote last, for Revert Last Task. */
  let lastTaskConversation: string | null = null
  const taskFor = (conversationId: string) => {
    let task = tasks.get(conversationId)
    if (!task) {
      task = { trusted: false, checkpoints: [] }
      tasks.set(conversationId, task)
    }
    return task
  }

  /**
   * Restore the files from the most recent approved write via the shadow git
   * checkpoint. This is the safety net Phase 3 promised: every write is snapshotted
   * before it touches disk, so a bad edit or a confused model can be undone.
   *
   * Only the LAST checkpoint is tracked (a multi-step undo history is out of
   * scope). If no write has happened this session, or the checkpoint was never
   * created (e.g. git was unavailable), we say so rather than guessing.
   */
  async function revertLastWrite(): Promise<void> {
    const roots = deps.roots()
    if (roots.length === 0) {
      vscode.window.showWarningMessage('Open a workspace folder before reverting a write.')
      return
    }
    const root = roots[0]!
    const last = lastCheckpoint.get(root)
    if (!last) {
      vscode.window.showInformationMessage('Yellowscript: nothing to revert — no write has been checkpointed yet.')
      return
    }

    const files = last.files.map((f) => f.workspaceAbsolute)
    const choice = await vscode.window.showWarningMessage(
      `Revert the last Yellowscript write? This restores ${files.length} file${files.length === 1 ? '' : 's'} to their pre-write state:`,
      { modal: true, detail: files.join('\n') },
      'Revert',
    )
    if (choice !== 'Revert') return

    try {
      const manager = checkpointForWorkspace(root)
      await manager.revert(last.checkpoint, last.files)
      lastCheckpoint.delete(root)
      vscode.window.showInformationMessage(`Yellowscript: reverted the last write (${files.length} file${files.length === 1 ? '' : 's'}).`)
      deps.log.info(`revert: restored ${files.length} file(s) from checkpoint ${last.checkpoint.revision.slice(0, 12)}`)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      vscode.window.showErrorMessage(`Could not revert the last write: ${reason}`)
      deps.log.error('revert failed', err)
    }
  }

  /** The workspace plan's path, or null with no folder open. */
  function workspacePlanPath(): string | null {
    const root = deps.roots()[0]
    return root ? nodePath.join(root, PLAN_DIR, PLAN_FILE) : null
  }

  /** The open plan in the workspace, or null (no file, or every step closed). */
  function readPlan(): PlanStep[] | null {
    const file = workspacePlanPath()
    if (!file) return null
    try {
      const steps = parsePlanFile(nodeFs.readFileSync(file, 'utf8'))
      return hasOpenSteps(steps) ? steps : null
    } catch {
      return null
    }
  }

  /** Keep the plan on disk; a cleared plan removes the file. Never fails a turn. */
  function writePlan(steps: PlanStep[] | null): void {
    const file = workspacePlanPath()
    if (!file) return
    try {
      if (steps && steps.length > 0) {
        nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true })
        nodeFs.writeFileSync(file, formatPlanFile(steps), 'utf8')
      } else {
        nodeFs.rmSync(file, { force: true })
      }
    } catch (err) {
      deps.log.warn(`plan: could not write ${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Undo every write the last task made, newest first, so a file written twice
   * ends at its state before the task. Files the task created are removed.
   */
  async function revertLastTask(): Promise<void> {
    const task = lastTaskConversation ? tasks.get(lastTaskConversation) : undefined
    if (!task || task.checkpoints.length === 0) {
      vscode.window.showInformationMessage('Yellowscript: nothing to revert — the last task made no checkpointed writes.')
      return
    }
    const files = [...new Set(task.checkpoints.flatMap((c) => c.files.map((f) => f.workspaceAbsolute)))]
    const choice = await vscode.window.showWarningMessage(
      `Revert the last Yellowscript task? It made ${task.checkpoints.length} write${task.checkpoints.length === 1 ? '' : 's'}; ` +
        `${files.length} file${files.length === 1 ? '' : 's'} go back to how they were before it (files it created are deleted):`,
      { modal: true, detail: files.join('\n') },
      'Revert task',
    )
    if (choice !== 'Revert task') return

    try {
      for (const entry of [...task.checkpoints].reverse()) {
        await checkpointForWorkspace(entry.root).revert(entry.checkpoint, entry.files)
      }
      deps.log.info(`revert: undid ${task.checkpoints.length} write(s) of the last task (${files.length} file(s))`)
      task.checkpoints = []
      lastCheckpoint.clear()
      vscode.window.showInformationMessage(`Yellowscript: reverted the last task (${files.length} file${files.length === 1 ? '' : 's'}).`)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      vscode.window.showErrorMessage(`Could not revert the last task: ${reason}`)
      deps.log.error('task revert failed', err)
    }
  }

  /**
   * The task summary's file link: the file now, against its state before the
   * run first wrote it (from the checkpoint stored with the run, so it works
   * after a reload too).
   */
  async function openDiff(run: readonly ToolEffect[], file: string): Promise<void> {
    const base = fileBaseline(run, file)
    if (!base) {
      vscode.window.showInformationMessage(`Yellowscript: there is no checkpoint for ${file} in this task.`)
      return
    }
    try {
      const before = base.wasAbsent ? '' : await checkpointForWorkspace(base.root).show(base.revision, shadowKey(base.absolutePath))
      const beforeFile = nodePath.join(tmpdir(), `ys-before-${Date.now()}-${nodePath.basename(base.absolutePath)}`)
      await nodeFs.promises.writeFile(beforeFile, before, 'utf8')
      const now = nodeFs.existsSync(base.absolutePath) ? vscode.Uri.file(base.absolutePath) : vscode.Uri.parse(`untitled:${file} (deleted)`)
      await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(beforeFile), now, `Yellowscript: ${file} since the task`, { preview: true })
    } catch (err) {
      vscode.window.showErrorMessage(`Could not open the diff for ${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** The task summary's Revert: undo the run's writes, newest first. */
  async function revert(run: readonly ToolEffect[]): Promise<void> {
    const steps = revertSteps(run)
    if (steps.length === 0) {
      vscode.window.showInformationMessage('Yellowscript: this task made no checkpointed writes, so there is nothing to revert.')
      return
    }
    const files = [...new Set(steps.flatMap((s) => s.files.map((f) => f.absolutePath)))]
    const choice = await vscode.window.showWarningMessage(
      `Revert this Yellowscript task? ${files.length} file${files.length === 1 ? '' : 's'} go back to how they were before it ` +
        '(files it created are deleted). Later changes to these files are lost too.',
      { modal: true, detail: files.join('\n') },
      'Revert task',
    )
    if (choice !== 'Revert task') return
    try {
      for (const step of steps) {
        await checkpointForWorkspace(step.root).revert(
          { revision: step.revision, label: '' },
          step.files.map((f) => ({ workspaceAbsolute: f.absolutePath, relativePath: shadowKey(f.absolutePath), content: '', wasAbsent: f.wasAbsent })),
        )
      }
      deps.log.info(`revert: undid ${steps.length} write(s) of a task (${files.length} file(s))`)
      vscode.window.showInformationMessage(`Yellowscript: reverted the task (${files.length} file${files.length === 1 ? '' : 's'}).`)
    } catch (err) {
      vscode.window.showErrorMessage(`Could not revert the task: ${err instanceof Error ? err.message : String(err)}`)
      deps.log.error('task revert failed', err)
    }
  }

  return {
    start: (id) => void tasks.set(id, { trusted: false, checkpoints: [] }),
    end: (id) => {
      taskFor(id).trusted = false
    },
    trusted: (id) => taskFor(id).trusted,
    trust: (id) => {
      taskFor(id).trusted = true
    },
    recordCheckpoint: (id, root, checkpoint, files) => {
      lastCheckpoint.set(root, { checkpoint, files })
      taskFor(id).checkpoints.push({ root, checkpoint, files })
      lastTaskConversation = id
    },
    checkpoints: (id) => tasks.get(id)?.checkpoints ?? [],
    revertLastWrite,
    revertLastTask,
    openDiff,
    revert,
    readPlan,
    writePlan,
  }
}
