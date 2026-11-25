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

## Hand-run Crestline

The Crestline prompt run by hand in the product, not through `npm run bench`:
Yellowscript signed in as the `bench` account, in `sample-workspace/` (the
chats are in that workspace's VS Code storage, `state.vscdb`). Each run starts
from a fresh scaffold. `npx sv create` and `sv add` install the latest
releases, so these runs got **SvelteKit 3.x, Vitest 5.1, Vite 8 and TypeScript
6**, all newer than either model knows. Both models had Nest's tools,
`web_search` and `web_fetch` included. Context window 131k.

Pass means `npm run check`, `npx vitest run` and `npm run build` all green,
with no help from the person.

| Date | Model | Chat | Turns | Tool calls (errors) | Web lookups | Recoveries | Outcome |
|---|---|---|---|---|---|---|---|
| 2026-11-24 09:59 | Ornith 1.5 9B Q6_K | `468eh9` | 3 | 86 (21) | 0 | (before the checks) | Stopped by hand: theorizing over `sv add`, then a reasoning loop. The evidence for the stuck-run checks ([PLAN-agent-runtime.md](PLAN-agent-runtime.md)) |
| 2026-11-24 15:35 | Ornith 1.5 9B Q6_K | `0kyy38` | 3 | 100 (32) | 0 | same-failure ×2 | Stopped by hand at the check/test step |
| 2026-11-24 16:25 | Ornith 1.5 9B Q6_K | `23nvku` | 2 | 55 (12) | 0 | same-failure, reasoning-loop (L2) | Stopped by hand: wrote `$lib/quote` the SvelteKit 2 way and hunted for a `.svelte-kit/tsconfig.json` that SvelteKit 3 no longer writes. Prompted the lookup guidance |
| 2026-11-24 17:08 | Ornith 1.5 9B Q6_K | `3pq4f7` | 1 | 12 (4) | 0 | none | Stopped by hand after 577 s "waiting": 19,352 tokens inside one tool call, unseen. Prompted the argument-loop check, `max_tokens` and the "Writing the … call" line |
| 2026-11-24 17:33 | Ornith 1.5 9B Q6_K | (not kept) | 1 | about 100 | 3 | none | Stopped by hand. Scaffolded at the workspace root, not `Crestline/`. `check` green by 17:55 (round 49), then blocked on `npx vitest run` (below) and still investigating after 19:00 (round 73+). Prompted [PLAN-blocked-handoff.md](PLAN-blocked-handoff.md) |
| 2026-11-24 19:08 | **Qwen3.6 35B A3B UD-Q4_K_XL** | `4rz9mg` | 1 | 84 (19) | 7 | same-failure ×2, oscillation | **Pass** in 38 minutes (19:09 to 19:47), 32 tests, in `Crestline/` as asked |

### The Vitest blocker

From the 17:33 run on, `npx vitest run` failed at the first `describe(` with
`TypeError: Cannot read properties of undefined (reading 'config')`, and the
scaffold's own `greet.spec.ts` failed the same way. It is not the model's code:

- It comes and goes. The same command, with no file changed, sometimes runs
  the tests (11 of 12 passed in the Ornith run's code) and sometimes fails.
- When it fails, the transformed test file loads `vitest` through Vite's
  module runner (`/node_modules/vitest/dist/index.js`), a second copy of the
  module that the test worker never set up, so `describe` finds no runner.
- Turning off Vitest's module cache (`--no-fsModuleCache`), its dependency
  pre-bundling, or parallel test files does not stop it. A config with no
  plugins passed. So the trigger is the SvelteKit plugin in the test
  pipeline, with Vitest 5.1, SvelteKit 3.4 and Vite 8 together. The exact
  cause is not known.

**What Qwen did.** It took the SvelteKit plugin out of the test path rather
than debugging the clash: a standalone `vitest.config.ts` (no plugins,
`globals: true`, `environment: 'node'`) beside `vite.config.ts`, which keeps
the plugin for dev and build. It also switched the tests to Vitest's globals,
so they no longer import `vitest` at all; that leaves no second copy to load.
`svelte-check` then needed `"types": ["$app/types", "vitest/globals"]` in
`tsconfig.json`. This fits this project because `quote.ts` is plain
TypeScript. Component tests would need the plugin back.

It also found the SvelteKit 3 changes Ornith had stumbled on: `$lib` is now
`#lib` (the build failed until it switched), and there is no
`svelte.config.js`, as the configuration moved into the `sveltekit()` plugin.
It wrote a `svelte.config.js` and then took it back out, which the
oscillation check caught. Its 7 lookups (5 `web_search`, 2 `web_fetch`) were
mostly about the SvelteKit 3 config layout, one of them to the `wikipedia`
source.

### What the runs show

- **The model size gap is real.** Qwen3.6 35B A3B runs at about the same
  speed as the 9B here (about 32 tokens/s), because only 3B parameters are
  active per token. On the same task and the same toolchain break, it found a
  workaround and finished. The 9B investigated well but never stepped back.
- **For the 9B, the right outcome was a hand-off, not a fix.** The blocker
  was not in its code, and its three lookups turned up nothing it used. It should have told
  the person around round 61 instead of investigating for another hour:
  [PLAN-blocked-handoff.md](PLAN-blocked-handoff.md).
- **The task is not fixed.** Unpinned scaffolding means each run can get
  different releases, and the break above came with this week's. Pin `sv` and
  the dependency versions for comparisons over time, and keep a "latest"
  variant for testing how a model copes with new releases.
- **The harness changes held up.** Both models used the lookup tools once
  the guidance was in, Qwen on the SvelteKit 3 differences, and the stuck-run
  checks fired three times in the Qwen run without stopping a run that was
  getting somewhere.

## Notes on runs

(None yet.)
