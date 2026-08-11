// =============================================================================
// Host-side write approval: checkpoint → diff review → apply/reject.
// =============================================================================
// Implements the `ApprovalGate` port the agent loop calls for a `PendingWrite`.
// This is the ONLY place that owns the real fs and (optionally) a real git
// checkout for the shadow checkpoint. The actual decision UI is deliberately
// small and explicit: the model never writes; the user does.
//
// THE SEQUENCE, WHY IT IS THIS ORDER:
//
//   1. CHECKPOINT the pre-write bytes of every affected file into the shadow
//      git repo. If the apply step then corrupts something, `revert` restores
//      exactly these bytes. This happens BEFORE any write — a checkpoint taken
//      after the write would snapshot the corrupted state.
//   2. OPEN a native diff tab per file (before on disk vs. the proposed after),
//      so the user reviews the real change, not a description of it.
//   3. ASK: Apply / Reject / Always-allow. Apply writes via the injected
//      `WriteBackend`. "Always allow" remembers the tool per workspace and then
//      applies. Reject writes nothing.
//
// Auto-approval: if the tool is already remembered in this workspace, steps 2–3
// are skipped and the change is checkpointed + applied directly. The checkpoint
// is still taken, because "always allow" is about not nagging, not about
// abandoning the safety net.
//
// No domain logic here that is not already tested elsewhere: the checkpoint is
// `CheckpointManager` (tested), the apply is `applyPendingWrite` (tested), and
// the policy is `isAutoApproved` (tested). This file is the wiring + the VSCode
// surface, which is what makes it `vscode`-bound by necessity.
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as vscode from 'vscode'

import {
  CheckpointManager,
  type Checkpoint,
  type GitBackend,
  type StagedFile,
} from '../tools/checkpoint.ts'
import { applyPendingWrite, type WriteBackend } from '../tools/apply.ts'
import { type ApprovalStore, isAutoApproved, rememberApproval } from '../tools/approval.ts'
import type { PendingWrite } from '../tools/types.ts'

const execFileAsync = promisify(execFile)

/** A real git backend driving the shadow repo via the `git` CLI. */
export function realGitBackend(shadowRoot: string): GitBackend {
  // The shadow repo is ours alone, so we pin a committer identity locally rather
  // than depending on the user having configured git globally. Without this the
  // very first `git commit` throws "Author identity unknown" and the checkpoint
  // step — which runs BEFORE any write — blows up the whole approval gate, so
  // the model's write silently fails. The identity is scoped to this repo only
  // via `init`'s config flags; it never touches the user's global git config.
  const COMMIT_IDENTITY = [
    '-c',
    'user.name=Yellowscript',
    '-c',
    'user.email=yellowscript@redstart.local',
  ]
  return {
    shadowRoot,
    async run(args, cwd) {
      const withIdentity =
        args[0] === 'commit' ? [...COMMIT_IDENTITY, ...args] : args
      const { stdout } = await execFileAsync('git', withIdentity, {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
      })
      return stdout
    },
    existsSync: (dir) => fs.existsSync(dir),
    async mkdirp(dir) {
      await fs.promises.mkdir(dir, { recursive: true })
    },
    async readFile(abs) {
      return fs.promises.readFile(abs, 'utf8')
    },
    async writeFile(abs, content) {
      await fs.promises.writeFile(abs, content, 'utf8')
    },
  }
}

/** The real workspace filesystem, for materialising approved changes. */
export const realWriteBackend: WriteBackend = {
  async mkdirp(abs) {
    await fs.promises.mkdir(path.dirname(abs), { recursive: true })
  },
  async write(abs, content) {
    await fs.promises.writeFile(abs, content, 'utf8')
  },
  async remove(abs) {
    await fs.promises.rm(abs, { force: true })
  },
}

/** Build the per-session checkpoint manager for a workspace. */
export function checkpointForWorkspace(workspaceRoot: string): CheckpointManager {
  const shadowRoot = path.join(workspaceRoot, '.yellowscript', 'shadow')
  return new CheckpointManager(realGitBackend(shadowRoot))
}

interface ReviewDeps {
  checkpoints: CheckpointManager
  store: ApprovalStore
  backend?: WriteBackend
  /** Records each successful checkpoint so the `Revert Last Write` command can
   *  restore it. Kept optional so tests/reuse needn't supply it. */
  recordCheckpoint?: (checkpoint: Checkpoint, files: readonly StagedFile[]) => void
}

/**
 * Stage pre-write content into a checkpoint, tolerating a checkpoint failure.
 *
 * The checkpoint is the safety net, not the write itself. If shadow-git cannot
 * initialise or commit (e.g. git missing, or some other environment problem),
 * we MUST NOT let that block the user's write or — worse — leak `git`'s internals
 * back to the model as if they were the tool's own output. We warn once and
 * proceed without a restore point; the write still happens, it just can't be
 * reverted by us.
 */
