# Plan: agent runtime after the first benchmark

*As of 2026-11-24. Follows [PLAN-refactor.md](PLAN-refactor.md): item 1 here
needs refactor item 1h (one shared agent setup for the product and the
benchmark). The UI notes from the same testing round (turns in order,
command cards, context meter, attach button, the wait note) are in
[PR #6](https://github.com/ImDeadWeight/redstart-yellowscript/pull/6). That PR
also fixed made-up tool-call ids repeating across rounds; item 3 builds on
it.*

**What prompted it.** In the first benchmark round, Ornith 1.5 got stuck in a
reasoning loop: one response repeating itself until the length limit. Across
rounds, models also retried the same failing approach with small variations.
The only guard today blocks calls that are exactly identical
(`MAX_IDENTICAL_CALLS` in `agent/loop.ts`).

**The evidence.** "Crestline" is our own test prompt, not an outside
benchmark or standard: build a commercial cleaning quote estimator for a
made-up company, "Crestline Facility Care", in SvelteKit with Svelte 5 runes,
Vitest tests, and `check`, `vitest run` and `build` all passing. It was run by
hand in Yellowscript, signed in as the `bench` account, in
`sample-workspace/`: chat `conv_1795539588063_468eh9`, kept in that
workspace's VS Code storage (`state.vscdb`, key
`redstart.redstart-yellowscript`), not in Nest. Two assistant turns, both
stopped by hand. They show two different failures:

| Turn | Reasoning | Tool calls (failed) | Repeated sentences | What went wrong |
|---|---|---|---|---|
| 1 | 115k characters | 57 (11) | 2.5% | **Theorizing.** Little exact repetition, but "Actually, let me reconsider" 19 times, and `npx sv add vitest` failed 4 times with 4 different sets of flags. Ended in a chain of "let me look at how svelte-check resolves runes mode". |
| 2 | 152k characters | 25 (8) | **44.9%** | **A loop inside one response.** The same five-sentence cycle ("The greet.spec.ts is a sample file. / The JSON output failed due to Windows path issues. / Let me try a different approach… / Actually the default reporter already showed the error. / Let me look more carefully…") about 59 times. |

Between the turns the person stepped in: *"Stop theorizing… Use an
evidence-driven debugging process: 1. Inspect the exact declarations… 2. Check
whether the affected variables are declared with `const` or `let`…"*. That is
the intervention item 4 automates.

None of this tripped the existing guard, because no two calls were identical.

**Where the work lands.** The agent runtime shared with Nest is
`redstart-project/shared/agent-core`, vendored here by
`scripts/sync-agent-core.mjs`. "Address it outside Yellowscript too" means
the detectors belong upstream. Yellowscript's `loop.ts` wires them in and
draws them.

---

## Status

| # | Item | Priority | Where | State |
|---|---|---|---|---|
| 0 | Re-sync agent-core | — | Yellowscript | **Done** 2026-11-24: synced from redstart-project `feat/stagnation` (not yet merged upstream). `teaching.mjs` now answers unknown tool names in the registry. |
| 1 | Benchmark runs what ships; real diagnostics | P1 | Yellowscript bench | **Built**: the harness runs `composeSession`; diagnostics from `bench/headless-diagnostics.ts`; task `diagnostics-only` with `--no-diagnostics` for the comparison. Not yet run live. |
| 2 | Crestline (SvelteKit) task | P1 | Yellowscript bench | **Built**: `bench/tasks/crestline`, offline through `npm run bench:cache`. Its reference solution has not been run (the cache was not built here). Not yet run live. |
| 3 | Stagnation detection and recovery | **P0** | agent-core, then Yellowscript | **Done** in code: `stagnation.mjs` upstream, wired in `agent/loop.ts`, shown in the timeline and the run log. The fixture thresholds pass. Before/after run (`--no-stagnation`) not yet done. |
| 4 | Triggered debugging instructions | P2 | agent-core | **Done**: `DEBUGGING_PROCEDURE` in `stagnation.mjs`, the text of recovery step 1 |
| 5 | Tool catalog evaluation | P1 | Yellowscript bench | **Built**: `--catalog full,core,core+nest`, wrong-tool calls and tool-list tokens in each record, a table in `docs/bench-results.md`. Not yet run. |
| 6 | Working-state compaction | P2 | agent-core, then Yellowscript | **Done**: `working-state.mjs` upstream; Yellowscript sends it at the tail once results are trimmed. Decision: Yellowscript keeps `context-budget.ts` for the in-run trim, on compaction.mjs's thresholds (see item 6). |

