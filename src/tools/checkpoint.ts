// =============================================================================
// Shadow-git checkpoints — the one place a Phase 3 bug destroys user work, so
// the snapshot strategy is designed deliberately, not bolted on.
// =============================================================================
// HANDOFF 3.3: "the one place a bug destroys user work; get the snapshot
// strategy right deliberately." The chosen strategy (decided with the user) is a
// REAL shadow git repository: an actual `.git` in a hidden directory that
// mirrors the workspace, into which we commit the pre-write state of every file
// a batch is about to touch. Revert = `git checkout` of that shadow commit.
//
// WHY A REAL GIT REPO RATHER THAN FILE COPIES:
//
// 1. A copy-snapshot of N files before every batch is O(files) disk traffic on
//    every write, and a partial revert (restore three of five files) means
//    re-copying by hand. Git stores content-addressed blobs; an unchanged file
//    costs nothing to commit again, and a partial revert is `git checkout <rev>
//    -- a b c`. It does the thing we need and is the thing that already does it.
//
// 2. The shadow repo is SEPARATE from any real git the workspace might be. We
//    never touch the user's `.git`. The shadow lives at a configurable path
//    (default `<workspace>/.yellowscript/shadow`) and is initialised by us;
//    if the workspace is itself a git checkout, our commits go to OUR repo, and
//    `git status` in the workspace shows nothing we did.
//
// 3. Containment is the caller's job. This module sees ABSOLUTE paths only and
//    is told, per file, its path RELATIVE TO THE SHADOW. The tool layer resolves
//    through the workspace guard first; nothing here can name a path outside the
//    workspace, because the caller never hands it one.
//
// BACKENDS ARE INJECTED. `git` and `fs` are passed in so the whole engine is
// unit-testable with a scripted child_process and an in-memory filesystem —
// which is exactly where a "revert destroyed the file" bug would live, and the
// place we most need to prove correct without an extension host.
//
// No `vscode` import. No direct `child_process` or `fs` import either — both
// come through the injected `GitBackend` so tests can fake them.
// =============================================================================

import * as path from 'node:path'

/** A git we drive, isolated from the user's own repo. */
export interface GitBackend {
  /** Run a git command in `cwd` and return stdout, throwing on non-zero exit. */
  run(args: readonly string[], cwd: string): Promise<string>
  /** True when `dir` already exists and is a usable directory. */
  existsSync(dir: string): boolean
  /** Create `dir` (and parents) if missing. */
  mkdirp(dir: string): Promise<void>
  /** Read a file's content. */
  readFile(absolutePath: string): Promise<string>
  /** Write a file's content (used to stage content into the shadow working tree). */
  writeFile(absolutePath: string, content: string): Promise<void>
  /** Absolute path of the shadow root. */
  shadowRoot: string
}

/** Identifies a checkpoint the user can revert to. */
export interface Checkpoint {
  /** The git revision (commit hash) the shadow repo was at. */
  revision: string
  /** A short, human label, e.g. "before edit (3 files)". */
  label: string
}

export class CheckpointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CheckpointError'
  }
}

/** One file staged into a checkpoint, with its pre-write content. */
export interface StagedFile {
  /** Absolute path in the REAL workspace. */
  workspaceAbsolute: string
  /** Path relative to the workspace root (the shadow key). */
  relativePath: string
  /** The content to snapshot (current on-disk state, before the write). */
  content: string
}

export class CheckpointManager {
  private readonly git: GitBackend
  private initialised = false

  constructor(git: GitBackend) {
    this.git = git
  }

  /** The shadow's absolute root. */
  get root(): string {
    return this.git.shadowRoot
  }

  /**
   * Ensure the shadow repo exists and is on a clean main branch.
   *
   * Idempotent: a second call (e.g. after a restart) re-attaches to the existing
   * shadow rather than re-initialising and losing history. The user's real
   * workspace `.git` is never touched — we only ever init OUR shadowRoot.
   */
  async ensure(): Promise<void> {
    if (!this.git.existsSync(this.git.shadowRoot)) {
      await this.git.mkdirp(this.git.shadowRoot)
    }
    // A `.git` inside the shadow root marks it as OUR repo. If absent, init.
    if (!this.git.existsSync(path.join(this.git.shadowRoot, '.git'))) {
      await this.git.run(['init', '--quiet', '-b', 'yellowscript'], this.git.shadowRoot)
      // A repo with no commits cannot have its files checked out by revision; a
      // first commit gives every later revert a base to restore against.
      await this.git.run(['commit', '--allow-empty', '-m', 'yellowscript shadow init'], this.git.shadowRoot)
    }
    this.initialised = true
  }

  /**
   * Snapshot `files` into the shadow repo and commit. Returns the revision.
   *
   * The files are written into the shadow's mirrored tree (shadowRoot +
   * relativePath) and `git add`ed, then committed. Only files we are ABOUT to
   * write are staged — the rest of the tree is whatever it was, so a revert of
   * this checkpoint restores exactly the pre-write bytes of these files and
   * leaves untouched files untouched.
   *
   * Called BEFORE the approved change is applied to disk. The commit is the
   * recoverable point; if the apply step then corrupts the real file, `revert`
   * restores the shadow's copy of the pre-write content.
   */
  async checkpoint(files: readonly StagedFile[], label: string): Promise<Checkpoint> {
    if (!this.initialised) await this.ensure()

    for (const file of files) {
      const target = path.join(this.git.shadowRoot, file.relativePath)
      // Stage into the mirrored path so the shadow's tree matches the workspace
      // layout. mkdirp is safe: it only ever creates inside shadowRoot, because
      // the caller resolved relativePath through the workspace guard.
      await this.git.mkdirp(path.dirname(target))
      await this.git.writeFile(target, file.content)
    }

    if (files.length > 0) {
      await this.git.run(['add', '--', ...files.map((f) => f.relativePath)], this.git.shadowRoot)
    }

    const message = `${label} (${files.length} file${files.length === 1 ? '' : 's'})`
    await this.git.run(['commit', '--allow-empty', '-q', '-m', message], this.git.shadowRoot)

    const revision = (await this.git.run(['rev-parse', 'HEAD'], this.git.shadowRoot)).trim()
    return { revision, label: message }
  }

  /**
   * Restore the workspace files to their pre-write content from `checkpoint`.
   *
   * Reads the file's blob out of the shadow at that revision and writes it back
   * to the REAL workspace path. We restore from the shadow's own history rather
   * than `git checkout`-ing the workspace, because the workspace is not a git
   * repo we control and may not be one at all. Reading the blob keeps the
   * shadow's working tree clean and makes a partial revert (some files) trivial.
   */
  async revert(checkpoint: Checkpoint, files: readonly StagedFile[]): Promise<void> {
    for (const file of files) {
      const blob = await this.git.run(
        ['show', `${checkpoint.revision}:${file.relativePath}`],
        this.git.shadowRoot,
      )
      await this.git.writeFile(file.workspaceAbsolute, blob)
    }
  }
}
