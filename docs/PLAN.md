# Redstart Yellowscript — VSCode IDE Extension Plan

> **v2 — 2026-08-05.** Re-verified against `redstart-nest` at
> `52fbf08` (branch `test/ipc-and-gateway-coverage`). Section
> [What changed since v1](#what-changed-since-v1-2026-07-20) lists every
> correction; the appendix wire reference is re-read from code, not carried
> over.
>
> **Repo location: `e:\redstart-yellowscript\`** — its own standalone repo,
> a sibling of `redstart-project`, not a subdirectory of it (changed from v1).
> This plan doc moves there at Phase 0.1. Consequences in
> [Standalone-repo implications](#standalone-repo-implications).

## Positioning

**Yellowscript is the coding-agent client of the Redstart ecosystem** — what
Kilo Code / Cline / Claude Code are to their clouds, but native to a local
Redstart Nest. Kilo Code already works against Nest today via the generic
OpenAI-compatible path; Yellowscript's reason to exist is everything the
generic path can't do:

- **Zero-config connection** — beacon discovery instead of hand-typed base
  URLs; Redstart login instead of pasted keys.
- **First-class Nest integration** — consumes Nest's MCP tools (web fetch,
  documents, sqlite, vault, git, scholar, postgres, file system), respects the
  server-side tool-permission model, and shows Redstart identity/health in the
  IDE.
- **The ecosystem division of labor**: Nest owns auth, models, providers,
  discovery; **Yellowscript owns only IDE-domain logic** — workspace context,
  editor integration, diffs, the agentic UX.
- **Tolerance for local models.** This is the differentiator v1 undersold.
  Nest drives a 3B-active MoE on a 12GB card, and such models emit tool calls
  in half a dozen malformed shapes. A generic OpenAI client drops those calls
  and the model then *narrates* work it never did. Yellowscript inherits
  Nest's hard-won recovery parsing (see C.2) — Kilo cannot.

## Grounding — what the framework already provides (verified 2026-08-05)

| Capability | Where | Status |
|---|---|---|
| OpenAI-compatible chat + native `tool_calls` (`--jinja`) | gateway `/v1/chat/completions` | shipping |
| Auth: session login + `rst_` API keys, roles | `/auth/*` | shipping; shapes pinned by `test-contracts.mjs` |
| Discovery beacon `{app,running,port}` on :8765 | `beacon.mjs` | shipping; payload contract tested |
| MCP server (SSE) — 8 providers, capability gating, write/destructive policy | `mcp-server.mjs` | shipping; conformance-tested |
| File System = official `@modelcontextprotocol/server-filesystem` (stdio child) | `filesystem-mcp-provider.mjs` | **new since v1** |
| Shared stdio-MCP process supervisor | `shared/mcp-stdio-process.mjs` | **new since v1**; backs both Twig and Nest |
| Central tool bans (`disabledTools` strip at completion time) | `enforceToolAllowList` | shipping |
| Malformed-tool-call recovery parser | `chat-ui/src/lib/utils/tool-call-parser.ts` | **new since v1**; unit-tested |
| Conversations API (account-scoped) | `/conversations` | shipping; isolation tested |

In `redstart-project`, `npm run test:security` is now **13 node suites + the chat-ui security run**
(`test-ci-parity`, `test-path-scope`, `test-conversation-isolation`,
`test-tool-policy`, `test-llama-args`, `test-discovery-robustness`,
`test-auth`, `test-gateway-routes`, `test-ipc-contract`,
`test-mcp-capabilities`, `test-provider-conformance`, `test-contracts`).
**Yellowscript builds against a boundary that is already tested** — those
suites are the written-down spec for every shape below. They gate the *other*
repo, though, not this one; see
[Standalone-repo implications](#standalone-repo-implications).

---

# What changed since v1 (2026-07-20)

Ten corrections. Four of them change design, not just wording.

### 1. 🔴 Nest's file-system tool names now collide with Yellowscript's

v1 gave the IDE-local tools the names `read_file`, `write_file`, `edit_file`,
`list_directory`, `glob`, `grep`. Since `3db8514` the Nest File System
capability is the **official MCP filesystem server**, which advertises exactly:

```
read_file  read_text_file  read_media_file  read_multiple_files
write_file  edit_file  create_directory  list_directory
list_directory_with_sizes  directory_tree  move_file  search_files
get_file_info  list_allowed_directories
```

Six direct collisions. A single `tools` array cannot carry two functions with
the same name — and the failure is silent and *dangerous*: the model asks for
`write_file` meaning the workspace and gets Nest's configured `rootDir`
instead (or vice versa), writing into the wrong tree entirely.

**Decision: namespace every IDE-local tool `ws_*`** — `ws_read_file`,
`ws_write_file`, `ws_edit_file`, `ws_list_directory`, `ws_glob`, `ws_grep`,
`ws_diagnostics`, `ws_editor_context`, `ws_run_command`. Rationale over the
alternatives:

- *Suppress Nest's fs tools when Yellowscript is connected* — rejected: the
  two roots are legitimately different things (workspace vs. the admin's
  shared file root) and a user may want both in one session.
- *Prefix Nest's instead* — rejected: Yellowscript must not rewrite tool names
  the server advertises; `disabledTools` matching would break.
- `ws_` also makes the approval card's origin unambiguous before the UI even
  renders the badge, and gives the fallback parser (C.2) disjoint name sets to
  match against — which matters, because that parser identifies a call *by
  tool name appearing in free text*. Overlapping names would let a
  reasoning-block mention of `write_file` be attributed to the wrong executor.

Nest's `mcp-server.mjs` already logs `duplicate tool name … Namespace your
tool names` for its own providers. Yellowscript follows the same convention;
the merge step (4.3) asserts disjointness and fails loudly, never silently.

### 2. 🔴 Nest MCP speaks SSE only — there is no Streamable HTTP endpoint

v1 said "StreamableHTTP with SSE fallback." Wrong. `mcp-server.mjs` serves
exactly two routes: `GET /sse` and `POST /message`. The chat-ui had to be
fixed for precisely this (`29bedad`, *use the SSE transport for /sse MCP
endpoints*). Use the SDK's **`SSEClientTransport`**, chosen on the `/sse` URL
suffix. Related fixes worth knowing: the SSE `endpoint` event sends a **bare
URI** (`1a93b31`), and the preflight now allows `mcp-protocol-version`,
`mcp-session-id`, `last-event-id` and exposes `mcp-session-id` (`0004ab7`).

### 3. 🔴 Structured `tool_calls` are not reliable — recovery parsing is required

v1 treated native `tool_calls` from `--jinja` as sufficient. Five fix commits
since say otherwise. `tool-call-parser.ts` now recovers calls emitted as:

| Shape | Example |
|---|---|
| canonical JSON | `{"name":"x","arguments":{…}}`, incl. inside `<tool_call>` or a ` ```json ` fence |
| braces | `create_document{…}` |
| xml | `<function=create_document>…</function>` |
| fn | `create_document(…)` |
| Python kwargs | `create_document(content='hi', format='md')` |
| **orphan arguments** | a bare args object whose tool is named only in the reasoning stream |
| **in the reasoning block** | the whole call inside `reasoning_content`, with the answer merely *claiming* it ran |

The last two are the ones that silently lie to the user. Attribution is
deliberately conservative — an orphan payload is only claimed when exactly one
available tool is named across the turn.

**Yellowscript must port this module, not reimplement it** (unit tests come
with it), and must consume `reasoning_content` as a separate stream. This is
promoted from an unlisted detail to its own phase-2 unit (2.5).

### 4. 🟠 Capabilities are per-profile AND globally configured

`ceb173a` made capability selection per-profile. A Nest capability is live only
when **both** the admin enabled+configured it globally *and* the launched
profile's `activeToolIds` contains it (`gateway-config.mjs:76-93`). Consequence
for Yellowscript: **the Nest tool set is not static for the life of a
connection.** Switching profiles on the Nest changes it. Re-fetch
`/redstart/mcp-servers` and re-run `tools/list` on reconnect and on any 502,
rather than caching once at connect.

### 5. 🟠 The gateway only claims capabilities when the request carries tools

`cccf6fc` — `buildSystemContext(config, hasTools)` returns bare identity text
unless `parsed.tools` is non-empty. Yellowscript always sends tools, so it
always receives the capability blurb *and* the injected system message
prepended to its own. Budget for that in the context accounting (C.3) and
don't be surprised by text you didn't write appearing at the head of the
system prompt.

### 6. 🟠 File-system write/destructive policy is a real, separate gate

`fileSystem.allowWrite` (default on) and `fileSystem.allowDestructive`
(default off) are enforced twice: blocked tools are filtered out of
`tools/list`, and refused at `tools/call` with `isError` — non-bypassable.
Yellowscript's approval UI must render a server denial as a distinct outcome
from a user rejection; the model needs to see the refusal reason so it stops
retrying.

### 7. 🟡 `/files/download` now serves two roots

`fileSystem.rootDir` **and** `documents.outputDir`. `403` = outside every root,
`404` = inside a root but no file, `400` = missing `path` param. The distinction
is contractual; don't collapse it.

### 8. 🟡 Reuse the shared stdio supervisor for local MCP servers

v1 said to call the SDK's `StdioClientTransport` directly. Since `592b5be`
there is `redstart-project/shared/mcp-stdio-process.mjs`, used by both Twig and
Nest's own filesystem provider — it owns spawn, log capture, crash detection
and restart policy. `filesystem-mcp-provider.mjs` is the reference consumer
(note its `ELECTRON_RUN_AS_NODE` + `process.execPath` spawn trick and its
explicit `shouldRestart: () => false` so it can drive its own
handshake-on-restart). Prefer its design over a bare transport — but **vendor
the file**, don't reach across repos (see
[Standalone-repo implications](#standalone-repo-implications)).

### 9. 🟡 `disabledTools` derives from profile-level *tool IDs*

`expandDisabledToolIds(toolSettings.disabledToolIds)` expands admin-facing
capability/tool IDs into the concrete function names the model sees. The
endpoint still returns a flat `string[]` of function names — the shape v1
documented is correct — but it now changes with the active profile (see 4).

### 10. 🟢 Nest internals moved (no wire impact)

`electron/main/index.mjs` was decomposed into `ipc/*.mjs` + `gateway-config.mjs`.
Authoritative wire sources are unchanged: `tools-gateway.mjs`, `beacon.mjs`,
`auth.mjs`, `mcp-server.mjs`. The beacon payload is byte-for-byte as v1
documented it.

---

# Standalone-repo implications

Yellowscript lives in **`e:\redstart-yellowscript\`**, its own git repo. It
talks to Nest over HTTP like any other client — which is the whole point of the
ecosystem's division of labor, and the reason a separate repo is coherent at
all. But three things v1 assumed were a relative import away now cross a repo
boundary, and each needs a deliberate answer rather than a `../../` path.

### Cross-repo code: copy, don't reach

`../../redstart-project/shared/mcp-stdio-process.mjs` must not appear in this
codebase. It would break the moment either repo moves, and it makes the
extension unbuildable for anyone who has only cloned Yellowscript.

| What v1 wanted to reuse | Answer |
|---|---|
| `shared/mcp-stdio-process.mjs` (change #8) | **Vendor it** into `src/mcp/stdio-process.ts` with a header naming its origin repo, file, and the commit copied from. Not needed until Phase 5.4 — decide then whether it has earned a published package. |
| `chat-ui/src/lib/utils/tool-call-parser.ts` + tests (change #3) | **Vendor it**, same header convention. It was always going to be a port (the `ApiChatCompletionToolCall` import doesn't exist here); the repo split changes nothing except that the copy is now unambiguously a copy. |
| `path-scope.mjs` containment semantics (E) | **Reimplement** against VSCode's workspace-folder API — it was never a straight port. `test-path-scope.mjs`'s *cases* transplant; its code doesn't. |

If a third consumer ever appears, promote the shared bits to a published
`@redstart/*` package. Two consumers do not justify that yet — a vendored file
with a provenance header is cheaper and honest about what it is.

### The contract net doesn't run in CI here

The 13-suite `test:security` boundary suite lives in `redstart-project` and
gates *that* repo. Yellowscript can no longer free-ride on it: a Nest change
that breaks a wire shape will now go green in Yellowscript's CI and fail at
runtime. Two mitigations, both cheap:

1. **An env-gated live smoke** (`YELLOWSCRIPT_TEST_LIVE_NEST=<url>`) that
   asserts the handful of shapes this extension actually depends on — beacon
   payload, `/auth/me`, `/redstart/mcp-servers`, one `tools/list`. Run it
   manually before each release; wire it to CI only if a Nest instance is ever
   reachable there.
2. **Version the appendix.** The wire reference below is dated and
   commit-stamped. Re-verify it against Nest at the start of each phase — that
   discipline is what this v2 revision is, and it should be routine, not a
   rescue.

### Coordinated changes need two PRs

Anything requiring a Nest-side change (a new gateway route, a `disabledTools`
shape change) is now two repos, two PRs, and an ordering constraint: **Nest
ships first, Yellowscript degrades gracefully until it has**. Design every
Nest dependency so a missing/older endpoint degrades to a disabled feature
with a clear status-bar reason, never a hard failure at connect.

---

# Architecture

```
VSCode
├─ Extension host (Node) — the brain
│   ├─ NestClient        discovery (beacon scan) · auth (SecretStorage) · SSE streaming
│   ├─ ToolCallParser    ported from chat-ui — recovers malformed/reasoning-block calls
│   ├─ AgentLoop         messages+tools → stream → tool_calls → approval → execute → loop
│   ├─ Local tools       ws_* workspace fs / search / diagnostics / terminal / diff+checkpoint
│   ├─ McpHost           Nest MCP over SSE + local stdio servers (shared supervisor)
│   └─ Storage           conversations, settings, per-workspace state
├─ Webview (sidebar)     chat UI: streaming markdown, tool-call cards, diff summaries
└─ Editor surfaces       diff review tabs · context-menu actions · status bar · code actions
```

Trust boundaries: API key lives in VSCode **SecretStorage**, never in settings
JSON, never in model context. All local tools are **workspace-contained**
(same containment philosophy as `path-scope.mjs`, enforced extension-side).
Nest's `disabledTools` still strips banned names server-side; the MCP policy
gate still refuses blocked writes — central policy keeps working regardless of
what the IDE offers.

---

# Feature Outline

## A. Framework integration (consume Nest, never rebuild it)

1. **Connection manager** — beacon scan of the LAN + manual URL fallback;
   persists per-workspace; status-bar indicator (connected model, tokens/sec
   from `timings`).
2. **Auth** — Redstart login (username/password → session token) or a pasted
   `rst_` key; `/auth/me` for identity/role; handles `authRequired:false` dev
   mode; token in SecretStorage. Sessions are server-memory only — a Nest
   restart means 401 and re-login.
3. **Model service** — `/v1/models`, streaming completions with `tools`, abort,
   `timings` parsing, context-size awareness.
4. **Nest MCP host** — `SSEClientTransport` against the URL from
   `/redstart/mcp-servers`, same `Authorization` header; merge its tools into
   the agent's set, tagged by origin so approval UI can say "runs on Nest".
   **Re-list on every reconnect** (profiles change the set).
5. **Central governance compliance** — surface server denials (`disabledTools`
   strip, write/destructive policy) rather than fighting them; no client-side
   re-enable of banned tools.
6. **Conversation sync** — local-first in workspace storage; optional push/pull
   via `/conversations` in Phase 5.

## B. IDE-local tools (the application-logic half)

Extension-host, workspace-contained, approval-gated, **`ws_`-namespaced**:

| Tool | Notes |
|---|---|
| `ws_read_file`, `ws_list_directory`, `ws_glob`, `ws_grep` | grep via VSCode's bundled ripgrep |
| `ws_write_file`, `ws_edit_file` (exact search/replace) | never applied directly — always through diff review |
| `ws_diagnostics` | Problems panel → model-readable |
| `ws_editor_context` | open files, selection, cursor — injected, also on-demand |
| `ws_run_command` | integrated terminal, shell-integration output capture, always-ask default |
| `ws_apply_diff` / checkpoints | shadow-git snapshot before each write batch → revert button |

Plus **local stdio MCP servers** (config file mirroring Twig's `twig-mcp.json`,
spawned through `shared/mcp-stdio-process.mjs`).

## C. Agentic loop

1. **System prompt assembly** — OS/shell, workspace tree summary
   (`.gitignore`-respecting), open editors, MCP server instructions. Remember
   the gateway prepends its own block.
2. **Tool-call extraction** — structured `tool_calls` first; on a turn that
   produced none, run the ported parser over the answer, then orphan-argument
   recovery, then `reasoning_content`. Never let a turn claim work it didn't do.
3. **Context management** — token budget from the model's context size (32k on
   the reference rig); oldest-turn compaction (port the concept from chat-ui's
   `context-compaction.service`).
4. **Approval tiers** — reads auto; writes approve-with-diff; terminal
   always-ask; per-tool "always allow" persisted per workspace. Server denials
   render distinctly from user rejections.
5. Turn cap, user abort, error surfacing.

## D. VSCode UX surfaces

- **Sidebar chat webview** — slim purpose-built app (not the SvelteKit PWA);
  streaming markdown, tool-call cards (name/args/result/origin), diff summaries.
- **Diff review** — VSCode native diff editor per changed file; Apply / Reject /
  Apply-all; checkpoint revert.
- **Editor integration** — context menu: *Add to context*, *Explain*, *Fix*,
  *Refactor selection*; code-action provider for diagnostics.
- **Command palette** — new task, resume, connect, pick model, toggle
  auto-approve.
- **Status bar** — Nest connection, model, live tokens/sec.
- **Settings** — server URL override, approval defaults, tool toggles, context
  limits; secrets never in settings.json.

## E. Safety model

- Workspace Trust: untrusted workspace → read-only tools, no terminal.
- Path containment on every `ws_*` fs tool (workspace folders only; reject
  traversal and symlink escapes — mirror `path-scope.mjs` semantics, and note
  that Nest's own filesystem provider *also* re-validates behind the upstream
  server; do the same rather than trusting one layer).
- Terminal commands never auto-approved by default; shown verbatim.
- Redaction: `rst_` keys and `Authorization` headers scrubbed from anything
  entering model context or logs.
- `.yellowscriptignore` + `.gitignore` respected for context collection.

---

# Phases

| Phase | Deliverable | Proves |
|---|---|---|
| 0 | Repo skeleton (`e:\redstart-yellowscript\`, own git repo, TS + esbuild + vsce), connection manager, auth, status bar | zero-config discovery + login from IDE |
| 1 | Sidebar chat with streaming (no tools) | end-to-end Nest conversation in VSCode |
| 2 | Read-only `ws_*` tools + agent loop + recovery parser + approval cards | the agent loop, safely, against a local model |
| 3 | Write tools + diff review + checkpoints | trusted code modification |
| 4 | Terminal tool + Nest-MCP host merge | full Kilo-parity tool set + shared infrastructure |
| 5 | Polish: editor actions, conversation sync, local stdio MCP, modes | ecosystem citizenship |

Each phase ends user-demoable. Phases 0–1 carry zero risk to existing code
(new directory only); CI gains the extension's typecheck/tests when the
skeleton lands.

# Execution subsets (scoped for a local-model agent)

Local driver is Qwen3.6-35B-A3B Q4_K_XL (MoE, ~3B active) on a 12GB card, 32k
context. Each unit below should be its **own fresh session** pointed at a
narrow file set — not one long agentic run across a phase. 🟢 = mechanical
enough to hand to Qwen and review the diff. 🟡 = settle the design call first
(with Claude or by hand), then the typing-out can still go to Qwen. Where a
unit maps to an existing tested pattern, that's the spec to point Qwen at — it
turns "get this right" into "match this."

**Phase 0 — skeleton, connection, auth, status bar**
- 0.1 🟢 Scaffold `e:\redstart-yellowscript\`: `git init`, `package.json`,
  `tsconfig.json`, esbuild script, vsce config, `.gitignore`, minimal
  `extension.ts`, one "Hello Yellowscript" command proving the build. Move this
  plan doc into the new repo as `docs/PLAN.md`.
- 0.2 🟢 Beacon discovery: scan LAN `:8765`, parse `{app,running,port}`, short
  timeout. Reference: `redstart-twig/windows/electron/main.mjs`; the robustness
  edge cases are already pinned by `test-discovery-robustness.mjs`.
- 0.3 🟡→🟢 Auth state machine (login vs. paste `rst_` key, SecretStorage,
  `/auth/me` on reconnect, 401 → re-login) — settle first, then implement
  against the shapes pinned in `test-auth.mjs` / `test-contracts.mjs`.
- 0.4 🟢 Status bar item wired to 0.2 + 0.3.
- 0.5 🟢 Manual smoke against a running Nest.

**Phase 1 — sidebar chat, streaming, no tools**
- 1.1 🟡 Webview scaffold + extension↔webview message contract (load-bearing
  for every later phase — settle the shape first).
- 1.2 🟢 `NestClient` SSE streaming against `/v1/chat/completions`, abort,
  **separate `reasoning_content` channel** (needed by 2.5).
- 1.3 🟢 Render loop: streaming markdown, turn history, collapsible reasoning.
- 1.4 🟢 `GET /v1/models`, parse `timings` from the final chunk → status bar.

**Phase 2 — read-only tools, agent loop, approval**
- 2.1 🟢 `ws_read_file`, `ws_list_directory`, `ws_glob`, `ws_grep`, each with a
  containment test transplanted from `test-path-scope.mjs` — one tool per
  session, those tests as the spec.
- 2.2 🟢 `ws_diagnostics`, `ws_editor_context`.
- 2.3 🟡 `AgentLoop` core (stream → detect `tool_calls` → execute → append →
  loop, turn cap, abort, error surfacing) — the architectural spine; design
  deliberately before handing pieces to Qwen.
- 2.4 🟢 Approval-card UI, reads auto-approved.
- 2.5 🟢 **Vendor `tool-call-parser.ts` + its unit tests** from
  `redstart-nest/src/chat-ui/src/lib/utils/`; wire
  `parseToolCallsFromTurn(content, reasoningContent, …)` as the fallback path
  in 2.3. Mechanical — the module and its tests transplant nearly verbatim; the
  only edit is the `ApiChatCompletionToolCall` import. Add a provenance header
  (source repo, path, commit).

**Phase 3 — write tools, diff review, checkpoints**
- 3.1 🟡 `ws_write_file` / `ws_edit_file` contracts — settle the diff payload
  shape first.
- 3.2 🟢 Diff review tabs via the native diff editor; Apply/Reject/Apply-all.
- 3.3 🟡 Shadow-git checkpoint + revert — the one place a bug destroys work;
  get the snapshot strategy right deliberately.
- 3.4 🟢 Approval tiers UI + per-workspace "always allow" persistence.

**Phase 4 — terminal, Nest-MCP merge**
- 4.1 🟡→🟢 `ws_run_command`: settle shell-integration output capture and the
  always-ask default, then implement.
- 4.2 🟡 `McpHost`: `SSEClientTransport` to the URL from
  `/redstart/mcp-servers`, same auth header, re-list on reconnect. Spec:
  `test-mcp-capabilities.mjs` + `test-provider-conformance.mjs`.
- 4.3 🟢 Tool-set merge with a **disjointness assertion** (`ws_*` vs. Nest
  names) that throws loudly on collision, + "runs on Nest" origin tag.
- 4.4 🟢 `disabledTools` greying in the tool picker (UX-only; the gateway does
  the real enforcement) + distinct rendering for policy denials.

**Phase 5 — polish**
- 5.1 🟢 Editor context-menu actions + code-action provider.
- 5.2 🟢 Command palette commands.
- 5.3 🟡 Conversation sync — decide conflict/merge behavior first.
- 5.4 🟢 Local stdio MCP config, wired through the vendored copy of
  `mcp-stdio-process.mjs` (reference consumer: Nest's
  `filesystem-mcp-provider.mjs`).
- 5.5 🟡 Modes — design surface, not yet scoped.

**Working pattern per unit:** fresh Qwen session → point it at the specific
files/tests that are the spec → implement → review the diff → run the relevant
tests → next unit. Don't chain units in one conversation: 32k fills fast once
tool output and file contents are in play, and a long unsupervised run is
where a weaker model drifts furthest from spec.

# Decision points

1. **IDE-local tools are `ws_`-namespaced** — forced by the filesystem-server
   collision (see change #1). New in v2.
2. **Webview: slim purpose-built** (not the embedded chat-ui). Revisit shared
   components via a workspace package if duplication hurts.
3. **Conversations: local-first**, Nest sync deferred to Phase 5.
4. **Nest MCP consumption in Phase 4**, not MVP — the loop matters first.
5. **Recovery parsing is Phase 2, not polish** — without it the agent silently
   claims work it never did on exactly the models Nest runs. New in v2.
6. **Name/API id**: `redstart-yellowscript` (publisher TBD; sideload `.vsix`).

# Testing

- `redstart-project`'s boundary suite is the **written-down spec** for every
  Nest shape Yellowscript consumes (auth, tools/list, beacon, gateway routes,
  provider conformance) — but it gates that repo's CI, not this one. Point
  implementing sessions at those files; don't assume they protect you here.
- Extension-side, in this repo: unit tests for every `ws_*` tool's
  **containment** (the `test-path-scope.mjs` *cases* transplant; the code
  doesn't), the SSE stream parser, the vendored tool-call parser (its tests
  come with it), the tool-name disjointness assertion, and the approval-tier
  logic.
- **Live-Nest smoke**, env-gated on `YELLOWSCRIPT_TEST_LIVE_NEST=<url>`
  (convention borrowed from `REDSTART_TEST_LIVE_WEB`): beacon payload,
  `/auth/me`, `/redstart/mcp-servers`, one `tools/list`. This is the only thing
  standing between a Nest wire change and a runtime break — run it before every
  release.

---

# Appendix — Nest wire reference (re-verified in code, 2026-08-05)

Authoritative sources: `redstart-nest/electron/main/{tools-gateway,beacon,auth,mcp-server}.mjs`.
Shapes marked ✔ are pinned by the test suite and fail CI if they drift.

## Topology & ports

| Service | Port | Bind | Notes |
|---|---|---|---|
| Gateway (public API) | user-configured, default **19080** | LAN | the ONLY port clients use for HTTP |
| llama-server | gateway + 1 (19081) | 127.0.0.1 only | never talk to it directly (invariant-tested) |
| Built-in MCP server | gateway + 2 (19082) | LAN | discover via `/redstart/mcp-servers`, don't hardcode +2 |
| Discovery beacon | fixed **8765** | LAN | HTTP GET, no auth |

## Discovery

`GET http://<ip>:8765/` (short timeout, ~400 ms). A Redstart Nest answers
exactly ✔:

```json
{ "app": "redstart-nest", "running": true, "port": 19080 }
```

Exactly 3 fields; `app` is the positive-identification marker; `port` is the
gateway port on that same IP. Build the connection URL from the responding IP
plus this port. (`redstart-twig/windows/electron/main.mjs` is a working
reference; `test-discovery-robustness.mjs` pins the edge cases.)

## Auth

- `GET /auth/config` → ✔ `{ "authRequired": boolean }` (no auth needed).
- `POST /auth/login` `{username, password}` →
  ✔ `{ token, user: { id, username, role, apiKeyPrefix, createdAt, lastLoginAt } }`
  — exactly those user fields, never a secret. 401 on bad credentials, same
  message for unknown user (no enumeration).
- Authenticated requests: `Authorization: Bearer <value>` where value is
  **either** a session token **or** an `rst_` API key — same header, both work.
- `GET /auth/me` → ✔ `{ authRequired, user }`.
- `POST /auth/logout`, `POST /auth/me/regenerate-key` also exist;
  `/auth/accounts*` is admin-only.
- Sessions are server-memory only: a Nest restart invalidates tokens → expect
  401 and re-login.
- When `authRequired` is false, requests need no token (admin routes stay
  locked regardless). There is **no localhost bypass** — auth applies from
  127.0.0.1 too.
- Static assets (`/`, `/index.html`, `/_app/*`, and known asset extensions)
  are served without auth; llama-server's API routes never match that test.

## Completions

- `POST /v1/chat/completions` — OpenAI-compatible, streaming SSE. Send `tools`
  (OpenAI function schema) and `stream: true`.
- The gateway intercepts to (1) inject Redstart system context into `messages`
  — **only claiming capabilities when the request actually carries `tools`** —
  and (2) strip centrally-banned names from `tools`, `tool_choice`, and prior
  assistant `tool_calls`. If stripping empties `tools`, the key is deleted
  entirely. Don't fight either behavior.
- Injection merges into an existing system message (`context + "\n\n" + yours`)
  rather than adding a second one.
- Malformed JSON body → 400 ✔ `{ error: { message, type } }`.
- All other `/v1/*` paths pass through untouched — `GET /v1/models` works for
  model discovery; the final stream chunk carries `timings` (tokens/sec).
- Reasoning models emit `reasoning_content` on a separate stream from the
  answer. Consume it: tool calls hide there.
- No llama-server running → 502 (auth still checked first: 401 without a token
  even then).
- CORS: the gateway strips llama-server's reflected
  `Access-Control-Allow-Origin` and emits exactly one `*`.

## MCP

- `GET /redstart/mcp-servers` (authed) →
  `{ servers: [{ name, url }], disabledTools: string[] }`. The built-in server
  appears as `http://<host-from-Host-header>:<gateway+2>/sse`, plus any enabled
  admin-registered external servers. **This endpoint is the discovery
  mechanism**; never hardcode the MCP port.
- **Transport is SSE only**: `GET /sse` (stream) + `POST /message` (requests).
  There is no Streamable HTTP endpoint — use `SSEClientTransport`. The SSE
  `endpoint` event carries a bare URI.
- Pass the same `Authorization` header; the MCP server enforces the same auth
  gate ✔ (401 without a token when auth is on).
- Preflight allows `Content-Type, Authorization, mcp-protocol-version,
  mcp-session-id, last-event-id` and exposes `mcp-session-id`.
- `initialize` → `protocolVersion: '2024-11-05'`,
  `serverInfo: { name: 'redstart-fetch', version: '1.0.0' }`.
- `tools/list` entries are exactly `{ name, description, inputSchema }` ✔.
  Disabled capabilities are absent from the list AND refused on a direct
  `tools/call` (`isError` result) — conformance-tested across all 8 providers
  (web fetch, postgres, documents, sqlite, vault, git, filesystem, scholar).
- Tools blocked by the write/destructive policy are also filtered from
  `tools/list` and refused at `tools/call` with a human-readable reason.
- The advertised set depends on the **active profile**, not just global config
  — re-list on reconnect.
- `disabledTools` from the endpoint is UX guidance (grey out, don't offer); the
  gateway strip is the real enforcement.

### File System tool names (official server, pin 2026.7.10)

`read_file`, `read_text_file`, `read_media_file`, `read_multiple_files`,
`write_file`, `edit_file`, `create_directory`, `list_directory`,
`list_directory_with_sizes`, `directory_tree`, `move_file`, `search_files`,
`get_file_info`, `list_allowed_directories`.

**These are the names Yellowscript's local tools must not reuse.** Re-audit if
the pin moves (`filesystem-mcp-provider.mjs` says the same).

## Other gateway routes

- `GET/POST /conversations`, `GET/PUT/DELETE /conversations/:id` —
  account-scoped (a token only ever sees its own account's conversations;
  isolation is server-tested). For Phase-5 sync.
- `GET /files/download?path=<rel>` (authed) — streams from **either** the File
  System root or the Documents output dir. `400` missing `path`, `403` outside
  every root, `404` inside a root but no such file.
- CORS: `Access-Control-Allow-Origin: *` with the `Authorization` header
  allowed — a webview *could* call directly, but the extension host should own
  every request so the token never enters the webview.