**Order.** 0 → (3d, if Ornith stalls in daily use) → 1 → 2 → 3 with 4 → 5 → 6.
All of it was built together on 2026-11-24; what is left is the live runs:
`npm run bench:cache`, then Crestline with and without the stagnation checks,
`diagnostics-only` with and without diagnostics, and the catalog matrix.
"Measure before you fix": 1 and 2 exist so that the stall can be reproduced
on demand and 3 can be scored, not judged by eye.

---

## 0 — Re-sync agent-core

Run `npm run sync:agent-core` against upstream `main` and fix what the newer
core changes. Everything below builds on the current upstream, so do it before
changing anything else.

## 1 — The benchmark runs what ships (diagnostic parity)

- The harness builds its agent with `agent/compose.ts` (refactor 1h), the
  same setup as the product.
- **Headless diagnostics:**
  - `.ts` and `.js` files: a TypeScript language service over the workspace's
    `tsconfig`. This extends the bench's existing `ts-symbols.ts` provider.
  - `.svelte` files, which TypeScript cannot see: run
    `svelte-check --output machine` when the workspace depends on Svelte, and
    parse its output.
- Diagnostics after each write are turned on in the benchmark, as they are in
  the product.
- **Test:** a task whose fix is only visible through diagnostics, run with and
  without the provider.

## 2 — Crestline: a SvelteKit task

Turns the hand-run Crestline prompt (see "The evidence") into a repeatable
benchmark task under `bench/tasks/crestline/`, scored by a checker rather than
by eye. It exercises the whole framework loop:

- **Setup:** setting up or extending a SvelteKit app.
- **Build:** a feature that spans a route, its `load` function and a component.
- **Debug:** a deliberately broken `load` (the page reads `data.items`, which
  `load` never returns).
- **Check:** `svelte-check`, `vite build`, and the existing page check that
  the items render.

**Open problem.** `npm create` and `npm install` need the network. Seed the
task's workspace with a lockfile and a local package cache so it installs
offline, the same way every run.

**First goal.** Reproduce the Ornith stall on demand. Keep the transcript; it
is the test fixture for item 3.

## 3 — Stagnation detection and recovery (P0)

A pure module in agent-core, `stagnation.mjs`, that watches each round: the
calls, their results, the files written (path and a hash of the content), and
the streamed reasoning. No I/O, so it is tested against recorded transcripts.

**Detectors.**

| | Fires when | What it catches |
|---|---|---|
| a | **Same failure:** the same error at least 3 times in the recent rounds, comparing the error text with numbers, paths and line numbers normalised away | Retries with slightly different arguments, which the exact-repeat guard misses |
| b | **Edit oscillation:** a file written back to content it had before (A → B → A) | Undoing and redoing the same fix |
| c | **No progress:** about 6 rounds with no new error type, no successful write and no newly read file | Busy-looking runs that learn nothing |
| d | **Reasoning loop in one response:** while reasoning streams, split it into sentences and watch a window of recent ones. It fires when one sentence keeps recurring, or when the share of repeated sentences in the window is high. | Crestline turn 2 (45% repeated, one cycle ×59) |
| e | **Theorizing:** reasoning keeps growing across rounds without new evidence. Measured as reasoning characters since the last call that produced something new (a successful write, a new error, a new file read), plus counting self-reversals like "actually, let me reconsider". | Crestline turn 1 (115k characters, 2.5% repeated: detector d alone misses it) |

The existing identical-call guard (`MAX_IDENTICAL_CALLS`) becomes one rule
inside detector a.

**Recovery**, more forceful each time it fires in the same run:

