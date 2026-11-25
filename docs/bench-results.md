# Bench results

One row per `npm run bench` run, copied from the end of its `summary.md`.
Name the label with the model and quantization (e.g. `qwen3.6-35b Q4_K_XL`),
and say below the table what changed since the previous row.

Columns: tasks passed; tool-call success (calls that did not error);
invalid arguments (not valid JSON, even after repair); repaired arguments
(malformed JSON fixed and run: raw newlines, stray backslashes, single
quotes, trailing commas, a code fence); calls recovered from the model's text
rather than `tool_calls`; model round trips per task; commands that would
have asked the person (the bench approves everything; the rest ran without
asking, as read-only or the project's own checks); runs that hit the turn or
time limit; runs where the context budget had to trim; calls to a tool that
does not exist (from 2026-11-24); stagnation recoveries, with the runs that
stopped as stuck in brackets; the tool catalog.

Since 2026-11-24 the bench runs the product's own agent (`agent/compose.ts`)
with diagnostics after each write, and the full catalog includes Nest's tools.
Rows before that ran the bare loop with the local tools and no diagnostics.

| Date | Label | Model | Pass | Tool success | Invalid args | Repaired args | Recovered | Turns/task | Command prompts | Hit a limit | Trimmed | Wrong tool | Recoveries (stuck) | Catalog |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

## Tasks

| Task | What it measures |
|---|---|
| `fix-failing-test` | Three bugs behind three failing tests; the tests must stay untouched |
| `multi-file-feature` | A function, its export and a CLI flag across three files |
| `fix-crash` | A wrong import path and name; the report's exact output |
| `follow-up-edit` | Two messages: the second edits the file the first made, without searching for it (the run log) |
| `navigate-large` | A bug in an 8-file, 3,000-line game; compare prompt tokens with `--withhold ys_outline,ys_find_symbol,ys_references` |
| `notes-carry` | Session 1 records an unusual test command with `ys_note`; session 2, a new conversation, runs it without looking it up |
| `long-context-reads` | 30 files (~50k tokens) read one by one on a 32k window: the context budget |
| `ask-before-guessing` | An ambiguous request: must ask (`ask_user`), then follow the answer |
| `play-check` | Space does not jump: fix it, and prove it with `ys_check_page` steps and `eval` on `index.html?test` |
| `canvas-pong` | A one-file canvas game, checked with `ys_check_page`, loading without errors |
| `dev-server-fix` | Start a server in the background, find the page error, fix it, re-check, stop |
| `barrel-platformer` | Milestone (`--tag milestone`): a single-screen platformer with every listed mechanic |
| `diagnostics-only` | Two type errors the program runs fine with, and no TypeScript in the workspace: only the diagnostics show them. Compare with `--no-diagnostics` |
| `crestline` | Milestone (`--tag svelte`): the hand-run SvelteKit prompt that stalled Ornith 1.5, with a `load` the page reads wrongly. Needs `npm run bench:cache` |

## Tool catalog evaluation

Agent-runtime plan item 5: is the full Nest + Yellowscript catalog too much
for a smaller model? Run after the stagnation checks, because stalled runs
skew every number here.

```bash
npm run bench -- --label "<model>" --catalog full,core,core+nest --repeat 3
```

Each catalog gets its own summary and row. `core` is `ys_read_file`,
`ys_write_file`, `ys_replace`, `ys_grep`, `ys_run_command` and
`ys_diagnostics` (plus `ask_user` and `update_plan`, which the loop answers).
Each run's record also has the tool count and what the tool list costs per
request (`toolListTokens`, the chars/3 estimate): locally the full set is
about 3,050 tokens and the core set about 2,150, before Nest's tools.

| Date | Model | Catalog | Pass | Turns/task | Wrong tool | Recovered | Tool list tokens |
|---|---|---|---|---|---|---|---|

## Notes on runs

(None yet.)
