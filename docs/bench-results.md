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
time limit; runs where the context budget had to trim.

| Date | Label | Model | Pass | Tool success | Invalid args | Repaired args | Recovered | Turns/task | Command prompts | Hit a limit | Trimmed |
|---|---|---|---|---|---|---|---|---|---|---|---|

## Tasks

| Task | What it measures |
|---|---|
| `fix-failing-test` | Three bugs behind three failing tests; the tests must stay untouched |
| `multi-file-feature` | A function, its export and a CLI flag across three files |
| `fix-crash` | A wrong import path and name; the report's exact output |
| `follow-up-edit` | Two messages: the second edits the file the first made, without searching for it (the run log) |
| `navigate-large` | A bug in an 8-file, 3,000-line game; compare prompt tokens with `--withhold ys_outline,ys_find_symbol,ys_references` |
| `long-context-reads` | 30 files (~50k tokens) read one by one on a 32k window: the context budget |
| `ask-before-guessing` | An ambiguous request: must ask (`ask_user`), then follow the answer |
| `canvas-pong` | A one-file canvas game, checked with `ys_check_page`, loading without errors |
| `dev-server-fix` | Start a server in the background, find the page error, fix it, re-check, stop |
| `barrel-platformer` | Milestone (`--tag milestone`): a single-screen platformer with every listed mechanic |

## Notes on runs

(None yet.)