1. A short note to the model with the evidence (for example: "`svelte-check`
   failed 3 times with *Property 'items' does not exist on type 'PageData'*;
   your last 3 edits did not change it"), then the procedure from item 4.
2. The repeated action is refused until the model gathers new evidence: a
   read, diagnostics, or a command.
3. The run stops and asks the person, with a summary of what was tried.

For detector d, the response is aborted and requested again with the nudge.
Detector e uses the same steps as a–c.

**Thresholds from the fixture.** Detector d must fire well before the 59th
cycle in turn 2, and must stay quiet on turn 1's 2.5%. Detector a must fire
on the 3rd failed `npx sv add vitest`. These become the fixture's test
assertions.

**Visible.** Each firing goes in the run log and the benchmark record. In the
panel it shows in the turn's timeline as a short "Changed approach: …" line.

**Tests.**
- Unit tests per detector, including the normalisation (same error at another
  line number is the same failure).
- The recorded Crestline/Ornith transcript as a fixture.
- A before/after benchmark run.

## 4 — Triggered debugging instructions (P2)

Not a standing instruction: it is the text of recovery step 1, modelled on
what the person wrote mid-run in the Crestline transcript. Kept short enough
for small models:

1. Quote the failing observation exactly.
2. Name two hypotheses for it.
3. Run the cheapest check that tells them apart.
4. Only then edit.

Lives in agent-core next to the stagnation notes, so Nest's chat uses the
same wording.

## 5 — Tool catalog evaluation (P1)

The question: is the full Nest + Yellowscript catalog too much for smaller
models? The bench can already withhold tools.

**Variants.**
- The full catalog.
- A core set: read, write, edit, grep, run command, diagnostics.
- The core set plus Nest's tools.

**Matrix.** Each variant × the target models × the task set × 3 repetitions.

**Measured.**
- Pass rate and rounds.
- Calls to the wrong tool, and calls the model wrote as text that had to be
  recovered.
- Tokens the tool list itself costs on each request.

Results go in `docs/bench-results.md`. Run after item 3, because stalled runs
skew every number here.

## 6 — Working-state compaction (P2)

**Today.** When the context fills up, `context-budget.ts` replaces old tool
results with a stub, and what they showed is lost.

**Plan.** Keep a working-state record for the run:

- discoveries, with where each came from
- decisions
- files changed (already in the run log)
- open errors
- the plan

Most of it is built automatically from the run log and tool results; the
model's notes (`ys_note`) add the rest. When old messages are trimmed, the
record takes their place instead of a bare stub.

**Build it on upstream `compaction.mjs`**, which already has summary-based
compaction, rather than growing `context-budget.ts` into a third mechanism.
Decide in item 0 which of the two Yellowscript keeps.

**Decided (2026-11-24).** Yellowscript keeps `context-budget.ts`. Its pressure
is inside one run (tool results, which are cheap to fetch again), where
compaction.mjs summarises old turns of a conversation with an extra model
call. It now takes compaction.mjs's thresholds instead of its own copies. The
record is agent-core's `working-state.mjs`, built from the calls with no
model call, so any host can use it.

---

## Open questions

- **The fixture's home.** *Decided:* only the parts the tests need, gzipped, in
  `bench/fixtures/crestline-ornith.json.gz` (64 KB): the prompts, the
  reasoning and answer text, and each call's name, arguments, status and
  summary. The tool outputs were never stored, so a command's failure text is
  its run-log last line.
- **Detector thresholds** (3 failures, 6 rounds) are starting guesses, to be
  tuned against the item 2 runs. The reasoning-loop window came out of the
  fixture: Crestline turn 2's cycle is about 60 sentences long, so a
  40-sentence window never saw it repeat. It is 120 sentences, firing at 40%
  repeats, which turn 2 crosses on its 4th cycle and turn 1 never nears (9%).
- **Crestline offline install.** *Decided:* a step that builds the cache once
  (`npm run bench:cache`, from the workspace's lockfile into the ignored
  `bench/.cache/`), copied into each run's workspace. Copied, not linked, so
  an install inside one run cannot change the next.
- **Merging upstream.** The agent-core changes are on redstart-project's
  `feat/stagnation` branch, not yet pushed or merged. Re-sync from upstream
  `main` once they are.
