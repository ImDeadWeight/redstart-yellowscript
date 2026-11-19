# Plan: complex coding tasks

*As of 2026-11-19. Branch `feat/ys-prefix-and-core-resync`.*

**Goal.** Yellowscript, driving a local model on the Nest, can build a real
multi-file project end to end: an original single-screen barrel-dodging
platformer (canvas, own characters and art), and the Redstart website. Both
need roughly 50–150 tool calls across several sessions, a running dev server,
and a way to check the result. Today the agent is built for exchanges of about
ten calls.

**Target model.** Qwen3.6-35B-A3B (Q3/Q4) on llama.cpp, ~32k context. Every
budget below is sized for that; a larger window relaxes them but changes none.

---

## Status

| # | Item | State |
|---|---|---|
| 12 | Run the shared agent-core loop | **Done.** PR #1 vendored it; this branch re-syncs to Nest `4a2b8b5` (alpha.16) |
| 13 | `ys_` tool prefix | **Done** on this branch |
| 1 | Context budget and compaction | Not started (module vendored, not called) |
| 2 | Long runs: turn cap and loop detection | Partly: Continue at the limit exists; cap still 10 |
| 3 | A plan that survives sessions | Partly: `update_plan` checklist exists, not on disk |
| 4 | Approval friction | Not started |
| 5 | Reliable command runner | Not started |
| 6 | Background processes | Not started |
| 7 | Search-and-replace edit, file ops | Not started |
| 8 | Diagnostics after each write | Not started |
| 9 | Check the running page | Not started |
| 10 | `AGENTS.md` and a workspace overview | Not started (a linked Nest project already adds its instructions) |
| 11 | `ask_user` | **Done** (PR #1); several questions per call on this branch |
| 14 | Coding benchmark | Not started |
| 15 | Milestone ladder | Not started |

---

## Done on this branch

**Item 12 — finishing the agent-core move.**
- Re-synced `src/vendor/agent-core` from Nest `main` (`4a2b8b5`). Upstream had
  moved 8 files since the pin (`e1e44b7`), and added `host-tools.mjs`.
- `ask_user` now carries 1–4 questions. The card still shows one at a time:
  `ChatSession.ask` asks them in turn and returns `answers[]` (null where
  skipped). A message typed instead of using the card answers all of them, as
  agent-core expects. Tests cover both.
- `.gitattributes` pins `src/vendor/agent-core/**` to LF. With
  `core.autocrlf=true` every vendored file was checked out CRLF and
  `npm run check` failed its own hash check on a clean `main`.

**Item 13 — `ws_` → `ys_`.**
- Every local tool now uses Nest's reserved Yellowscript prefix
  (redstart-project `docs/tool-namespacing.md`, enforced by
  `test-tool-namespacing.mjs`). Admin tool bans can now target Yellowscript.
- Saved "always allow" settings are migrated on read (`migrateToolNames`).
- A `ws_*` call replayed from an old transcript runs the `ys_*` tool.

`npm run check`: 497/497 pass. `npm run build`: clean.

---

## Tier 0 — the loop must sustain a long task

**1. Context budget and compaction.** The biggest blocker. One result can be
20,000 characters (`MAX_RESULT_CHARS`), about 5k tokens, and nothing trims the
history, so five file reads fill a 32k window.
- Read `n_ctx` from the Nest (`/props` or the models list); do not assume it.
- Count the gateway's injected system prompt and the tool definitions in the
  budget (Nest learned this the hard way: `context-budget-implementation.md`).
- Drive the vendored `compaction.mjs`: first shrink old tool results to a
  one-line stub, then summarise at 85% of the window.
- Done when: a 30-read run on a 32k model finishes without a context error.

**2. Long runs.** `DEFAULT_MAX_ITERATIONS = 10` is per flow, and Continue
resets it.
- Raise the default to 40 and make it a setting.
- Detect loops instead of relying on the cap: the same call with the same
  arguments three times stops the flow with a note to the model.

**3. A plan that survives.** Mirror the `update_plan` checklist into
`.yellowscript/PLAN.md` and load it into a new conversation in the same
workspace. State on disk is what lets a local model work across sessions.

**4. Approval friction.** A 40-file build is 40 diff reviews today.
- "Trust this task": auto-apply writes for the rest of the flow, one
  checkpoint per turn, and a *Revert turn* command.
- Per-workspace allowlist of command prefixes (`npm test`, `npm run build`,
  `npx tsc --noEmit`). Commands stay always-ask by default.

## Tier 1 — tools these projects need

**5. Command runner.** `ys_run_command` uses terminal shell integration and
falls back to `sendText`, which captures no output.
- Run through `child_process`, inside the workspace.
- Result shape from Nest's D15: exit code on the first line, stdout and stderr
  each capped keeping head and tail, duration, and a timeout.

**6. Background processes.** `ys_process_start`, `ys_process_output`,
`ys_process_stop`, so `npm run dev` stays up while the model works. Killed when
the conversation ends or the window closes.

**7. Edits a quantized model can make.** `ys_edit_file` needs a unified diff
that matches exactly. Add `ys_replace` (`old_string` → `new_string`, must be
unique). Add `ys_delete_file`, `ys_move_file` and directory creation for
scaffolding, all through the existing checkpoint.

**8. Feedback after writes.** Append the diagnostics for each written file to
the write result, so errors arrive without another call.

**9. Check the running page.** A headless-browser tool (Playwright) that loads
a URL and returns console errors and a short DOM summary, plus a screenshot
when the model can read images. Open question below.

**10. Project instructions.** Load `AGENTS.md` (then `CLAUDE.md`) from the
workspace root into the system prompt, plus a short file-tree overview. Nest's
master plan imports and exports `AGENTS.md` for projects, so keep the format.

## Tier 2 — alignment with Nest

- **`call_tool` in the approval gate.** agent-core added `callToolTarget`
  (Nest's catalog dispatcher). Yellowscript's `nest/approval.ts` judges a
  `call_tool` by its own name, so a write inside it is not prompted here. Nest
  still enforces approval on its side, so this fails as "not done", not as an
  unapproved write. Unwrap it before deciding.
- **Several-question card.** Show all of an `ask_user` call's questions at
  once, as tabs (Nest's D44), instead of in turn.
- **Re-sync agent-core on every Nest release.** `node scripts/sync-agent-core.mjs
  E:/redstart-project origin/main`, then `npm run check`.

## Tier 3 — measuring progress

**14. Coding benchmark.** The equivalent of Nest's `scripts/agent-bench`, run
headless against a real Nest using `sample-workspace` copies:
- make failing tests pass; add a feature across 3+ files; fix a broken build;
  build a canvas game to a spec and pass its smoke test.
- Record per model: pass rate, tool-call success, calls recovered from text,
  turns per task, runs that hit a limit.

**15. Milestone ladder.** Each must pass before the next:
1. Canvas Pong in one file.
2. A single-screen platformer: player, ladders, rolling hazards, score.
3. The full original game: several levels, art, sound, title screen.
4. The Redstart website, from its existing content.

---

## Order of work

1. Items 1 and 2 (the agent can run long).
2. Items 5, 7 and 8 (it can act and see its errors).
3. Item 14, a first benchmark row, before tuning anything else.
4. Items 3, 4, 6 and 10.
5. Item 9, then the milestones.

## Open questions

- Can the Nest's model read images? That decides whether item 9 returns
  screenshots or only console and DOM text.
- What is the real `n_ctx` on the Nest profile used for coding?
- Where does the Redstart website live, and what stack does it use?

## Housekeeping

- A stale stash holds the first rename attempt, made before PR #1:
  `ys_ rename on pre-PR1 base (stale)`. Superseded; drop it.
- The mascot now lives here: `assets/mascot/redstart-yellowscript.txt`,
  `scripts/mascot.mjs` and `scripts/make-icons.mjs` (`npm run icons`), copied
  from redstart-project commit 43c0f52. It regenerates `media/` byte for byte.
  That branch in redstart-project (`claude/yellowscript-ide-improvements-z2auqo`)
  can be deleted once this merges.
- redstart-project's notes still say `ws_run_command`
  (`agent-runtime-plan.md`, `agent-runtime-implementation.md`).
