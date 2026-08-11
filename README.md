# Redstart Yellowscript

A VSCode coding-agent extension that connects to a **local Redstart Nest** —
the private, on-premises AI server — instead of a cloud API. Zero-config
network discovery, Redstart account authentication, streaming chat in the
sidebar, and workspace-aware tools the model can drive.

> **Status: Phase 4.3 shipped.** Connect, sign in, streaming conversation,
> six read-only tools, write tools with shadow-git checkpointing, command
> execution, Nest MCP tool discovery, server-side tool banning, and a settings
> menu. **[docs/HANDOFF.md](docs/HANDOFF.md) is the single planning document**
> — state, roadmap, ground rules, and the Nest wire reference.

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
| `Yellowscript: New Chat` | Create a new conversation tab and focus the panel |
| `Yellowscript: Connect to Nest` | Discover (or use the configured URL) and connect |
| `Yellowscript: Disconnect` | Drop the connection and stop auto-reconnecting |
| `Yellowscript: Sign In to Nest` | Username/password, paste an `rst_` API key, or issue a connector key |
| `Yellowscript: Sign Out` | Forget the stored credential, keep the server connection |
| `Yellowscript: Show Connection Status` | Details view plus the next useful action |
| `Yellowscript: Inspect Workspace Tools` | Run all `ws_*` tools with probe args and dump results to the output channel |
| `Yellowscript: Revert Last Write` | Restore files from the most recent approved write via the shadow checkpoint |
| `Yellowscript: Open Settings` | Open the Redstart Yellowscript settings page |

Use the **gear icon** in the view title (top-right of the Yellowscript panel)
to open settings directly.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `redstartYellowscript.serverUrl` | `""` | Explicit gateway URL (e.g. `http://192.168.1.20:19080`). When set, discovery is skipped entirely. |
| `redstartYellowscript.discovery.enabled` | `true` | Scan the LAN on connect. |
| `redstartYellowscript.discovery.timeoutMs` | `400` | Per-host beacon timeout (50–5000 ms). Raise on a slow network. |
| `redstartYellowscript.autoConnect` | `true` | Reconnect to the last-used Nest when a window opens. |
| `redstartYellowscript.approvedWriteTools` | `[]` | Write tools to always allow without prompting (`ws_write_file`, `ws_edit_file`). |

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

The sidebar webview holds a **multi-tab** conversation interface. Each tab has
its own transcript, AbortController, and prompt queue. Switching tabs is a
pure view change — streaming continues in background tabs.

- **Tab strip** at the top shows all conversations, busy indicators, and queued
  prompt counts.
- **Streaming** uses two channels: `content` (visible answer) and `reasoning`
  (thinking, starts collapsed).
- **Prompt queuing**: while a turn runs, new prompts queue behind it and drain
  sequentially.
- **Auto-titled** from the first user prompt (truncated to 40 characters).
- Transcripts are saved on every message, turn end, and conversation switch.

## Workspace tools (`ws_*`)

All tools are `ws_`-prefixed to avoid collisions with Nest's MCP tools.
Arguments arrive as raw strings; the registry parses them forgivingly (empty
string → `{}`, malformed JSON → descriptive error).

### Read-only tools

| Tool | Description |
|---|---|
| `ws_read_file` | Read a file's content (workspace-relative). Truncated at 20k characters. |
| `ws_list_directory` | List files in a workspace directory with sizes and types. |
| `ws_glob` | Match files by glob pattern. Uses ripgrep when available; falls back to literal matching. |
| `ws_grep` | Search file contents by regex. Uses ripgrep when available; falls back gracefully. |
| `ws_diagnostics` | Return all VSCode diagnostics (errors, warnings, info, hints) with location and message. |
| `ws_editor_context` | Return active editor state: open file, language, dirty status, cursor, selection, and open files. |

### Write tools (with shadow-git checkpoint)

| Tool | Description |
|---|---|
| `ws_write_file` | Propose writing a complete file (new or full replacement). Checkpointed for revert. |
| `ws_edit_file` | Propose editing a file via unified diff. Diff must match current content; mismatches rejected. |

### Command tool

| Tool | Description |
|---|---|
| `ws_run_command` | Propose running a shell command in the workspace. Always-ask. Output captured from the integrated terminal. |

## Write approval & shadow checkpoints

Before any write is applied, Yellowscript snapshots the pre-write state of
every affected file into a shadow git repo (`<workspace>/.yellowscript/shadow`)
and opens a native VSCode diff editor for review.

The user chooses **Apply**, **Reject**, or **Always allow** (remembered per
tool per workspace). The checkpoint is always taken even when auto-approval
bypasses the prompt.

**Revert Last Write** restores files from the most recent checkpoint.

## MCP tools (Nest integration)

Yellowscript discovers the Nest's MCP tools via `/redstart/mcp-servers` on
every (re)connect. Server-banned tools are greyed out in the UI and stripped
from completions requests server-side — the extension never re-enables them
client-side.

Nest tools are merged with the local `ws_*` set (disjointness asserted) and
tagged `(ran on Nest)` in summaries.

## Development

```bash
npm test           # node --test over .ts sources — no build, no test deps
npm run typecheck  # tsc --noEmit on both tsconfig.json and tsconfig.webview.json
npm run check      # typecheck + unit tests
npm run watch      # esbuild in watch mode (used by F5)
npm run build      # esbuild production bundle
npm run smoke      # live Nest smoke test
npm run package    # check + build + vsce package
```

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

## Relationship to the rest of the ecosystem

- **Nest owns**: auth, models, providers, discovery, MCP server, wire format
- **Yellowscript owns**: IDE-domain logic — workspace context, editor
  integration, diffs, agentic UX, tool approval UI

A few files here are **vendored** from `redstart-project` rather than imported,
since that is a separate repo — each carries a header naming its origin and the
commit it came from. Keep those headers current when you re-sync.
