<p align="center">
  <img src="media/icon.png" alt="The Redstart bird perched on a yellow pencil" width="128" />
</p>

# Redstart Yellowscript

A VSCode coding-agent extension that connects to a **local Redstart Nest** —
the private, on-premises AI server — instead of a cloud API. Zero-config
network discovery, Redstart account authentication, streaming chat in editor
tabs, and workspace-aware tools the model can drive.

> **Status:** connect and sign in (password swapped for an app key, or an API
> key), streaming chat in editor tabs, workspace tools with
> diff review and checkpoints, Nest's tools with their approvals, the shared
> agent-core loop with questions and plans, and Nest projects and workflows.

## Why not just point a generic client at the Nest?

You can — Nest speaks the OpenAI-compatible API and that path works today.
Yellowscript exists for what that path can't do:

- **Zero-config connection.** It finds the Nest by its LAN discovery beacon and
  signs in with a Redstart account, instead of a hand-typed base URL and a
  pasted key.
- **Tolerance for local models.** Nest drives quantized MoE models on consumer
  GPUs, and those emit tool calls in half a dozen malformed shapes — Python
  kwargs, bare argument objects, calls buried in a reasoning block. A generic
  client drops those, and the model then *narrates* work it never did.
  Yellowscript inherits Nest's recovery parsing.
- **Real Nest integration.** It consumes the Nest's own MCP tools, respects the
  server-side tool bans and write/destructive policy, and shows Redstart
  identity in the IDE.
- **Security-first.** Credentials live in VSCode `SecretStorage`, the webview
  runs under strict CSP, and no secrets cross the webview boundary.

## Getting started

```bash
npm install
npm run check      # typecheck + unit tests
npm run build      # bundle to dist/extension.cjs
```

Press <kbd>F5</kbd> in VSCode to launch an Extension Development Host.

Then run **Yellowscript: Connect to Nest** from the command palette. With a
Nest running on your network, that is all the configuration there is.

## Commands

