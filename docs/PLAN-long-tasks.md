# Plan: long web-development tasks

*As of 2026-11-19. Follows [PLAN-complex-tasks.md](PLAN-complex-tasks.md),
whose items 1–14 are built. Work is on `feat/long-tasks`; the State column
says how far it has got.*

**Goal.** The milestone ladder from the earlier plan (Pong → platformer → the
full game with levels, art, sound and a title screen → the Redstart website),
done over many messages and several sessions, without the model losing track
of what it built.

**Target model.** Unchanged: Qwen3.6-35B-A3B (Q3/Q4), ~32k context. Every new
tool is paid for in the tool list on every request, so each item says what it
costs there, and phase 0 makes room first.

---

## Status

| # | Item | Phase | Where | State |
|---|---|---|---|---|
| 0 | Room in the tool list; argument repair | 0 | Yellowscript, agent-core | Done: 11,120 → 6,674 characters; repair in Yellowscript until agent-core takes it |
| 1 | Run log carried into the next message | 1 | Yellowscript | Done; live line on the newest message (see item) |
| 2 | Task summary card | 1 | Yellowscript | Done; shows processes as started, not whether they still run |
| 3 | Dev-server URL detection | 1 | Yellowscript | Done |
| 16 | Protected paths (before 15) | 1 | Yellowscript | Done; checked in the registry, so every write tool is covered |
| 15 | Safe commands run without asking; reading outside the workspace | 1 | Yellowscript | Done; the recorded `dev-server-fix` run is still to do |
| 4 | Outline, symbols, references | 2 | Yellowscript | |
| 5 | Big files read as an outline | 2 | Yellowscript | |
| 6 | Page steps, `eval`, viewport | 3 | Yellowscript | |
| 7 | The game test hook convention | 3 | Templates, `AGENTS.md` | |
| 8 | Workspace notes (`ys_note`) | 4 | Yellowscript | |
| 9 | Project-scoped memory from Yellowscript | 4 | **Nest**, then Yellowscript | |
| 10 | Attention when a run waits on you | 5 | Yellowscript | |
| 11 | Resume an interrupted task | 5 | Yellowscript | |
| 12 | Images, `@file` and selections in the composer | 5 | Yellowscript | |
| 13 | Assets: sprites and sounds | 6 | Yellowscript | |
| 14 | Site check and importing content | 6 | Yellowscript (+ Nest's web fetch) | |

Phases are an order, not a schedule: 1 helps every multi-message task at once
and removes most of the prompts a long run stops on; 2 has to land before the
game outgrows the window; 3 makes "the game works"
checkable; 6 waits for the milestone that needs it.

---

## Three layers of memory

Each kind of state has one home, chosen by how long it stays true.

| Layer | Lives | Holds | Item |
|---|---|---|---|
| Run log | The conversation | What each run did, exactly | 1 |
| Workspace notes | The repo (`.yellowscript/NOTES.md`) | The model's working knowledge of this project | 8 |
| Nest project memory | Nest, every app | Durable facts worth having in chat-ui and Twig too | 9 |

Live state (a running process, the plan's open steps) is in none of them: it
is computed at each request, because it can stop being true at any moment.

Why project memory alone does not cover it (read from `redstart-nest/daemon/`,
2026-11-19):

- `memory_save` with scope `project` finds the project through a conversation
  stored on Nest (`projectForConversation`, from
  `_meta['redstart/conversationId']`). Yellowscript's chats are local and send
  no id, so the save fails with "this chat is not in a project". Only user
  scope works, and that leaks into every chat.
- The automatic review pass (`memory-review.mjs`) reads Nest-stored
  conversations, so it never sees a Yellowscript chat.
- It is built for durable facts: 500 characters a memory, a ~1,200-character
  block shared by facts, state and guidance, chosen by the first message. Its
  description says not to save one-off task details.

---

## Phase 0 — make room

### 0 — The tool list and argument repair

The 16 local tools cost ~11,000 characters (~3,200 tokens) on every request,
before `ask_user`, `update_plan`, Nest's tools, `AGENTS.md` and the tree.
Phases 2–6 add four tools and grow two; this pays for them first.

- **Remove `ys_edit_file` from the default set.** `ys_replace` and
  `ys_write_file` cover it, and small models get unified diffs wrong. Keep the
  tool behind a setting (`redstartYellowscript.tools.unifiedDiff`, off) and
  keep routing old transcripts' calls to it. −814 characters.
- **One `ys_process` tool** with `action: "start" | "output" | "stop"`,
  replacing three. Approval still applies to `start` only. −~700 characters.
- **Shorten descriptions** where the schema already says it. Target: the
  local set at or under 9,000 characters after phase 3, measured by a test
  that fails above a budget (`registry.test.ts`, `TOOL_PAYLOAD_BUDGET`).
- **Repair malformed arguments** before rejecting them: trailing commas,
  single-quoted strings, raw newlines and tabs inside strings (the common
  case: `ys_write_file` content), a wrapping code fence. This belongs in
  agent-core next to the recovery parser so chat-ui gains it too; until that
  syncs, `parseToolArguments` does it here and counts repairs for the bench.
  Correct the comment in `registry.ts:10-14` either way.

**Done when** the payload test passes under budget, and the bench's
"invalid args" column counts repaired calls separately.

---

## Phase 1 — continuity between messages

### 1 — The run log

`ChatSession.buildRequest` (`src/chat/session.ts:558`) sends only user text
and assistant text. Every tool call and result of an earlier message is gone,
so a second message starts without knowing what the first one built.

**Shape.** After a run, build one compact block from `result.toolRuns` and
store it on the assistant message (`ChatMessageView.runLog?: string`, saved
with the transcript like `tools`). New module `src/chat/run-log.ts`, pure:

```
[What this run did]
wrote src/game.js, src/art.js (new); replaced in index.html
moved img/ → assets/
ran npm test → exit 1 (2 failing: cart total, discount)
started p1 "npm run dev"
checked http://localhost:5173 → 1 error: player is undefined (game.js:42)
```

- One line per kind of action, paths de-duplicated, at most ~600 characters;
  over that, the oldest lines are dropped with a count.
- Rejected writes and commands are listed as rejected: the model must not
  assume they happened.
- Reads, searches and `ask_user` are left out; they changed nothing.
- The last `ys_check_page` result keeps its first problem, since that is what
  the next message usually asks about.

**Sending.** In `buildRequest`, the log goes after the assistant's text in
the same message. The text is what the model said; the log is what it did.

- **A failed turn still sends its log.** Today a turn with `error` is skipped
  entirely, but if it wrote three files before the stream died, those writes
  are real. The error text stays out; the log goes in, as an assistant message
  of its own.
- **Old logs collapse.** Logs older than the last 6 assistant messages are
  sent as one line (`[Earlier run: wrote 4 files, ran 3 commands]`). Done in
  `run-log.ts`, not in the context budget, so the prefix stays stable from
  request to request and the prompt cache holds.

**Live state** is built fresh on each request. *As built:* it is prefixed to
the newest user message, not put in the workspace system message: a change
at the start of the request (a process starting or stopping) would cost the
whole prompt cache, and Qwen's chat template refuses a system message
anywhere but first.

```
Running now: p1 "npm run dev" → http://localhost:5173 (started 12 min ago)
```

From `BackgroundProcesses` (running entries only, plus the URL from item 3).
A process that died since the last message just disappears from this line.

**Tests** (`run-log.test.ts`, `session.test.ts`): a log built from scripted
`toolRuns`; rejected actions marked; the cap; a failed turn's log sent without
its error; collapse past 6; the live line follows the process table.

**Done when** a scripted two-message conversation ("build X", then "now
change the file you made") is answered by the second message without a
search: the bench gains a task for this (`follow-up-edit`).

### 2 — The task summary card

The same data, for the person. When a run with writes or commands ends, its
turn shows a summary card under the answer:

- Files changed, each opening its diff against the run's first checkpoint
  (the shadow repo already has it; `checkpoint.ts` needs a "diff this file
  between checkpoint A and the working tree" call).
- Commands run, with exit codes; processes still running, with their URL.
- **Revert this task** on the card (the existing command, scoped to this run).

Built from the stored `runLog` data, not re-derived, so a reloaded panel draws
it again. Webview: `TaskSummary.svelte`, view-model reducer case, tests in
`view-model.test.ts`. The "Used N tools" fold stays as it is.

### 3 — Dev-server URL detection

`BackgroundProcesses` watches each process's output for the first
`http(s)://(localhost|127.0.0.1|0.0.0.0|[::1]):PORT` (stripping ANSI colour
codes first; Vite colours its banner) and keeps it on the process as `url`.

- `ys_process start` waits up to 5s for either a URL or the process exiting,
  and its result says which: `p1 is serving http://localhost:5173` or
  `p1 exited with code 1: <last lines>`. The model no longer has to poll and
  parse a banner.
- `0.0.0.0` and `[::]` are reported as `localhost`, which `ys_check_page`
  accepts.

**Tests** in `process-runner.test.ts` against Vite's, Next's, `http-server`'s
and `python -m http.server`'s real banners.

### 16 — Protected paths (lands before 15)

Item 15 lets some commands run without asking, which is only safe if the
model cannot change what those commands do. Today the write tools refuse
paths outside the workspace and nothing else, so a model could write
`.git/config` (git runs `core.fsmonitor` on `git status`, and diff drivers on
`git diff`), or add itself an `allowedCommands` entry in
`.vscode/settings.json`. With "Always allow edits" or "Apply all in this
task", either would apply without a prompt.

New module `src/tools/protected-paths.ts`, pure, used by every write tool's
planning step and by the read side below.

**Writes refused outright** (the tool returns an error naming the rule):

- `.git/` anywhere in the workspace: config and hooks are programs git runs.
- `.yellowscript/shadow/`: the checkpoint repo that reverts depend on.
- Any change to a `redstartYellowscript.*` key in `.vscode/settings.json` or
  a `*.code-workspace` file. Yellowscript's own permissions are the person's
  to set.

**Writes that always ask**, like a deletion (never auto-applied, never
"always allow"): the rest of `.vscode/settings.json`, `*.code-workspace`,
`.vscode/tasks.json` and `.vscode/launch.json` (they define what runs on
F5 or a task), and `package.json` when its `scripts` change (item 15 trusts
those).

**Reads that ask, even inside the workspace** (secrets, which would otherwise
go into the prompt and the transcript): `.env` and `.env.*` (not
`.env.example`), `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `id_ed25519*`, `.npmrc`,
`.pypirc`, `.git-credentials`, `.netrc`. This covers `ys_read_file`, `ys_grep`
(it skips them and says how many it skipped), and the path arguments of
safe commands. The file tree in the workspace note may still list their
names.

**Tests:** each rule, with path tricks: case on Windows (`.GIT/config`),
`./.git/../.git/hooks/x`, a backslash path, a symlink inside the workspace
pointing into `.git`.

### 15 — Safe commands run without asking

**What already runs without asking.** Every read tool: `ys_read_file`,
`ys_list_directory`, `ys_glob`, `ys_grep`, `ys_diagnostics`,
`ys_editor_context`, `ys_check_page`. Looking at a workspace file never
prompts. The prompts come when the model reaches for the shell instead
(`cat`, `ls`, `git status`, `npm test`), which small models do often. Each
prompt stops a long run until someone answers it.

So there are three tiers, decided by one pure function,
`classifyCommand(line, context)` in `src/tools/safe-commands.ts`, called by the
command gate (`src/ui/run-command.ts`) before `isCommandAllowed`:

| Tier | Runs | Who decides |
|---|---|---|
| A — read-only | Without asking | Built in; one setting turns the list off |
| B — the project's own checks | Without asking, by default | A setting turns it off |
| C — everything else | Asks, as today | The person; "Always allow" as today, except where noted |

#### How a line is judged

Commands run through `shell: true`: cmd.exe on Windows, `/bin/sh` elsewhere.
The shell rewrites the line before the program sees it, so a check on the
words alone is not enough. In order, any failure makes the line tier C:

1. **No composition.** The existing `SHELL_COMPOSITION` check: `&& || ; | &
   < >`, backticks, `$(`, `${`, a second line.
2. **No expansion.** Also refused: `$` (`cat $HOME/.ssh/id_rsa`), `%`
   (`type %USERPROFILE%\.ssh\id_rsa`, which looks like a relative path), `!`
   (cmd's delayed expansion), `^` (cmd's escape), `~` at the start of a word,
   and `{ }`.
3. **Words split cleanly.** Simple single and double quotes; an unbalanced
   quote is refused.
4. **A bare program name**, matched case-insensitively with `.exe`, `.cmd` and
   `.bat` stripped. A path (`./git`, `C:\tools\git.exe`) is refused. On
   Windows, cmd.exe runs a program in the current directory before searching
   PATH, so the line is also refused when the working directory holds a file
   with that name and any `PATHEXT` extension (a `git.bat` the model wrote).
5. **The program's rule** (the tables below): an allowed subcommand, no
   denied flag.
6. **Every path argument** resolves inside the workspace roots (or an extra
   read root, below), not into a protected path (item 16). `*` and `?` are
   allowed only in relative arguments with no `..`.

A tier A or B command still shows a card in the transcript, marked
"ran without asking", with the rule that allowed it, and its output still
streams to the Yellowscript Commands channel with `(safe: <rule>)` on the
`$` line. The task summary (item 2) lists it.

#### Tier A — read-only, built in

| Group | Commands | Rules |
|---|---|---|
| Listing and reading | `ls`, `dir`, `tree`, `cat`, `type`, `head`, `tail`, `wc`, `stat`, `file`, `du` | Paths in the workspace. `tail -f` / `--follow` refused (never ends) |
| Comparing | `diff`, `cmp`, `fc` | Paths in the workspace. `diff --output` refused |
| Searching | `grep`, `rg`, `findstr`, `find` | `rg --pre` and `-z` / `--search-zip` refused (they run programs). `find` with `-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-fprint*`, `-fls` refused |
| Sorting | `sort`, `uniq` | `sort -o` / `--output` refused |
| Where am I | `pwd`, `cd` alone (cmd prints the directory), `echo`, `where`, `which`, `command -v` | `echo` is harmless once expansion is refused |
| Versions | `<program> --version`, `-v`, `-V`, `version`, for `node`, `npm`, `pnpm`, `yarn`, `bun`, `deno`, `python`, `py`, `pip`, `git`, `tsc`, `cargo`, `rustc`, `go`, `java`, `dotnet` | Only that one flag, nothing else |
| Package facts | `npm ls`, `npm pkg get`, `npm view`, `npm outdated`, `npm audit` (also `pnpm` and `yarn` equivalents) | `npm audit fix` is tier C. `view`, `outdated` and `audit` contact the package registry and only read |
| Git, read-only | `git status`, `diff`, `log`, `show`, `blame`, `ls-files`, `grep`, `rev-parse`, `describe`, `shortlog`, `stash list`, `stash show` | Denied anywhere in the line: `-c`, `--config-env`, `--exec-path`, `--git-dir`, `--work-tree`, `--output`, `--ext-diff`, `--textconv`, `-O` / `--open-files-in-pager` |
| Git listings | `git branch`, `git tag`, `git remote` | Only bare or with listing flags (`-a`, `-r`, `-v`, `-vv`, `--list`, `-l`, `--show-current`); a name argument creates or deletes, so tier C |
| Syntax only | `node --check <file>`, `tsc --noEmit` | `tsc` only from `node_modules/.bin` (bare `npx tsc` may download). `tsc` runs no project code; `--noEmit` writes nothing |

**Git runs hardened.** Even with `.git/` protected, a tier A git command runs
as `git --no-pager -c core.fsmonitor=false -c core.hooksPath= -c
diff.external= -c core.pager=cat …`, adding `--no-ext-diff --no-textconv` for
`diff`, `log` and `show`, with `GIT_TERMINAL_PROMPT=0`. The model's own `-c`
is what is denied; these are Yellowscript's.

**Output redaction.** Credentials in URLs (`https://user:token@host`) are
masked in what the model reads, since `git remote -v` and `npm view` can
show them.

Not in tier A, on purpose:

- `sed`, `awk`: `sed -i` and `w`, and `awk`'s `system()`, write and run
  things.
- `env`, `printenv`, `set`, `npm config get` / `list`: they print secrets into
  the prompt.
- `certutil`: it hashes, and also downloads.
- PowerShell cmdlets: commands go through cmd.exe, so a cmdlet needs
  `powershell -Command`, which runs arbitrary code.

#### Tier B — the project's own checks

These run code in the workspace, including code the model wrote this run,
which is why they are a separate tier. They carry the same trust as the
writes the person already accepted, and asking before every `npm test` is
the friction this item removes. On by default, with
`redstartYellowscript.commands.autoRunProjectChecks` (true) to turn it off.

| Group | Commands | Rules |
|---|---|---|
| Package scripts | `npm test`, `npm run <s>`, `pnpm <s>`, `yarn <s>`, `bun run <s>` for `s` in `test`, `build`, `lint`, `typecheck`, `check`, `format:check` | The script must exist in `package.json`. Asks if this run changed `scripts` (compared with the run's first checkpoint). The card shows the script's command |
| Dev servers | `ys_process start` with `npm run dev`, `start`, `serve`, `preview` (and the other runners) | Same rules. Still at most four background processes |
| Local tools | `vitest run`, `jest`, `eslint`, `prettier --check`, `playwright test`, through `npx` or `node_modules/.bin` | Only when installed locally (no download). `eslint --fix` and `prettier --write` are tier C (they rewrite files outside the review) |
| Python | `pytest`, `python -m pytest`, `ruff check`, `mypy` | `ruff --fix` is tier C |
| Rust, Go | `cargo check`, `test`, `clippy`, `build`; `go vet`, `test`, `build` | `cargo build` runs `build.rs`, like any project code |

#### Tier C — always asks

Everything not above, and in particular:

- **Installing:** `npm install`, `add`, `remove`, `ci`, `pip install`. These
  use the network and run install scripts.
- **Running other code:** `node <file>`, `python <file>`, `-e` / `-c`, `npx`
  of anything not installed. "Always allow" offers only the exact line, as
  `allowPrefixFor` already does.
- **Git that changes things:** `add`, `commit`, `checkout`, `switch`,
  `restore`, `reset`, `stash` (push, pop, drop), `merge`, `rebase`, `pull`,
  `fetch`, `push`, `clean`, and branch or tag creation and deletion.
- **Changing files from the shell:** `rm`, `del`, `rmdir`, `mv`, `move`, `cp`,
  `copy`, `mkdir`, `touch`, `chmod`. The prompt says that the `ys_` tools do
  this with a checkpoint, and the tool descriptions say so up front.
- **Network:** `curl`, `wget`, `ssh`, `scp`.
- **System:** `sudo`, `runas`, `reg`, `sc`, `schtasks`, `taskkill`,
  `shutdown`.
- **Lines with composition or expansion, and paths outside the workspace.**

**Never "always allow"**, asked every time like a deletion: `git push`,
`git reset --hard`, `git clean`, `git checkout -- <path>` / `git restore`
(they discard work), and `rm`, `del` or `rmdir` with a recursive flag.

#### Reading outside the workspace

Today the read tools refuse any path outside the workspace. Reading a
sibling repository (`E:\redstart-project`) or a global config is sometimes
the right move, so the refusal becomes a question for read-only access:

- The read tools and tier A path checks ask once per folder: **Allow this
  time**, **Always for this folder** (kept per workspace in
  `redstartYellowscript.extraReadRoots`), or **Deny**.
- Read-only: writes outside the workspace stay refused, with no option.
- Never offered, refused as today: the home directory itself, `~/.ssh`,
  `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.docker`, `%APPDATA%\npm`, and the
  system directories. The protected-read patterns of item 16 apply inside an
  extra root too.

#### Settings

| Setting | Default | Notes |
|---|---|---|
| `redstartYellowscript.commands.builtInSafe` | `true` | Tier A runs without asking |
| `redstartYellowscript.commands.autoRunProjectChecks` | `true` | Tier B runs without asking |
| `redstartYellowscript.extraReadRoots` | `[]` | Folders outside the workspace the read tools may read |
| `redstartYellowscript.allowedCommands` | `[]` | Unchanged: the person's own prefixes, checked after the tiers |

#### Tests

`safe-commands.test.ts`, table-driven: every row of the tables allowed, and
every bypass refused, among them:

- `type %USERPROFILE%\.ssh\id_rsa`, `cat $HOME/.ssh/id_rsa`, `cat ~/.ssh/id_rsa`;
- `cat ../../secret`, `cat C:\Windows\win.ini`, `cat .env`;
- `git -c core.pager=calc log`, `git diff --output=x`, `git grep -O`;
- `find . -delete`, `rg --pre sh x`, `tail -f log.txt`;
- `./git status`, and `git status` with a `git.bat` in the working directory;
- `cat a` + newline + `rm b`, an unbalanced quote;
- `npm test` after this run changed `scripts.test`.

The bench harness counts the prompts each task would have shown (it
auto-approves, so today the count is invisible), and `summary.md` gains a
"prompts" column.

**Done when** none of the bypass rows is allowed, and a recorded
`dev-server-fix` run asks only for its writes.

---

## Phase 2 — reading less

### 4 — Outline, symbols and references

The language server already knows the code's structure; the model pays for
it in whole-file reads. Three tools behind one provider port, the way
diagnostics are wired (`DiagnosticsProvider` → `ui/tool-providers.ts`):

| Tool | VS Code command | Returns |
|---|---|---|
| `ys_outline(path)` | `vscode.executeDocumentSymbolProvider` | Nested symbols with kind and line range |
| `ys_find_symbol(name)` | `vscode.executeWorkspaceSymbolProvider` | Up to 20 definitions, `path:line kind name` |
| `ys_references(path, line, character)` or `(name)` | `vscode.executeReferenceProvider` | Up to 40 locations with the line's text |

- Port: `src/tools/symbols.ts` defines `SymbolProvider` (no `vscode`), the
  tools and the formatting; `ui/tool-providers.ts` implements it. The bench
  harness supplies a TypeScript-compiler-API implementation so the tools are
  measurable headless.
- When the language server returns nothing (HTML, CSS, a file type with no
  extension installed), `ys_outline` falls back to a regex outline: headings
  and ids for HTML, selectors for CSS, `function`/`class`/`const x = (` for JS.
- `ys_references` by name resolves the name with `ys_find_symbol` first, and
  refuses an ambiguous name by listing the candidates.
- Cost: ~1,500 characters in the tool list, paid for by phase 0.

**Done when** a bench task on a ~3,000-line, 8-file game (`navigate-large`)
finds and fixes a bug with fewer prompt tokens than the same run with these
tools withheld (the harness can withhold tools by name).

### 5 — A big file reads as an outline first

`ys_read_file` on a file over 400 lines, with no `offset`, returns the file's
outline (item 4) and its first 80 lines, then:
`[612 lines. This is its outline; read a range with offset and limit.]`.
With an `offset`, or under 400 lines, it reads as today. Paging and the
truncation note stay as they are.

The model stops mistaking a truncated head for the whole file, and the usual
next step (read lines 300–360) costs 60 lines, not 2,000.

---

## Phase 3 — checking behaviour, not just loading

### 6 — Steps, `eval` and viewport in `ys_check_page`

Today the check loads, waits and reports. It grows three optional arguments,
still one tool, still one call:

```json
{
  "target": "http://localhost:5173",
  "viewport": "390x844",
  "steps": [
    {"key": "ArrowRight", "hold_ms": 800},
    {"key": "Space"},
    {"wait_ms": 500},
    {"screenshot": "after-jump"},
    {"click": "#start"},
    {"type": "hello", "into": "input[name=q]"},
    {"wait_for": ".results li"}
  ],
  "eval": "({x: __game.player.x, score: __game.score})"
}
```

- **Steps** are flat objects, one action each, run in order after load:
  `key` (with optional `hold_ms`), `click` (a selector, or `[x, y]` in CSS
  pixels; on a canvas, coordinates are what games need), `type` (with `into`),
  `wait_ms` (≤5,000), `wait_for` (a selector, ≤5s), `screenshot` (a label).
  At most 20 steps. Keys go through `Input.dispatchKeyEvent` with a real
  `keydown`…`keyup` gap for `hold_ms`; clicks through `Input.dispatchMouseEvent`
  at the element's centre.
- **`eval`** runs after the steps (`Runtime.evaluate`, `returnByValue`, 2s
  timeout) and its JSON result, capped at 2,000 characters, is in the report.
  The page is the user's own and loopback-only, so this reaches nothing new.
- **`viewport`** is `WIDTHxHEIGHT` via `Emulation.setDeviceMetricsOverride`,
  with a mobile flag below 600px wide.
- **The report** says which step failed and why (`wait_for ".results li"
  timed out after 5s`), then the rest as today. Errors are tied to the step
  that preceded them: an exception right after `{"key": "Space"}` is the jump.
- **Element facts:** `{"inspect": "header"}` as a step returns that element's
  box, visibility, text (200 characters) and a handful of computed styles
  (`position`, `display`, `color`, `background-color`, `font-size`). That
  answers "is the header sticky" without vision.
- Screenshots: each labelled one saved under `.yellowscript/screenshots/`;
  only the last goes to the model, and only when it reads images.

The description gains two short worked examples (a game, a form); small
models need them for arrays of objects. Cost: ~700 characters.

**Tests** in `browser-check.test.ts` against a fake DevTools socket (the
existing pattern), plus `npm run live` gains one stepped check of a fixture
page with a button that throws.

### 7 — The game test hook

A convention, not code: written into the game template (item 13's starter)
and into `bench/tasks/barrel-platformer`'s `AGENTS.md`, and suggested in the
`eval` description.

- The game exposes its state as `window.__game` (player position, lives,
  score, level, current scene).
- `?test` in the URL seeds its random-number generator and steps the
  simulation on a fixed timestep, so the same steps give the same numbers.

With that, "jump over the first barrel" is a check the model can run and
read, on a non-vision model, and identical runs agree.

---

## Phase 4 — what the model has learned

### 8 — Workspace notes

`.yellowscript/NOTES.md`, kept by the model with one tool and sent with the
workspace system message.

- **`ys_note(section, text)`** replaces one named section (`text: ""` removes
  it). Sections, not free appends, so the file stays short and current
  instead of growing a log. Through the write review like any other write,
  with "Apply all in this task" covering it.
- **Sent** after `AGENTS.md`, capped at 1,500 characters; when over, the
  note says which sections were left out, and `ys_read_file` reads the rest.
- **The description** says what belongs there: how to run, build and check
  this project; where things live; decisions and why; known problems. And
  what does not: anything about the user (memory), the plan (`update_plan`),
  or what one run did (the run log does that).
- Plain markdown, `## section` headings. Committed with the project if the
  person wants; `.yellowscript/` is the person's call in `.gitignore`.

**Tests:** section replace and remove; the cap; the context message order
(instructions, notes, tree, live state).

### 9 — Project-scoped memory from Yellowscript (Nest first)

For facts that matter outside the editor. **This needs a Nest change**, made
in redstart-project:

- `memory_save` (and `memory_search`) accept the project from a second
  `_meta` key, `redstart/projectId`, when there is no Nest conversation. It is
  checked like the conversation id: it must be a project this account may
  write. A forged id resolves inside the caller's own scope, as now.
- `projectForConversation`'s callers fall back to that check.

Then Yellowscript sends `redstart/projectId` (the linked project,
`SessionDeps.projectId`) on every `tools/call` in `mcp-host.ts`.

Not in scope: running Nest's memory review on Yellowscript chats. It would
mean sending the conversation to Nest after it goes quiet, which is a
decision about where chats live, not a fix.

**Done when** a `memory_save` with scope `project` from Yellowscript shows in
the chat app's project memory, and a request from the same workspace carries
it in its instructions.

---

## Phase 5 — the person's side of a long run

### 10 — Attention when a run waits on you

When an approval card, a question or the turn-limit prompt opens and
`vscode.window.state.focused` is false:

- a notification naming the conversation and what it waits for, with
  **Show** (focuses the tab);
- the status bar item shows a waiting badge until it is answered;
- nothing when the window is focused, which already shows the card.

A setting turns notifications off (`redstartYellowscript.notifyWhenWaiting`,
on). A finished long run (over 2 minutes) notifies the same way.

### 11 — Resume an interrupted task

A window reload or crash ends the run and stops its processes.

- When a run starts, the conversation records `inFlight: { startedAt,
  processes: [{command, cwd}] }`, updated when a process starts or stops,
  cleared when the run ends. Saved with the conversation.
- On restore, a conversation with `inFlight` shows a card: "This task was
  interrupted." with **Continue** (sends "Continue the task from where it
  stopped.", and offers to restart the recorded processes first) and
  **Dismiss**.
- The run log of the interrupted turn is kept from the tool runs that had
  finished, so Continue starts with items 1 and 8 in hand.

### 12 — Images, `@file` and selections in the composer

- **Images:** paste or drop into the composer; shown as thumbnails; sent as
  `image_url` parts on the user message. When `/props` says the model cannot
  read images, the composer says so instead of sending them. Stored with the
  conversation, downscaled to ≤1,280px and capped at 4 per message so the
  store stays small.
- **`@file`:** typing `@` opens a picker over workspace files (the `ys_glob`
  index); a chosen file becomes a chip, and its content (up to 300 lines, or
  its outline when larger, as item 5) is attached to the message as a block
  the model reads. The bubble shows the chip, not the content.
- **Selections:** editor context menu **Add to Yellowscript** inserts
  `path:start-end` and the selected code as a chip. **Fix with Yellowscript**
  as a quick fix on a diagnostic sends the problem, the file and the lines
  around it.

---

## Phase 6 — when the milestones need them

### 13 — Sprites and sounds (milestone 3)

A model that can only write text cannot make a `.png` or a `.wav`, and drawing
everything in code makes for large, fragile files.

**`ys_make_asset`**, one tool, two kinds:

- **Sprite:** `{kind: "sprite", path: "assets/player.png", palette:
  {".": "transparent", "k": "#222", "r": "#d33"}, frames: [["..kk..", ...],
  ...], scale: 2}`. Rows are strings of palette keys, so the model writes
  pixel art as text it can also read back. Frames go side by side in one
  sheet; the result says the frame size and count. PNG written with
  `node:zlib`: no dependency.
- **Sound:** `{kind: "sound", path: "assets/jump.wav", wave: "square",
  start_hz: 300, end_hz: 600, duration_ms: 150, attack_ms: 5, decay_ms: 100,
  volume: 0.5}`, plus `noise` for explosions, in the sfxr style. A small pure
  synthesiser writes 16-bit mono WAV.
- **The source is kept**: `assets/player.png` is written with
  `assets/player.sprite.json` beside it (likewise `.sound.json`), so a later
  "make the player blue" edits the JSON and regenerates, instead of redrawing.
  `ys_make_asset` with only `{path}` regenerates from the existing source.
- **Review:** through the write gate as a binary change. VS Code's diff
  editor previews images; for sound the card says what changed.
- **SVG → PNG** (`{kind: "raster", from: "art/title.svg", path: ..., width}`)
  through the headless browser, for larger illustrations.

Also, a **game starter**: `index.html`, `game.js` with the loop, input, the
`__game` hook and `?test` (item 7), and an `AGENTS.md`, written by a command
(**Yellowscript: New Game Project**), not by the model from memory.

### 14 — The website: importing content, checking the site (milestone 4)

- **Reading the existing site.** If Nest's web-fetch tool is enabled for the
  account, the model can read the old site's pages through it today; nothing
  to build. If not, the person copies the content into the workspace. A
  Yellowscript fetch tool is not planned: Nest already owns network access
  and its policy.
- **Images from the old site:** `ys_make_asset {kind: "import", url, path}`
  downloads one image into the workspace, through the write review, from a
  host in `redstartYellowscript.importHosts` (empty by default; the prompt
  offers to add the host).
- **`ys_check_site(start)`**: crawls from a localhost URL, same origin, up to
  50 pages, reusing `browser-check.ts`. Per page: status, console errors,
  broken links and images, missing `alt`, `<title>` and meta description, and
  the largest layout shift. One table back, worst pages first.
- **Open question:** the site's stack (plain HTML, Astro, …). It decides the
  starter and what the notes should say.

---

## Testing

Every item has unit tests in the existing style (`node --test`, no `vscode`
in core modules, fakes for ports). The bench grows with the items that need
the real model:

| Task | For | Checks |
|---|---|---|
| `follow-up-edit` | 1 | Second message edits the file the first made, without searching |
| `navigate-large` | 4, 5 | Fix a bug in an 8-file game; prompt tokens vs. tools withheld |
| `play-check` | 6, 7 | Make the player jump; proven with steps and `eval` |
| `notes-carry` | 8 | Session 2 uses a command recorded in session 1's notes |

Each with a `reference/` solution, as now.

## Open questions

- The website's location and stack (item 14).
- Whether `.yellowscript/NOTES.md` should default to committed or ignored.
- Whether the Nest change in item 9 also wants Twig and chat-ui to send
  `redstart/projectId`, so all three agree on how a project is named.
- Tier B's default (item 15): on, as planned, or on only while the run's
  writes were each reviewed (off under "Apply all in this task")?
