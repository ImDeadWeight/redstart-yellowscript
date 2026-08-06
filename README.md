# Redstart Yellowscript

A VSCode coding agent that talks to a **local Redstart Nest** — the private,
on-premises AI server — instead of a cloud. Zero-config discovery, Redstart
login, and (from Phase 2) workspace-aware tools the model can drive.

> **Status: Phase 1.** Connect to a Nest, sign in, and hold a streaming
> conversation in the sidebar. No tools or agent loop yet — that is Phase 2.
> **[docs/HANDOFF.md](docs/HANDOFF.md) is the single planning document** — state,
> roadmap, ground rules, and the Nest wire reference. Read it before starting.

## Why not just point Kilo Code at the Nest?

You can — Nest speaks the OpenAI-compatible API and the generic path works
today. Yellowscript exists for what that path can't do:

- **Zero-config connection.** It finds the Nest by its discovery beacon and
  signs in with a Redstart account, instead of a hand-typed base URL and a
  pasted key.
- **Tolerance for local models.** Nest drives quantized MoE models on consumer
  GPUs, and those emit tool calls in half a dozen malformed shapes — Python
  kwargs, bare argument objects, calls buried in a reasoning block. A generic
  client drops those, and the model then *narrates* work it never did.
  Yellowscript inherits Nest's recovery parsing (Phase 2).
- **Real Nest integration.** It consumes the Nest's own MCP tools, respects the
  server-side tool bans and write/destructive policy, and shows Redstart
  identity in the IDE.

## Getting started

```bash
npm install
npm run check      # typecheck + unit tests
npm run build      # bundle to dist/extension.cjs
```

Press <kbd>F5</kbd> in VSCode to launch an Extension Development Host.

Then run **Yellowscript: Connect to Nest** from the command palette. With a
Nest running on your network, that is all the configuration there is.

### Commands

| Command | What it does |
|---|---|
| `Yellowscript: New Chat` | Clear the transcript and focus the panel |
| `Yellowscript: Connect to Nest` | Discover (or use the configured URL) and connect |
| `Yellowscript: Sign In to Nest` | Username/password, or paste an `rst_` API key |
| `Yellowscript: Sign Out` | Forget the stored credential, keep the server |
| `Yellowscript: Disconnect` | Drop the connection and stop auto-reconnecting |
| `Yellowscript: Show Connection Status` | Details plus the next useful action |

### Settings

| Setting | Default | Notes |
|---|---|---|
| `redstartYellowscript.serverUrl` | `""` | Explicit gateway URL. Set it and discovery is skipped. |
| `redstartYellowscript.discovery.enabled` | `true` | Scan the LAN on connect. |
| `redstartYellowscript.discovery.timeoutMs` | `400` | Per-host beacon timeout. Raise on a slow network. |
| `redstartYellowscript.autoConnect` | `true` | Reconnect to the last-used Nest when a window opens. |

Credentials are **never** settings. They live in VSCode's SecretStorage, keyed
per server, and never enter a log line or the model's context.

## Development

```bash
npm test           # node --test over the .ts sources — no build, no test deps
npm run watch      # esbuild in watch mode (what F5 uses)
npm run package    # check + build + vsce package
```

Tests run through Node's **native TypeScript stripping**, which is why the core
modules (`connection.ts`, `nest/*`, `chat/*`) import no `vscode` API — they are
plain Node and testable without an extension host. Keep that boundary: `vscode`
imports belong in `extension.ts`, `storage.ts`, and `ui/`.

Two consequences worth knowing:

- Type stripping erases types but does not *transform* code, so **TypeScript
  parameter properties (`constructor(private readonly x: T)`) are not usable**
  anywhere under `src/`. Declare the field and assign it.
- There are **two TypeScript projects**. `tsconfig.json` covers the extension
  host (Node types, no DOM); `tsconfig.webview.json` covers the webview entry
  (DOM, no Node types). Widening one lib to cover both would let host code reach
  for `document` and still typecheck. `npm run typecheck` runs both.

The webview is treated as a hostile document, because it renders model output:
strict nonce-based CSP, no external origins, `localResourceRoots` limited to our
own folders, and a markdown renderer that escapes its input before applying any
rule. If you add a rendering rule, add it **after** the escape.

### Verifying against a live Nest

This repo does not run redstart-project's boundary test suite, so nothing here
fails when the Nest's wire format drifts. The smoke test is what notices:

```bash
YELLOWSCRIPT_TEST_LIVE_NEST=http://192.168.1.20:19080 \
YELLOWSCRIPT_TEST_TOKEN=rst_... \
npm run smoke
```

Run it before every release. It checks the beacon payload, `/auth/config`,
`/auth/me`, `/redstart/mcp-servers`, `/v1/models`, and that an unauthenticated
request is actually refused.

## Relationship to the rest of the ecosystem

Nest owns auth, models, providers, and discovery. Yellowscript owns only
IDE-domain logic: workspace context, editor integration, diffs, and the agentic
UX. When something looks like it belongs to both, it belongs to Nest.

A few files here are **vendored** from `redstart-project` rather than imported,
since that is a separate repo — each carries a header naming its origin and the
commit it came from. Keep those headers current when you re-sync.