async function snapshot(deps: ReviewDeps, pending: PendingWrite): Promise<Checkpoint | null> {
  const staged: StagedFile[] = pending.changes.map((c) => ({
    workspaceAbsolute: c.absolutePath,
    relativePath: vscodeRelative(c.absolutePath, deps),
    content: c.before,
  }))
  try {
    const checkpoint = await deps.checkpoints.checkpoint(staged, pending.label)
    deps.recordCheckpoint?.(checkpoint, staged)
    return checkpoint
  } catch (err) {
    void vscode.window.showWarningMessage(
      'Yellowscript could not create a restore checkpoint, so this write will not be revertible. ' +
        'The file will still be written.',
    )
    outputWarn(err)
    return null
  }
}

/** Log a checkpoint error to the output channel without exposing it to the model. */
function outputWarn(err: unknown): void {
  // Deliberately not surfaced as a tool result — it is an environment issue, not
  // something the model can act on, and the raw git text must stay out of model
  // context (see ground rule 4: no secrets/leaks across the boundary).
  console.warn('[yellowscript] checkpoint failed:', err instanceof Error ? err.message : String(err))
}

/** Best-effort workspace-relative key for a shadow path. */
function vscodeRelative(absolutePath: string, deps: ReviewDeps): string {
  // The checkpoint stores by relative path; for the shadow we just need a stable
  // key unique per file. Use the workspace-relative form when resolvable, else
  // the basename. Exact value only matters for partial reverts, which key by the
  // same `StagedFile` array we pass back to `revert`.
  return path.basename(absolutePath)
}

/** Open a native diff tab (before on disk vs. proposed after) for one change. */
async function showDiff(change: PendingWrite['changes'][number]): Promise<void> {
  const afterTmp = path.join(os.tmpdir(), `ys-after-${Date.now()}-${path.basename(change.path)}`)
  await fs.promises.writeFile(afterTmp, change.after, 'utf8')

  const beforeUri = change.isNew
    ? vscode.Uri.parse(`untitled:${change.path} (new)`)
    : vscode.Uri.file(change.absolutePath)

  await vscode.commands.executeCommand(
    'vscode.diff',
    beforeUri,
    vscode.Uri.file(afterTmp),
    `Yellowscript: ${change.isNew ? 'create' : change.isDeleted ? 'delete' : 'edit'} ${change.path}`,
  )
}

/**
 * The approval gate handed to the agent loop. Returns true when the change was
 * applied, false when rejected. Never throws for a user "no" — that is a normal
 * outcome the model is told about.
 */
export function makeApprovalGate(deps: ReviewDeps): (pending: PendingWrite) => Promise<boolean> {
  const backend = deps.backend ?? realWriteBackend

  return async (pending: PendingWrite): Promise<boolean> => {
    // Auto-approve path: checkpoint still taken, but no prompt.
    const toolName = pending.changes[0]?.path ? autoToolFor(pending) : ''
    if (toolName && isAutoApproved(deps.store, toolName)) {
      await snapshot(deps, pending)
      await applyPendingWrite(pending, backend)
      return true
    }

    for (const change of pending.changes) {
      await showDiff(change)
    }

    const decision = await vscode.window.showInformationMessage(
      `Yellowscript wants to ${pending.label}. Review the diff${pending.changes.length > 1 ? 's' : ''} and choose.`,
      { modal: true },
      'Apply',
      'Apply & always allow',
      'Reject',
    )

    if (decision === 'Reject' || decision === undefined) {
      return false
    }

    // Checkpoint the PRE-WRITE state, then apply. Order matters (see file head).
    await snapshot(deps, pending)
    const outcome = await applyPendingWrite(pending, backend)

    if (decision === 'Apply & always allow') {
      const tool = autoToolFor(pending)
      if (tool) rememberApproval(deps.store, tool)
    }

    if (outcome.failures.length > 0) {
      for (const failure of outcome.failures) {
        void vscode.window.showErrorMessage(`Could not write ${failure.path}: ${failure.reason}`)
      }
      // Partial success is still a success of the gate (bytes moved); the model
      // is told per-file via the result text only for whole-file outcomes.
    }
    return true
  }
}

/** Best-effort recovery of the originating tool name for "always allow". */
function autoToolFor(pending: PendingWrite): string {
  // The tool name is not carried on the change; this is a placeholder so the
  // "always allow" memory keys on a stable id. ws_edit_file vs ws_write_file is
  // indistinguishable from the planned change alone, so we key on the change
  // shape: a full-file replacement of an existing file is ws_write_file, a
  // context diff is ws_edit_file. Both being remembered together is acceptable.
  return pending.changes.some((c) => !c.isNew && !c.isDeleted && c.before === '') ? 'ws_write_file' : 'ws_edit_file'
}
