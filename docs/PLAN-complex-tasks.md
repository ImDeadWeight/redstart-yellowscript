# Plan: complex coding tasks

*As of 2026-11-19. Items 11–13 merged in PR #2. Items 1–10 and Tier 2 are on
`feat/context-budget`, waiting for the testing suite (item 14) before merge.*

**Goal.** Yellowscript, driving a local model on the Nest, can build a real
multi-file project end to end: an original single-screen barrel-dodging
platformer (canvas, own characters and art), and the Redstart website. Both
need roughly 50–150 tool calls across several sessions, a running dev server,
and a way to check the result.

**Target model.** Qwen3.6-35B-A3B (Q3/Q4) on llama.cpp, ~32k context. Every
budget below is sized for that; a larger window relaxes them but changes none.

---

## Status

| # | Item | State |
|---|---|---|
| 1 | Context budget | Done (`feat/context-budget`). Summarising very long histories is open |
| 2 | Long runs: turn cap and repeat check | Done |
| 3 | A plan that survives sessions | Done |
| 4 | Approval friction | Done: task trust for writes, allowlist for commands |
| 5 | Reliable command runner | Done |
| 6 | Background processes | Done |
| 7 | Search-and-replace edit, file ops | Done |
| 8 | Diagnostics after each write | Done |
| 9 | Check the running page | Done |
| 10 | `AGENTS.md` and a workspace overview | Done |
| 11 | `ask_user` | Done (PR #1, #2); tabbed card on this branch |
| 12 | Shared agent-core loop | Done (PR #1, #2) |
| 13 | `ys_` tool prefix | Done (PR #2) |
| T2 | `call_tool` in the approval gate | Done |
| 14 | Testing suite / coding benchmark | **Built** (`npm run live`, `npm run bench`); first live run is the gate for merging |
| 15 | Milestone ladder | After 14 |

Every item has unit tests; `npm run check` passes 568/568. None of it has run
against a live Nest yet — that is what item 14 is for.

---

## What the branch changed

**1 — Context budget** (`src/agent/context-budget.ts`). `n_ctx` comes from
llama-server's `/props` through the gateway, or from the first
`exceed_context_size_error`. The gateway's overhead is learned from each
reply's `prompt_n + cache_n`. Before each request of a run, past 85% of the
usable window, old tool results become a stub naming the tool and old calls
lose their long string arguments (valid JSON kept), oldest first, down to 50%.
One message over 40% is cut to head and tail. User messages and the newest 4
are never stubbed; images count ~1,000 tokens. Edits are in place, so the
prefix and the prompt cache stay stable. A refusal anyway: trim harder, retry
once.

**2 — Long runs.** 40 turns by default (`agent.maxTurns`); Continue grants as
many again. A call identical to three earlier ones in the run is not run.

**3 — The plan on disk.** `.yellowscript/PLAN.md`, a task list
(`[ ] [~] [x] [-]`, notes indented). Written on every plan change, removed when
the plan is cleared; a new conversation starts with it while a step is open.

**4 — Approval friction.** Writes: "Apply all in this task" lasts until the
run ends; "Revert Last Task" undoes every write of the last task, newest first.
A deletion always asks. Commands: `allowedCommands` prefixes run without
asking; "Always allow" offers the narrowest useful prefix (`npm run build`,
an interpreter's exact line). A line that chains, pipes, redirects,
substitutes or has a second line never matches.

**5 — Command runner** (`src/tools/process-runner.ts`). `child_process` with
the user's shell. "Exit code N · 2.4s" first, then stdout and stderr, each kept
to head and tail. `timeout_s` (120 default, 900 max) stops the whole tree.
Output streams into the "Yellowscript Commands" channel.

**6 — Background processes.** `ys_process_start` (approved like a command),
`ys_process_output` (new output since the last read, `wait_s`),
`ys_process_stop`. At most four; all stop with the window.

**7 — Edits.** `ys_replace` (exact text, unique unless `replace_all`, line
endings matched, `$` literal), `ys_delete_file`, `ys_move_file`, all through
the same review and checkpoint.

**8 — Diagnostics after writes.** Each written file is opened as a document so
the language server reports on it; the result gets its errors and warnings
(at most 15) within 2.5s.

**9 — `ys_check_page`** (`src/tools/browser-check.ts`). The machine's
Edge/Chrome/Chromium, headless, over the DevTools protocol with Node's
WebSocket: no dependency. Reports exceptions, console errors and warnings,
failed requests, title, canvases and visible text. Loopback URLs and workspace
files only. The screenshot is saved to `.yellowscript/screenshots/` and sent
as an image part only when `/props` says the model reads images.

**10 — Workspace context.** Requests with tools start with a system message:
the workspace, its `AGENTS.md` (or `CLAUDE.md`, 6,000 characters at most), and
a two-level file tree (120 entries at most).

**Tier 2.** `call_tool` prompts, grants and denies now name the inner tool.
Several `ask_user` questions are one card with a tab each.

**Fixes found on the way:** a delete could ride an edit tool's "always allow";
reverting a created file left it empty; the shadow keyed files by basename;
the command allowlist collapsed a newline into a space before checking for a
second command.

---

## 14 — The testing suite (built; not yet run live)

What exists: `npm run live` (layer 1) and `npm run bench` (layer 2), with 8
tasks in `bench/tasks/` (7 core, 1 milestone), each with a reference solution
that `npm test` uses to prove the check is honest. Results are logged in
[docs/bench-results.md](bench-results.md). The design it was built to:

Two layers, both runnable from `npm`:

1. **A live smoke pass** against the real Nest, scripted the way
   `npm run smoke` is: `/props` gives `n_ctx`; a 30-read run on a 32k model
   finishes without a context error (the item 1 "done when"); a background
   dev server starts, answers, and stops.
2. **A coding benchmark**, the equivalent of Nest's `scripts/agent-bench`:
   tasks in copies of `sample-workspace`, run headless against a real Nest,
   scored by a check script per task.
   - make failing tests pass; add a feature across 3+ files; fix a broken
     build; build a canvas game to a spec and pass `ys_check_page`.
   - Record per model: pass rate, tool-call success, calls recovered from
     text, turns per task, runs that hit a limit or a context trim.

The benchmark needs the loop to run outside VS Code. Everything it calls is
already `vscode`-free except the approval gates and diagnostics, which the
bench would supply as an auto-approve policy and `tsc` output.

## 15 — Milestone ladder

Each must pass before the next:
1. Canvas Pong in one file.
2. A single-screen platformer: player, ladders, rolling hazards, score.
3. The full original game: several levels, art, sound, title screen.
4. The Redstart website, from its existing content.

## Still open

- **Summarising long histories.** Across turns only user and assistant text is
  sent, so history grows slowly; a very long conversation is never summarised.
  Drive `compaction.mjs`'s summariser once a real conversation hits it.
- **Re-sync agent-core on every Nest release:** `node scripts/sync-agent-core.mjs
  E:/redstart-project origin/main`, then `npm run check`.
- Where does the Redstart website live, and what stack does it use?

## Housekeeping

- A stale stash holds the first rename attempt, made before PR #1:
  `ys_ rename on pre-PR1 base (stale)`. Superseded; drop it.
- redstart-project's `claude/yellowscript-ide-improvements-z2auqo` can be
  deleted: its mascot and icon script now live here (`npm run icons`).
- redstart-project's notes still say `ws_run_command`
  (`agent-runtime-plan.md`, `agent-runtime-implementation.md`).