| Command | What it does |
|---|---|
| `Yellowscript: Open Chat` | Bring up the chat used last, or a new one (also a click on the status bar when connected) |
| `Yellowscript: New Chat` | A new chat in an editor tab of its own |
| `Yellowscript: Connect to Nest` | Discover (or use the configured URL) and connect |
| `Yellowscript: Disconnect` | Drop the connection and stop auto-reconnecting |
| `Yellowscript: New Chat in Editor Tab` | A new chat in its own editor tab (also the bird button in the editor title bar). Each tab is its own chat: drag it to another group, split it, or move it to a new window. It reopens on its chat after a reload |
| `Yellowscript: Choose Project` | Link this workspace to a Nest project |
| `Yellowscript: Run Workflow` | Pick one of your Nest workflows |
| `Yellowscript: Sign In to Nest` | Username and password (swapped at once for a key Nest issues to this app), or paste an `rst_` API key |
| `Yellowscript: Sign Out` | Forget the stored credential, keep the server connection |
| `Yellowscript: Show Connection Status` | Details view plus the next useful action |
| `Yellowscript: Inspect Workspace Tools` | Run all `ys_*` tools with probe args and dump results to the output channel |
| `Yellowscript: Revert Last Write` | Restore files from the most recent approved write via the shadow checkpoint |
| `Yellowscript: Show the Chat Waiting for You` | Bring the chat that waits on an approval or a question to the front (also the status bar's bell) |
| `Yellowscript: Add to Yellowscript` | The editor's selection (or the current line) as a chip in the composer; also in the editor's context menu |
| `Yellowscript: Revert Last Task` | Undo every write of the last task, newest first; files it created are removed |
| `Yellowscript: Open Settings` | Open Yellowscript's Settings page in the chat panel |

The **gear icon** in the chat's toolbar opens
the same page. It writes the settings below: allow lists and the Nest address
to this workspace, the rest to your user settings unless this workspace
already sets them.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `redstartYellowscript.serverUrl` | `""` | Explicit gateway URL (e.g. `http://192.168.1.20:19080`). When set, discovery is skipped entirely. |
| `redstartYellowscript.discovery.enabled` | `true` | Scan the LAN on connect. |
| `redstartYellowscript.discovery.timeoutMs` | `400` | Per-host beacon timeout (50–5000 ms). Raise on a slow network. |
| `redstartYellowscript.autoConnect` | `true` | Reconnect to the last-used Nest when a window opens. |
| `redstartYellowscript.editorButton` | `true` | Show the button in the editor title bar that opens the chat as an editor tab. |
| `redstartYellowscript.agent.maxTurns` | `40` | Model round trips per message before asking whether to keep going (5–500). A repeated identical tool call is stopped sooner. |
| `redstartYellowscript.commands.builtInSafe` | `true` | Run read-only commands (`git status`, `cat`, `rg`) without asking. |
| `redstartYellowscript.commands.autoRunProjectChecks` | `true` | Run the project's test, build and lint scripts and a dev server without asking. |
| `redstartYellowscript.extraReadRoots` | `[]` | Folders outside the workspace the read tools may read. |
| `redstartYellowscript.allowedCommands` | `[]` | Command prefixes that run without asking in this workspace (`npm test`). Chained, piped or redirected lines always ask. |
| `redstartYellowscript.notifyWhenWaiting` | `true` | Notify when a chat waits for you, or a long run finishes, while the window is not focused. |
| `redstartYellowscript.tools.unifiedDiff` | `false` | Offer `ys_edit_file` (unified diffs) to the model. |
| `redstartYellowscript.approvedWriteTools` | `[]` | Write tools to always allow without prompting (`ys_write_file`, `ys_edit_file`). |

A password is used once: Yellowscript signs in, has Nest issue a key for this
app (surface `yellowscript`, labelled with this machine's name), ends the
session, and keeps only the key. The key survives a Nest restart, which a
session did not, and you can revoke it in the chat app. The signed-in account
also shows in VS Code's **Accounts** menu, with Sign Out there.

Credentials are **never** settings. They live in VSCode's `SecretStorage`,
keyed per server, and never enter a log line or the model's context.

## Connection & discovery

Yellowscript scans the local network on port **8765** for a Nest beacon. When
found, it connects to the Nest's gateway and authenticates. If no Nest is
discovered, set `serverUrl` manually and discovery is skipped.

Connection states: `disconnected` → `discovering` → `connecting` →
`unauthenticated` / `connected` / `error`.

Auto-connect reconnects to the last-used Nest on window open silently — no
scan, no error popup. If the Nest is off, the status bar shows a quiet
disconnected state.

## Chat & conversations

Each chat is an **editor tab**, with its own transcript, AbortController, and
prompt queue. VSCode's tab row is the list of open chats; streaming carries on
in a tab you have switched away from. Closing a tab puts its chat in History
(a blank one is deleted); a run still going carries on, and History lists it
as running.

- **Title bar** above each chat shows its title and a busy dot, with New chat,
  Workflows, History and Settings.
- **Streaming** uses two channels: `content` (visible answer) and `reasoning`
  (thinking, starts collapsed).
- **Prompt queuing**: while a turn runs, new prompts queue behind it and drain
  sequentially.
- **Auto-titled** from the first user prompt (truncated to 40 characters).
- Transcripts are saved on every message, turn end, and conversation switch.
- **Drafts**: what you have typed and not sent is kept per conversation,
  across tab switches and reloads. Closing a chat that holds only a draft
  sends it to history; closing an empty one deletes it.
- **Tool cards** show each call on its turn: status, arguments, the one-line
  result, a **Nest** tag for tools that ran on the server, and **recovered**
  when the model wrote the call as text. A finished turn with four or more
  calls folds them into one "Used N tools" row.

### Projects and workflows

- **Project.** Link the workspace to one of your Nest projects with the chip
  under the message box (or **Yellowscript: Choose Project**). Every request
  then names it, and Nest adds the project's instructions and memories. Chats
  stay in the workspace; the project is what Yellowscript shares with the chat
  app, Twig and Greenhouse. The link is per workspace, and only counts for the
  Nest and account it was made with.
- **Workflows.** Type `/` in the message box, or use the bolt icon (or
  **Yellowscript: Run Workflow**). These are the saved instructions from the
  chat app's Workflows page, personal and organization. Nest composes the text
  from its own copy; a workflow with inputs asks for them first.

### Questions, plans and the turn limit

Yellowscript declares to Nest that it can answer `ask_user` and `update_plan`,
so the model is offered both (agent-core runs them; see below).

- **Questions** appear above the composer: options to pick, a text field, Send
  and Skip. Up to four asked together are one card with a tab each. Typing in
  the composer while a question is open answers it (all of them, on a tabbed
  card).
- **The plan** is a checklist above the composer, open while steps are open.
  It is saved with the conversation and sent with each request while steps are
  open; the × clears it, so a plan you have moved on from stops steering. It
  is also kept in `.yellowscript/PLAN.md` (a task list you can edit), and a new
  conversation in the workspace starts with it while any step is open.
- **The turn limit** (`agent.maxTurns`, 40 by default) asks before going on,
  instead of stopping silently. A tool call repeated with identical arguments
  a fourth time is not run; the model is told to change approach.
- **A run that is going nowhere** is noticed before the turn limit: the same
  error three times (even with other flags or at another line), a file
  written back to how it was, six rounds that find nothing new, reasoning
  that goes in a circle while it streams, or long theorising with nothing new
  from a tool. The first time, the model is told what was seen and given a
  short debugging procedure; the second time, the repeated action is paused
  until it gathers new evidence; the third time, the run stops and says what
  it tried. Each shows in the turn as a "Changed approach: …" line.
- **What a long run learned** is kept when old results are trimmed to fit the
  context window: files changed, open errors, what reads and searches found,
  notes and the open plan steps ride at the end of each request.

### Images, files and selections

- **Images:** paste or drop them into the composer (up to 4 a message,
  downscaled to 1,280px). They go to the model only when it reads images
  (llama-server's `/props`); otherwise the composer says so.
- **`@file`:** type `@` and part of a path to pick a workspace file. It
  goes with the message as its content, or as its outline when it is over
  300 lines; the bubble shows a chip. Secrets files are not offered.
- **Selections:** **Add to Yellowscript** in the editor's context menu adds
  the selected lines as a chip. **Fix with Yellowscript**, a quick fix on an
  error or warning, sends the problem with the lines around it.

### When a run needs you, or was cut off

When the window is not focused and a chat starts waiting (an approval, a
question, the turn limit), a notification names the chat, with **Show**; the
status bar shows a bell until it is answered. A run of over two minutes that
finishes unwatched says so too. `notifyWhenWaiting` turns the notifications
off.

A reload or a crash ends a run and stops its processes. The chat keeps a
record while a run goes, so on the next load it shows **This task was
interrupted** with **Continue** (and **Restart and continue** when it had
processes running, such as a dev server) or **Dismiss**. What the run had
already done is in its log, so Continue starts from there.

### Long runs and the context window

A run's tool results are sent back on every request, so a long task would
overflow a local model's window. Before each request, once the run passes
85% of the usable window, the oldest tool results become a one-line stub
(the model can call the tool again) and old write calls lose their big
arguments, down to 50%. Your messages and the newest few are never touched.
The window size comes from llama-server's `/props`; if a request is refused
as too large anyway, Yellowscript trims harder and retries once. Each trim is
logged to the output channel.

Every request with tools also starts with a short note about the workspace:
its `AGENTS.md` (or `CLAUDE.md`), the model's own notes
(`.yellowscript/NOTES.md`, kept with `ys_note`), and a two-level file tree.

Across messages, only your words and the assistant's answers are sent, so
each answer also carries a short log of what its run did: files created,
changed, moved or deleted, commands and their exit codes, processes started
and their address, the last page check's first problem. Rejected writes and
commands are listed as rejected. Logs older than the last six answers shrink
to one line. What is running right now (`p1 "npm run dev" →
http://localhost:5173`) goes on your newest message.

The webview is Svelte 5 (`src/webview/components/`). Its state is a plain
reducer, `src/webview/view-model.ts`, tested under `node --test`; the
components only read it and post what you did.

## Workspace tools (`ys_*`)

All tools are `ys_`-prefixed to avoid collisions with Nest's MCP tools.
Arguments arrive as raw strings; the registry parses them forgivingly (empty
string → `{}`, malformed JSON → descriptive error).

### Read-only tools

| Tool | Description |
|---|---|
| `ys_read_file` | Read a file's content (workspace-relative). Truncated at 20k characters. A file over 400 lines read without `offset` returns its outline and first 80 lines; then read a range. |
| `ys_outline` | A file's functions, classes and methods with line ranges, from the language server; for HTML, CSS, Markdown and the like, from the text. |
| `ys_find_symbol` | Where a name is defined in the workspace (up to 20). |
| `ys_references` | Every use of a symbol, with the line (up to 40). By name, or by path and line; an ambiguous name lists the candidates. |
| `ys_list_directory` | List files in a workspace directory with sizes and types. |
| `ys_glob` | Match files by glob pattern. Uses ripgrep when available; falls back to literal matching. |
| `ys_grep` | Search file contents by regex. Uses ripgrep when available; falls back gracefully. |
| `ys_diagnostics` | Return all VSCode diagnostics (errors, warnings, info, hints) with location and message. |
| `ys_editor_context` | Return active editor state: open file, language, dirty status, cursor, selection, and open files. |
| `ys_check_page` | Load a `localhost` URL or a workspace HTML file in headless Edge/Chrome/Chromium; report exceptions, console errors, failed requests, the canvases and visible text. The screenshot is saved to `.yellowscript/screenshots/`, and given to the model only if it reads images. Set `YELLOWSCRIPT_BROWSER` to pick a browser. Up to 20 `steps` act on the page after load (`key` with `hold_ms`, `click` a selector or `[x, y]`, `type` `into`, `wait_ms`, `wait_for`, `screenshot`, `inspect` an element's box, visibility and styles); `eval` reads a value afterwards (a game's `window.__game`); `viewport` loads it at `390x844`. Errors are tied to the step before them. |

### Write tools (with shadow-git checkpoint)

| Tool | Description |
|---|---|
| `ys_replace` | Propose replacing exact text (`old_string` → `new_string`), unique unless `replace_all`. The edit local models get right. |
| `ys_write_file` | Propose writing a complete file (new or full replacement). Checkpointed for revert. |
| `ys_edit_file` | Propose editing a file via unified diff. Offered only with `tools.unifiedDiff`; small models get diffs wrong. |
| `ys_delete_file` | Propose deleting a file. Always reviewed, whatever has been allowed. |
| `ys_move_file` | Propose moving or renaming a file. |
| `ys_note` | Propose replacing one `## section` of `.yellowscript/NOTES.md`, the model's notes on the project (how to run and check it, where things live, decisions, known problems). The notes go with every request, after `AGENTS.md`, up to 1,500 characters; the sections left out are named. |

An applied write's result ends with the errors and warnings the language
server now reports in the files it wrote.

### Command tools

| Tool | Description |
|---|---|
| `ys_run_command` | Propose a shell command; it runs after approval and the result starts with its exit code, then stdout and stderr. `timeout_s` (default 120, max 900). |
| `ys_process` | Background commands (a dev server, a watcher). `action: "start"` proposes one, with the same approval, and waits up to 5s for the address it prints (`p1 is serving http://localhost:5173`) or for it to exit; `"output"` reads what it printed since the last read (`wait_s` to wait); `"stop"` ends it. All of them stop when the window closes. |

Commands run with your shell and environment; their output streams into the
**Yellowscript Commands** output channel. Some run without asking:

- **Read-only** (`commands.builtInSafe`): listing and reading workspace
  files (`ls`, `dir`, `cat`, `type`, `head`), searching (`grep`, `rg`,
  `findstr`, `find` without `-exec` or `-delete`), versions, package facts
  (`npm ls`, `npm view`), read-only git (`status`, `diff`, `log`, `show`,
  `blame`, listing branches), `node --check` and `npx tsc --noEmit`. Git
  runs with hooks, fsmonitor, external diffs and the pager turned off.
- **The project's own checks** (`commands.autoRunProjectChecks`): the
  `test`, `build`, `lint`, `typecheck`, `check` and `format:check` scripts
  that exist in `package.json` (unless this run changed them), a `dev`,
  `start`, `serve` or `preview` script in the background, locally installed
  `vitest run`, `jest`, `eslint`, `prettier --check` and `playwright test`,
  and `pytest`, `ruff check`, `mypy`, `cargo` and `go` checks.

Everything else asks. A line that chains, pipes, redirects or expands a
variable (`$HOME`, `%USERPROFILE%`, `~`) always asks, and so does one that
names a path outside the workspace, inside `.git`, or a secrets file, or
searches a folder that holds one. Such a command's card and its output-channel
line name the rule that let it run. **Always allow** on the prompt adds the
command's prefix (`npm test`, `npm run build`) to `allowedCommands` for this
workspace; it is not offered for `git push`, `git reset --hard`,
`git clean`, `git restore` or a recursive delete, which ask every time.
Credentials in URLs (`https://user:token@host`) are masked in what the model
reads.

The read tools can read outside the workspace after asking: **Allow this
time**, **Always for this folder** (kept in `extraReadRoots`), or **Deny**.
Never writing there, and never the home folder itself, the folders above it,
`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.docker` or the system
folders.

## Write approval & shadow checkpoints

Before any write is applied, Yellowscript snapshots the pre-write state of
every affected file into a shadow git repo (`<workspace>/.yellowscript/shadow`).
It asks on a card in the chat, listing the files; each file's diff opens in
VS Code's diff editor from the card. Commands and Nest's tools ask on the same
card, one at a time.

The user chooses **Apply**, **Apply all in this task** (later writes in the
same run apply without asking), **Always allow edits** (remembered per
workspace; never offered for a deletion), or **Reject**. A deletion always
asks. Stopping the run denies anything still waiting. The checkpoint is always
taken even when auto-approval bypasses the prompt.

**Revert Last Write** restores files from the most recent checkpoint.
**Revert Last Task** undoes every write of the last task, newest first, and
removes the files it created.

Some paths are protected, whatever has been allowed. Writes inside `.git`
(its config and hooks are programs git runs), to the checkpoint repository,
or to Yellowscript's own `redstartYellowscript.*` settings are refused. Other
changes to `.vscode/settings.json`, a `.code-workspace` file,
`.vscode/tasks.json` or `launch.json`, and a change to `package.json`'s
`scripts`, always ask, like a deletion. Reading a `.env` file, a key or a
credentials file (`.npmrc`, `.netrc`, `id_rsa`) asks first, and search skips
them, since what a read returns goes to the model and into the saved chat.

When a run writes files or runs commands, its answer ends with a summary:
each file it changed (click one for its diff since the run began, read from
the checkpoint, so it works after a reload), the commands with their exit
codes, and the processes it started with their address. The newest such
summary has **Revert this task**.

## MCP tools (Nest integration)

Yellowscript discovers the Nest's MCP tools via `/redstart/mcp-servers` on
every (re)connect, and speaks MCP's Streamable HTTP transport to the URL it
gives (`…/mcp`): one session per connection, reopened if Nest restarts. Server-banned tools are greyed out in the UI and stripped
from completions requests server-side — the extension never re-enables them
client-side.

Nest tools are merged with the local `ys_*` set (disjointness asserted) and
tagged `(ran on Nest)` in summaries.

### Approvals for Nest's tools

Each Nest tool carries an approval rule in its `_meta`: reads run, writes ask
unless you have chosen **Always allow**, and destructive tools ask on every
call. Yellowscript asks on the chat's approval card before the call reaches Nest.

Nest itself refuses an unapproved destructive call, from any client. When it
does, Yellowscript posts the decision you just made to `/approvals/:id` and
repeats the call with the approval's id. It never answers that exchange for a
call you did not approve in the prompt for that call. **Always allow** is kept
on Nest for your account, so it applies in the chat app and Twig too, and you
revoke it from the chat app's settings. The logic is in `src/nest/approval.ts`.

## Development

```bash
npm test           # node --test over .ts sources — no build, no test deps
npm run typecheck  # tsc --noEmit on both tsconfig.json and tsconfig.webview.json
npm run check      # typecheck + unit tests
npm run watch      # esbuild in watch mode (used by F5)
npm run build      # esbuild production bundle
npm run smoke      # live Nest smoke test
npm run icons      # regenerate media/ icons from assets/mascot/
npm run package    # check + build + vsce package
```

### The agent loop is agent-core

The loop (turns, the per-reply call limit, recovering calls a model wrote as
text, `ask_user`, `update_plan` and its completion check, noticing a stuck run,
the working state) is the same code
chat-ui, the agent bench and Nest's task runner run: redstart-project's
`shared/agent-core/`. It is copied into `src/vendor/agent-core/`, pinned to a
commit recorded in `VENDORED.json`, and never edited here. `src/agent/loop.ts`
supplies its ports, and `src/agent/agent-core.ts` gives it TypeScript types.

```bash
npm run sync:agent-core -- ../redstart-project origin/feat/agent-core   # re-sync at a ref
node scripts/sync-agent-core.mjs --check    # part of npm run check: fails on a local edit
```

A behaviour change to the loop goes to redstart-project first, then comes back
with a sync.

### Two TypeScript projects

- `tsconfig.json` — extension host (Node types, no DOM)
- `tsconfig.webview.json` — webview entry (DOM, no Node types)

`npm run typecheck` runs both. Keeping them separate prevents host code from
reaching for `document` and still typechecking.

### Core-module test boundary

The core modules (`connection.ts`, `nest/*`, `chat/*`, `tools/*`, `agent/*`)
import no `vscode` API — they are plain Node and testable without an extension
host. `vscode` imports are confined to `extension.ts`, `storage.ts`, and `ui/`.

One consequence: TypeScript parameter properties
(`constructor(private readonly x: T)`) are **not usable** under `src/` —
Node's native type stripping erases types but does not transform code.

### Webview security

The webview renders model output as a hostile document: strict nonce-based CSP,
no external origins, `localResourceRoots` limited to `media/` and `dist/`,
markdown renderer that escapes input before applying any rule, and no secrets
ever cross the webview boundary.

### Verifying against a live Nest

```bash
YELLOWSCRIPT_TEST_LIVE_NEST=http://192.168.1.20:19080 \
YELLOWSCRIPT_TEST_TOKEN=rst_... \
npm run smoke
```

Checks: beacon payload, `/auth/config`, `/auth/me`, `/redstart/mcp-servers`,
`/v1/models`, and unauthenticated rejection. Run before every release.

`npm run live` (same two variables) checks what needs the real model and
machine: `/props` reports `n_ctx`, an oversized request comes back with
llama-server's context numbers, one real tool round trip, and a background
dev server that starts, is checked with `ys_check_page`, and stops with its
whole process tree.

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
(`agent/compose.ts`: the same session, workspace message, run log, loop and
tools) against the real Nest, in a temp copy of the workspace, with a
headless host: writes apply, commands run (on this machine, inside the copy),
`ask_user` gets the task's scripted answers, and diagnostics come from the
TypeScript language service, or `svelte-check` in a Svelte project. A task
that names `nodeModules` gets a copy of the packages `npm run bench:cache`
installed from its lockfile, so it runs offline and the same way every time.
Results go to
`bench/results/<stamp>-<label>/` (`runs.jsonl`, and `summary.md`, ending with
the row for [docs/bench-results.md](docs/bench-results.md)).

Every task also has a `reference/` solution, and `npm test` proves each check
fails on the untouched workspace and passes on the reference, so a task can
neither be passed by doing nothing nor be impossible.

## Relationship to the rest of the ecosystem

- **Nest owns**: auth, models, providers, discovery, MCP server, wire format
- **Yellowscript owns**: IDE-domain logic — workspace context, editor
  integration, diffs, agentic UX, tool approval UI

A few files here are **vendored** from `redstart-project` rather than imported,
since that is a separate repo — each carries a header naming its origin and the
commit it came from. Keep those headers current when you re-sync.
