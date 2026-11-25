<p align="center">
  <img src="media/icon.png" alt="The Redstart bird perched on a yellow pencil" width="128" />
</p>

# Redstart Yellowscript

A coding agent for VS Code that runs on a **Redstart Nest**, the private AI
server on your own network, instead of a cloud API. It finds the Nest by
itself, signs in with your Redstart account, and gives the model tools to
read, search, edit and run your project, with every change reviewed and
undoable.

**Why not point a generic client at the Nest?** Nest speaks the
OpenAI-compatible API, and that works. Yellowscript is for what that path
cannot do:

- **No setup.** It finds the Nest on the network, over HTTPS when the Nest
  serves it, and signs in with a Redstart account rather than a hand-typed
  URL and a pasted key.
- **Built for local models.** Quantized models on consumer GPUs write tool
  calls in malformed shapes, loop, and stall. Yellowscript recovers the
  calls, notices a run that is going nowhere, and caps a reply that runs
  away.
- **Real Nest integration.** It uses the Nest's own tools with their
  approval rules, your Nest projects and workflows, and web search when the
  Nest offers it.
- **Safe by default.** Every write is a reviewed diff with a checkpoint,
  commands that change things ask first, and credentials stay in VS Code's
  secret storage.

## Install

Yellowscript is not on the Marketplace. Install the `.vsix` from a
[release](https://github.com/ImDeadWeight/redstart-yellowscript/releases),
or build it:

```bash
npm install
npm run package          # check, build, and redstart-yellowscript-<version>.vsix
code --install-extension redstart-yellowscript-<version>.vsix --force
```

Reload open windows (*Developer: Reload Window*). It needs VS Code 1.90 or
later, and a Redstart Nest on your network or this machine.

## First run

1. Open a folder. The agent's tools work in the open workspace, and refuse
   without one.
2. Run **Yellowscript: Connect to Nest** from the command palette, or click
   the status bar. It finds the Nest and asks you to sign in. Your password
   is used once, swapped for a key Nest issues to this app.
3. **Yellowscript: Open Chat**, and ask for something.

The agent asks before anything that changes your project: a card in the chat
shows the diff or the command, with **Apply** (or **Run**) and **Reject**.
Read-only commands and the project's own checks (its `test`, `build` and
`lint` scripts) run without asking. Everything it writes can be undone with
**Revert this task** at the end of its answer.

If discovery finds nothing, set `redstartYellowscript.serverUrl` to the
Nest's address.

## Commands

