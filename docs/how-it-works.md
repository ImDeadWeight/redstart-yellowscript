# How Yellowscript works

The detail behind the [README](../README.md): chats, the agent loop, the
tools and what asks before running, write approval, Nest's tools, and the
internals a contributor needs. The plans in this folder say why each part is
the way it is.

## Connecting

Yellowscript scans the local network for a Nest beacon on port **8765**.
`127.0.0.1` is probed first, then each host of this machine's subnets. The
beacon answers `{ "app": "redstart-nest", "running": true, "port": … }`, and
the connection URL is built from the IP that answered plus that port, never
from a URL the network supplies.

**LAN-HTTPS.** A Nest serving HTTPS behind Caddy reports port 80, which only
redirects to its https name, and adds `"origin": "https://<name>"` to the
beacon. Yellowscript uses the https name instead of `http://<ip>:80` when:

1. it is a bare https origin, from the beacon's `origin` or from where the
   plain address redirects;
2. the name resolves to the IP that answered (for `127.0.0.1`, to one of
   this machine's addresses), as Twig checks, so a spoofed beacon or
   redirect can only name a host that already points at itself;
3. it answers.

Yellowscript **never follows a redirect** from the Nest (`nestFetch` in
`src/nest/client.ts`). A cross-origin redirect drops the `Authorization`
header, so every request came back 401 and read as a sign-out; and a 308
keeps the body, so sign-in would send the password wherever the redirect
pointed. A redirect is reported instead: "The Nest at X redirects to Y.
Connect to Y instead."

Connection states: `disconnected` → `discovering` → `connecting` →
`unauthenticated` / `connected` / `error`. Auto-connect reconnects to the
last-used Nest silently when a window opens: no scan, no error popup.

**Credentials.** A password is used once: Yellowscript signs in, has Nest
issue a key for this app (surface `yellowscript`, labelled with this machine's
name), ends the session, and keeps only the key. The key survives a Nest
restart, and you can revoke it in the chat app. An `rst_` API key can be
pasted instead. Credentials live in VS Code's `SecretStorage`, keyed per
server, and never enter a setting, a log line or the model's context.

## Chats

Each chat is an **editor tab**, with its own transcript, run and prompt
queue. VS Code's tab row is the list of open chats; History has the rest.
Streaming carries on in a tab you have switched away from. Closing a tab puts
its chat in History (a blank one is deleted); a run still going carries on,
and History lists it as running. Chats are saved per workspace.

- **Streaming** has two channels: the answer, and the model's reasoning
  (collapsed).
- **Prompt queuing:** while a turn runs, new prompts queue behind it. Stop
  ends the queue too, and the queued text goes back into the composer.
- **Drafts** are kept per chat, across tab switches and reloads.
- **Tool cards** show each call on its turn: status, arguments, the one-line
  result, a **Nest** tag for tools that ran on the server, and **recovered**
  when the model wrote the call as text. A finished turn with four or more
  calls folds them into one "Used N tools" row. While a call is being
  written, the bubble says "Writing the `ys_…` call · N characters".

### Projects and workflows

- **Project.** Link the workspace to one of your Nest projects with the chip
  under the message box (or **Choose Project**). Every request then names it,
  and Nest adds the project's instructions and memories. The link is per
  workspace, for the Nest and account it was made with.
- **Workflows.** Type `/` in the message box, or use the bolt icon (or **Run
  Workflow**): the saved instructions from the chat app's Workflows page.
  Nest composes the text from its own copy; one with inputs asks for them.

### Images, files and selections

- **Images:** paste or drop them into the composer (up to 4 a message,
  downscaled to 1,280px). They go to the model only when it reads images.
- **`@file`:** type `@` and part of a path. The file goes with the message, or
  its outline when it is over 300 lines. Secrets files are not offered.
- **Selections:** **Add to Yellowscript** in the editor's context menu adds
  the selected lines as a chip. **Fix with Yellowscript**, a quick fix on an
  error or warning, sends the problem with the lines around it.

### When a run needs you

When the window is not focused and a chat starts waiting (an approval, a
question, the turn limit), a notification names the chat, with **Show**, and
the status bar shows a bell until it is answered. A run of over two minutes
that finishes unwatched says so too.

A reload or a crash ends a run and stops its processes. On the next load the
chat shows **This task was interrupted** with **Continue** (and **Restart and
continue** when it had processes running) or **Dismiss**.

## The agent loop

The loop is redstart-project's `shared/agent-core/`, the same code chat-ui,
the agent bench and Nest's task runner run (see
[Development](#agent-core-is-vendored)). Yellowscript supplies its ports in
`src/agent/loop.ts`.

### What the model is told

Every request with tools starts with a short note about the workspace: the
shell commands run in, its `AGENTS.md` (or `CLAUDE.md`), the model's own notes
(`.yellowscript/NOTES.md`, kept with `ys_note`), where to keep plans and
notes, and a two-level file tree. When the run has `web_search` or
`web_fetch`, the note also says that what the model knows about a library
stops at its training, and to look up current documentation when something
does not behave as it remembers.

Across messages, only your words and the assistant's answers are sent, so
each answer carries a short log of what its run did: files changed, commands
and their exit codes, processes and their address. Logs older than the last
six answers shrink to one line.

### Questions, plans and the turn limit

Yellowscript declares to Nest that it can answer `ask_user` and
`update_plan`, so the model is offered both.

- **Questions** appear above the composer: options, a text field, Send and
  Skip. Typing in the composer while a question is open answers it.
- **The plan** is a checklist above the composer while steps are open. It is
  kept in `.yellowscript/PLAN.md` (a task list you can edit), and a new chat
  in the workspace starts with it while any step is open.
- **The turn limit** (`agent.maxTurns`, 40) asks before going on, instead of
  stopping silently.

### A run that is going nowhere

The loop watches each call and the streaming reply, and notices:

| Check | What it sees |
|---|---|
| same failure | the same error 3 times in recent rounds (numbers and paths ignored), or one command failing 3 times with other flags and nothing changed |
| oscillation | a file written back to a version it had before |
| no progress | about 6 rounds with no new error, write or file |
| reasoning loop | while a reply streams: the same sentences over and over |
| theorizing | long reasoning, or many "actually, wait" reversals, with nothing new from a tool |
| argument loop | while a tool call streams: its arguments repeating one stretch |

The first firing tells the model what was seen, with a short debugging
procedure; the second pauses the repeated action until it gathers new
evidence; the third stops the run and tells you what it tried. A reply
caught looping is dropped and asked for again with the note. Each firing is
a "Changed approach: …" line in the turn. With a web tool present, the notes
also suggest looking the failure up, and a lookup is never what is paused.
A tool call repeated with identical arguments a fourth time is not run.

**Every reply is capped at 16,384 tokens** (`max_tokens`). A reply cut off
there never runs its half-written call: it is asked for once more with a
note, and a second cut-off ends the run.

**Newer than the model knows.** After the model reads a `package.json`, or
runs an install or scaffold, the result notes the dependencies whose major
version is past what a model is likely to know (agent-core `lookup.mjs`),
and that their docs are a lookup away. Once per manifest per run.

**Keeping what it learned.** When a command that failed earlier now works,
the model is asked to save how with `ys_note`.

### Long runs and the context window

Tool results are sent back on every request, so a long task would overflow a
local model's window. Once a run passes 85% of the usable window, the oldest
tool results become one-line stubs (the model can call the tool again) and
old write calls lose their big arguments, down to 50%. Your messages and the
newest results are never touched. What the run found (files changed, open
errors, what reads and searches showed, notes, the open plan) then rides at
the end of each request. The window size comes from llama-server's `/props`;
a request refused as too large anyway is trimmed harder and sent once more.

## Workspace tools (`ys_*`)

All local tools are `ys_`-prefixed, so they never collide with Nest's.
Arguments are parsed forgivingly (an empty string is `{}`; malformed JSON is
repaired where it can be, and otherwise returned as an error the model can
act on).

### Read-only

| Tool | What it does |
|---|---|
| `ys_read_file` | A file's content, truncated at 20k characters. Over 400 lines without `offset`: its outline and first 80 lines. |
| `ys_outline` | A file's functions, classes and methods with line ranges. |
| `ys_find_symbol` | Where a name is defined (up to 20). |
| `ys_references` | Every use of a symbol (up to 40). |
| `ys_list_directory` | A folder's entries with sizes and types. |
| `ys_glob` | Files by glob pattern (ripgrep, with a fallback). Names matching folders when no file matches. |
| `ys_grep` | File contents by regex (ripgrep, with a fallback). |
| `ys_diagnostics` | VS Code's errors, warnings and hints, with locations. |
| `ys_editor_context` | The open file, cursor, selection, and open files. |
| `ys_check_page` | Loads a `localhost` URL or workspace HTML file in headless Edge/Chrome/Chromium: exceptions, console errors, failed requests, canvases and visible text, and a screenshot (to the model only if it reads images). Up to 20 `steps` act on the page (`key`, `click`, `type`, `wait_for`, `inspect`…); `eval` reads a value afterwards. `YELLOWSCRIPT_BROWSER` picks the browser. |

### Writes (reviewed, checkpointed)

| Tool | What it does |
|---|---|
| `ys_replace` | Replace exact text (`old_string` → `new_string`): the edit local models get right. |
| `ys_write_file` | Write a whole file. |
| `ys_edit_file` | Edit by unified diff. Only with `tools.unifiedDiff`: small models get diffs wrong. |
| `ys_delete_file` | Delete a file. Always asks. |
| `ys_move_file` | Move or rename a file. |
| `ys_note` | Replace one `## section` of `.yellowscript/NOTES.md`, which goes with every request (up to 1,500 characters). |

An applied write's result ends with the errors and warnings the language
server now reports in the files it wrote.

### Commands

| Tool | What it does |
|---|---|
| `ys_run_command` | A shell command (cmd.exe on Windows, `/bin/sh` elsewhere). The result starts with its exit code. `timeout_s` up to 900. One-shot commands run with `CI=1` (`commands.nonInteractive`). |
| `ys_process` | Background commands (a dev server, a watcher): `start` waits up to 5s for the address it prints; `output` reads what it printed since; `stop` ends it and its process tree. All stop when the window closes. |

Output streams into the **Yellowscript Commands** output channel. A command
that ends on a prompt nobody can answer is reported as such, with a hint to
pass the non-interactive flag. npm, pnpm, yarn and bun are refused when the
nearest `package.json` is outside the workspace; the refusal names the
projects to pass as `cwd`.

**What runs without asking:**

- **Read-only** (`commands.builtInSafe`): listing, reading and searching
  workspace files (`dir`, `type`, `findstr`, `ls`, `cat`, `grep`, `rg`,
  `find` without `-exec` or `-delete`), versions, package facts (`npm ls`,
  `npm view`), read-only git (`status`, `diff`, `log`, `show`, `blame`), and
  `node --check`. Git runs with hooks, fsmonitor, external diffs and the
  pager turned off.
- **The project's own checks** (`commands.autoRunProjectChecks`): its `test`,
  `build`, `lint`, `typecheck`, `check` and `format:check` scripts (unless
  this run changed them), a `dev`, `start`, `serve` or `preview` script in
  the background, locally installed `vitest run`, `jest`, `eslint`,
  `prettier --check` and `playwright test`, and `pytest`, `ruff check`,
  `mypy`, `cargo` and `go` checks.
- **A prefix you allowed** (`allowedCommands`), added by **Always allow**.
- **An `&&` chain** whose every part would run on its own; a leading `cd`
  into a workspace folder moves where the rest is judged from. When exactly
  one part asks, **Always allow** is offered for that part. `2>&1` and
  `2>nul` are ignored when a line is judged.

Everything else asks: a pipe, `;`, `||`, a redirect, a variable
(`$HOME`, `%USERPROFILE%`, `~`), a path outside the workspace, inside
`.git`, or a secrets file, or a search of a folder that holds one. **Always
allow** is never offered for `git push`, `git reset --hard`, `git clean`,
`git restore`, a recursive delete, or ending a process. A command's card and
output-channel line name the rule that let it run. Credentials in URLs are
masked in what the model reads.

The read tools can read outside the workspace after asking: **Allow this
time**, **Always for this folder** (kept in `extraReadRoots`), or **Deny**.
Never writing there, and never the home folder itself, the folders above it,
`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.docker` or the system
folders.

## Write approval and checkpoints

Before any write is applied, Yellowscript commits the pre-write state of every
file it touches into a shadow git repository,
`<workspace>/.yellowscript/shadow`, separate from any git the workspace has.
It asks on a card in the chat, listing the files; each file's diff opens in
VS Code's diff editor. Commands and Nest's tools ask on the same card.

The choices are **Apply**, **Apply all in this task**, **Always allow edits**
(per workspace; never offered for a deletion), and **Reject**. Stopping the
run denies anything still waiting. The checkpoint is taken even when a write
needs no prompt. Deleting `.yellowscript/shadow` only loses the ability to
revert earlier writes; a new one is made on the next write.

**Revert Last Write** restores the most recent checkpoint. **Revert Last
Task** undoes every write of the last task, newest first, and removes the
files it created. A run that changed files ends with a summary: each file
(click it for its diff since the run began), the commands with their exit
codes, the processes it started, and **Revert this task** on the newest.

**Protected paths.** Writes inside `.git`, to the shadow repository, or to
Yellowscript's own `redstartYellowscript.*` settings are refused. Changes to
`.vscode/settings.json`, a `.code-workspace` file, `.vscode/tasks.json` or
`launch.json`, and to `package.json`'s `scripts`, always ask. Reading a
`.env` file, a key or a credentials file (`.npmrc`, `.netrc`, `id_rsa`) asks
first, and search skips them, since what a read returns goes to the model and
into the saved chat.

## Nest's tools (MCP)

Yellowscript lists the Nest's MCP servers from `/redstart/mcp-servers` on
every (re)connect, and speaks MCP's Streamable HTTP transport to the URL it
gives: one session per connection, reopened if Nest restarts. Nest's tools
are merged with the `ys_*` set and tagged **Nest**. Server-banned tools are
greyed out and stripped server-side; Yellowscript never re-enables them.
Nest's File System tools are left out, because they work on Nest's own
folders, not the workspace: a call to one is answered with the `ys_` tool that
does the job. An unknown tool name gets "did you mean …?".

Each Nest tool carries an approval rule in its `_meta`: reads run, writes ask
unless you chose **Always allow**, destructive tools ask every time. Nest
itself refuses an unapproved destructive call from any client; when it does,
Yellowscript posts the decision you just made to `/approvals/:id` and repeats
the call, never for a call you did not approve. **Always allow** is kept on
Nest for your account, so it applies in the chat app and Twig too. The logic
is in `src/nest/approval.ts`.

## Development

### Layout

| Folder | What is there |
|---|---|
| `src/extension.ts` | Wiring only: builds one `Host` in `activate()` |
| `src/host/` | The VS Code side: sessions and editor tabs, tasks and reverts, projects and workflows, attachments, connection commands, the tool registry and MCP host |
| `src/agent/` | One chat's agent (`compose.ts`), the loop's ports (`loop.ts`), the context budget, the version note |
| `src/chat/` | The chat session, its protocol with the webview, run logs, approvals |
| `src/tools/` | The `ys_*` tools, command classification, checkpoints |
| `src/nest/` | The Nest client, discovery, MCP, approvals |
| `src/webview/` | The Svelte 5 UI; its state is a plain reducer, `view-model.ts`, tested under `node --test` |
| `src/vendor/agent-core/` | The shared loop, vendored (below) |
| `src/bench/`, `bench/` | The coding benchmark |

### agent-core is vendored

`src/vendor/agent-core/` is a copy of redstart-project's `shared/agent-core/`,
pinned to the commit in `VENDORED.json` and never edited here. `npm run check`
fails if a file differs from its recorded hash. A change to the loop goes to
redstart-project first, then comes back with a sync:

```bash
npm run sync:agent-core -- ../redstart-project origin/main   # re-sync at a ref
```

`src/agent/agent-core.ts` re-types its exports against the core's own
`types.d.ts`, so a signature change upstream is a compile error here.

### Two TypeScript projects

`tsconfig.json` is the extension host (Node types, no DOM) and
`tsconfig.webview.json` the webview (DOM, no Node types). `npm run typecheck`
runs both, plus `svelte-check`.

### The test boundary

The core modules (`connection.ts`, `nest/`, `chat/`, `tools/`, `agent/`)
import no `vscode` API, so they run under plain `node --test`. `vscode`
imports are confined to `extension.ts`, `storage.ts`, `host/` and `ui/`.
TypeScript parameter properties (`constructor(private readonly x: T)`) are
not usable under `src/`: Node's type stripping erases types but does not
transform code.

### Webview security

The webview treats model output as hostile: a strict nonce-based CSP, no
external origins, `localResourceRoots` limited to `media/` and `dist/`, a
markdown renderer that escapes before it formats, and no secrets across the
boundary.

### Against a live Nest

```bash
YELLOWSCRIPT_TEST_LIVE_NEST=https://<your-nest-name> \
YELLOWSCRIPT_TEST_TOKEN=rst_... \
npm run smoke
```

`smoke` checks the beacon, `/auth/config`, `/auth/me`,
`/redstart/mcp-servers`, `/v1/models` and that unauthenticated requests are
refused. `npm run live` (same variables) checks what needs the real model:
`/props` reports `n_ctx`, an oversized request comes back with llama-server's
numbers, a real tool round trip, and a dev server that starts, is checked
with `ys_check_page`, and stops with its whole process tree.

### The coding benchmark

```bash
YELLOWSCRIPT_TEST_LIVE_NEST=... YELLOWSCRIPT_TEST_TOKEN=rst_... \
npm run bench -- --label "qwen3.6-35b Q4_K_XL"   # the core tasks
npm run bench -- --task long-context-reads       # one task
npm run bench -- --tag milestone                 # the long ones
npm run bench -- --list                          # no Nest needed
npm run bench -- --catalog full,core,core+nest   # the tool catalog comparison
npm run bench -- --no-stagnation                 # without the stuck-run checks
npm run bench -- --no-diagnostics                # without diagnostics after writes
npm run bench:cache                              # once: node_modules for Crestline
```

Each task in `bench/tasks/<id>/` is a workspace, a prompt (`task.json`) and a
`check.mjs` that scores the result. The run is the product's own agent
(`agent/compose.ts`) against the real Nest, in a temp copy of the workspace,
with a headless host: writes apply, commands run inside the copy, `ask_user`
gets the task's scripted answers, and diagnostics come from the TypeScript
language service, or `svelte-check` in a Svelte project. Results go to
`bench/results/<stamp>-<label>/`; the last row of its `summary.md` goes in
[bench-results.md](bench-results.md). Every task also has a `reference/`
solution, and `npm test` proves each check fails on the untouched workspace
and passes on the reference.
