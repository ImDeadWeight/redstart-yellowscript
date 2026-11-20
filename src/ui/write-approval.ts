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
//   2. SHOW each file's diff on the approval card in the chat, so the user
//      reviews the real change, not a description of it; any file opens as a
//      native diff tab (before on disk vs. the proposed after) from the card.
//   3. ASK on that card: Apply / Reject / Always-allow. Apply writes via the injected
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
import { type ApprovalStore, type TaskTrust, autoApplyReason, rememberApproval } from '../tools/approval.ts'
import type { PendingWrite } from '../tools/types.ts'
import type { WriteOutcome } from '../agent/loop.ts'
import type { AskApproval } from '../chat/approvals.ts'

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
      await fs.promises.mkdir(path.dirname(abs), { recursive: true })
      await fs.promises.writeFile(abs, content, 'utf8')
    },
    async removeFile(abs) {
      await fs.promises.rm(abs, { force: true })
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
  /** "Apply all in this task": offered when present, and honoured until the run ends. */
  task?: TaskTrust
  /** Ask on the conversation's approval card. */
  ask: AskApproval
  /** The workspace root the checkpoints belong to, returned with each one. */
  root?: string
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
    relativePath: shadowKey(c.absolutePath),
    content: c.before,
    wasAbsent: c.isNew,
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

/**
 * A file's key in the shadow repo. Stable per file, so a stored effect finds
 * the file's copy again (the task summary's diff, Revert This Task). The whole
 * absolute path, flattened, so two files with one name (src/a/index.ts and
 * src/b/index.ts) cannot overwrite each other in one checkpoint.
 */
export function shadowKey(absolutePath: string): string {
  return absolutePath.replace(/^[A-Za-z]:/, (d) => d[0]!.toLowerCase()).replace(/[\\/:]+/g, '__')
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
    // Beside the chat when the chat is the active editor tab, so the card
    // with Apply / Reject stays on screen.
    { viewColumn: chatIsActiveEditor() ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, preview: true },
  )
}

function chatIsActiveEditor(): boolean {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
  return input instanceof vscode.TabInputWebview && input.viewType.includes('redstartYellowscript')
}

/**
 * The approval gate handed to the agent loop. Returns true when the change was
 * applied, false when rejected. Never throws for a user "no" — that is a normal
 * outcome the model is told about.
 */
export function makeApprovalGate(deps: ReviewDeps): (pending: PendingWrite) => Promise<WriteOutcome> {
  const backend = deps.backend ?? realWriteBackend
  const applied = (checkpoint: Checkpoint | null): WriteOutcome =>
    checkpoint && deps.root ? { applied: true, checkpoint: { revision: checkpoint.revision, root: deps.root } } : { applied: true }

  return async (pending: PendingWrite): Promise<WriteOutcome> => {
    // Auto-approve path: checkpoint still taken, but no prompt. Never for a
    // deletion (autoApplyReason).
    const toolName = pending.changes[0]?.path ? autoToolFor(pending) : ''
    const deletes = pending.changes.some((c) => c.isDeleted)
    if (autoApplyReason({ toolName, deletes }, deps.store, deps.task?.trusted() ?? false)) {
      const checkpoint = await snapshot(deps, pending)
      await applyPendingWrite(pending, backend)
      return applied(checkpoint)
    }

    // Asked on the chat's card, with each file's diff inline; a file opens as
    // a full diff in the editor from there.
    const decision = await deps.ask({
      kind: 'write',
      title: pending.changes.length > 1 ? `Change ${pending.changes.length} files` : 'Change a file',
      subject: pending.label,
      files: pending.changes.map((c) => ({
        path: c.path,
        change: c.isNew ? 'create' : c.isDeleted ? 'delete' : 'edit',
        diff: c.diff,
      })),
      options: [
        { id: 'apply', label: 'Apply', kind: 'allow' },
        // Offered only when the host scopes a task; deletions still always ask.
        ...(deps.task ? [{ id: 'task', label: 'Apply all in this task', kind: 'always' as const }] : []),
        ...(deletes ? [] : [{ id: 'always', label: 'Always allow edits', kind: 'always' as const }]),
        { id: 'reject', label: 'Reject', kind: 'deny' },
      ],
      openFile: (index) => {
        const change = pending.changes[index]
        if (change) void showDiff(change)
      },
    })

    if (decision === 'reject') {
      return { applied: false }
    }

    // Checkpoint the PRE-WRITE state, then apply. Order matters (see file head).
    const checkpoint = await snapshot(deps, pending)
    const outcome = await applyPendingWrite(pending, backend)

    if (decision === 'task') deps.task?.trust()

    if (decision === 'always') {
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
    return applied(checkpoint)
  }
}

/** Best-effort recovery of the originating tool name for "always allow". */
function autoToolFor(pending: PendingWrite): string {
  // The tool name is not carried on the change; this is a placeholder so the
  // "always allow" memory keys on a stable id. ys_edit_file vs ys_write_file is
  // indistinguishable from the planned change alone, so we key on the change
  // shape: a full-file replacement of an existing file is ys_write_file, a
  // context diff is ys_edit_file. Both being remembered together is acceptable.
  return pending.changes.some((c) => !c.isNew && !c.isDeleted && c.before === '') ? 'ys_write_file' : 'ys_edit_file'
}