| Command | What it does |
|---|---|
| Open Chat | The chat used last, or a new one (also the status bar when connected) |
| New Chat | A new chat in its own editor tab (also the bird in the editor title bar) |
| Open History | Chats that are not open in a tab |
| Connect to Nest / Disconnect | Find the Nest (or use `serverUrl`) and connect; disconnect and stop reconnecting |
| Sign In to Nest / Sign Out | A password (swapped for an app key) or an `rst_` API key; forget it |
| Show Connection Status | Where it is connected, as whom, and the next useful step |
| Choose Project | Link this workspace to a Nest project |
| Run Workflow | One of your Nest workflows (or type `/` in the chat) |
| Add to Yellowscript | The selection as a chip in the chat (also in the editor's context menu) |
| Fix with Yellowscript | A quick fix on an error or warning: sends it with the lines around it |
| Revert Last Write / Revert Last Task | Undo the last write, or every write of the last task |
| Show the Chat Waiting for You | The chat waiting on an approval or a question (also the status bar's bell) |
| Open Settings | Yellowscript's settings page (also the gear in the chat) |
| Inspect Workspace Tools | Run every `ys_*` tool once and log the results |

Each chat is an editor tab: drag it, split it, move it to another window.
Chats are saved per workspace.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `redstartYellowscript.serverUrl` | `""` | The Nest's address. When set, discovery is skipped. |
| `redstartYellowscript.discovery.enabled` | `true` | Scan the local network on connect. |
| `redstartYellowscript.discovery.timeoutMs` | `400` | Per-host timeout for the scan (50–5000 ms). |
| `redstartYellowscript.autoConnect` | `true` | Reconnect to the last Nest when a window opens. |
| `redstartYellowscript.agent.maxTurns` | `40` | Model round trips per message before asking whether to go on (5–500). |
| `redstartYellowscript.commands.builtInSafe` | `true` | Run read-only commands (`git status`, `dir`, `rg`) without asking. |
| `redstartYellowscript.commands.autoRunProjectChecks` | `true` | Run the project's test, build and lint scripts, and a dev server, without asking. |
| `redstartYellowscript.commands.nonInteractive` | `true` | Run one-shot commands with `CI=1`, so tools skip their prompts and test runners skip watch mode. |
| `redstartYellowscript.allowedCommands` | `[]` | Command prefixes that run without asking in this workspace (`npm test`). Added by **Always allow**. |
| `redstartYellowscript.extraReadRoots` | `[]` | Folders outside the workspace the read tools may read. |
| `redstartYellowscript.approvedWriteTools` | `[]` | Write tools always allowed in this workspace. |
| `redstartYellowscript.tools.unifiedDiff` | `false` | Offer `ys_edit_file` (unified diffs). Small models get diffs wrong. |
| `redstartYellowscript.notifyWhenWaiting` | `true` | Notify when a chat waits for you, or a long run finishes, while the window is not focused. |
| `redstartYellowscript.editorButton` | `true` | The new-chat button in the editor title bar. |

The settings page writes the allow lists and the Nest address to this
workspace, the rest to your user settings. Credentials are never settings.

## What the agent does

- **Tools.** It reads, searches and navigates the workspace (`ys_read_file`,
  `ys_grep`, `ys_find_symbol`…), checks diagnostics and web pages
  (`ys_diagnostics`, `ys_check_page`), writes through reviewed diffs
  (`ys_replace`, `ys_write_file`…), runs commands and dev servers
  (`ys_run_command`, `ys_process`), and keeps notes on the project in
  `.yellowscript/NOTES.md`. It also gets the Nest's tools, including web
  search, with their approval rules.
- **Plans and questions.** It keeps a checklist above the composer for
  longer tasks, and asks you when a decision is yours.
- **Recovery.** It notices a run going nowhere (the same error again, a file
  flipped back and forth, reasoning or a tool call repeating itself) and
  changes approach, then stops and tells you what it tried. Replies are
  capped at 16,384 tokens.
- **Newer than it knows.** When a project uses library versions newer than a
  model is likely to know, it is told so, and to look up their current docs.
- **Long tasks.** It fits a long run into the model's context window, and
  carries what it found when old results are trimmed.
- **Checkpoints.** Every write is committed first into a separate git
  repository in `.yellowscript/shadow`, so a task can be reverted file by
  file, after a reload too.

The details, from what runs without asking to how HTTPS discovery is
verified, are in [docs/how-it-works.md](docs/how-it-works.md).

## Development

```bash
npm install
npm run check      # agent-core hash check, typecheck (tsc + svelte-check), tests
npm test           # the tests alone: node --test over the .ts sources
npm run watch      # esbuild in watch mode (used by F5)
npm run build      # the production bundle
npm run package    # check, build and the .vsix
npm run smoke      # against a live Nest (docs/how-it-works.md)
npm run bench      # the coding benchmark (docs/how-it-works.md)
```

Press <kbd>F5</kbd> to start an Extension Development Host on
`sample-workspace/`. An installed copy and the F5 copy can both be present;
in the development host, the F5 copy wins.

The agent loop is redstart-project's `shared/agent-core`, vendored into
`src/vendor/agent-core/` and never edited here: a change goes upstream first,
then comes back with `npm run sync:agent-core`.

**Releasing.** A tag that matches `package.json`'s version, made on `main`,
publishes a GitHub release with the `.vsix`
(`.github/workflows/release.yml`):

```bash
npm version patch          # or minor / major; commits and tags v<version>
git push --follow-tags
```

A pre-release version (`0.2.0-beta.1`) becomes a pre-release. Running the
workflow by hand builds the `.vsix` as an artifact without releasing.

## Docs

| | |
|---|---|
| [how-it-works.md](docs/how-it-works.md) | Connecting, chats, the agent loop, tools, approvals, Nest's tools, internals |
| [bench-results.md](docs/bench-results.md) | Benchmark runs and what they showed |
| [PLAN-agent-runtime.md](docs/PLAN-agent-runtime.md) | The stuck-run checks and why |
| [PLAN-blocked-handoff.md](docs/PLAN-blocked-handoff.md) | Next: handing off a blocker the run cannot clear |
| [PLAN-long-tasks.md](docs/PLAN-long-tasks.md), [PLAN-complex-tasks.md](docs/PLAN-complex-tasks.md), [PLAN-refactor.md](docs/PLAN-refactor.md) | Earlier plans |

## Where it fits

Nest owns accounts, models, discovery, its tools and the wire format.
Yellowscript owns the IDE side: workspace context, editor integration,
diffs, approvals and the agent's experience in VS Code.
