# Redstart Yellowscript — Handoff & Implementation Plan

> **The single authoritative document for this project.** It replaces the
> earlier `PLAN.md` and `STATE.md`, whose content is absorbed here in full
> (both remain in git history). Keep this file current; don't reintroduce a
> second planning doc.
>
> **Last updated: 2026-08-06.** Phases 0 and 1 complete and demoed live against
> the Nest. **Phase 2 units 2.5, 2.1 and 2.2 are done**: all six read-only
> `ws_*` tools exist, are registered, and were verified running in an Extension
> Development Host. 2.3 (the agent loop) is next and nothing is wired into a
> turn yet. Typecheck clean on both projects, 357 unit tests passing, both
> bundles build.
>
> Wire facts verified against `redstart-nest` @ `52fbf08` on 2026-08-05.
>
> **Correction to section 3: the Nest source IS readable from the laptop.**
> `c:\github-projects\redstart-project` is checked out here with the Nest inside
> it at `redstart-project/redstart-nest/`. Treat it as **read-only** — the Nest
> actually runs on the main PC, so edits to the laptop copy change nothing real.
> The smoke test is still the only proof of what the live server does, since the
> checkout can lag it.

---

## Contents

1. [How we got here](#1-how-we-got-here)
2. [Current state](#2-current-state)
3. [Working method on the laptop](#3-working-method-on-the-laptop)
4. [The plan — positioning and grounding](#4-the-plan--positioning-and-grounding)
5. [Corrections that shaped the design](#5-corrections-that-shaped-the-design)
6. [Standalone-repo implications](#6-standalone-repo-implications)
7. [Architecture and feature outline](#7-architecture-and-feature-outline)
8. [Phases and execution units](#8-phases-and-execution-units)
9. [Ground rules](#9-ground-rules)
10. [Nest wire reference](#10-nest-wire-reference)

---

# 1. How we got here

**The brief.** Build a VSCode coding-agent extension — Kilo Code / Cline shaped —
that connects directly to a local Redstart Nest and gives the model tools to work
in the VSCode workspace. A planning document existed from 2026-07-20 but was
known to be stale.

**Step 1 — the plan was re-verified, not trusted.** The v1 plan was checked
against the Nest source at `52fbf08`. Structurally it held up; ten facts had
drifted, four of which changed the design. Those are section 5 — they are the
most load-bearing part of this document, because each one is a mistake that would
otherwise have been made twice.

**Step 2 — the repo was made standalone.** Originally planned as a subdirectory
of `redstart-project`, it became its own repo at the user's direction. That has
real consequences (section 6): shared modules become vendored copies, and the
project loses free coverage from `redstart-project`'s 13-suite boundary test net.

**Step 3 — Phase 0** (`74ba476`): discovery, the auth state machine,
SecretStorage, status bar. 43 tests.

**Step 4 — Phase 1** (`ee83d7f`): the extension↔webview message contract, SSE
streaming with a separate reasoning channel, `ChatSession`, the webview with a
purpose-built markdown renderer, and model + tokens/sec in the status bar. 131
tests total.

**Step 5 — pushed** to `github.com/ImDeadWeight/redstart-yellowscript`, and
development moved to a laptop while the Nest stays on the main PC.

### Things that were learned rather than planned

- Tests run on the raw `.ts` sources via Node's native type stripping, which
  makes **TypeScript parameter properties a runtime error that `tsc` accepts
  happily**. This bit three constructors before the pattern was understood.
- Three real bugs surfaced only because tests were written after the code: the
  session emitted **live mutable objects** as protocol "snapshots"; it
  **re-derived final text from delta callbacks** instead of the authoritative
  string the client had already assembled; and **blockquotes never matched**
  because block rules run on already-escaped text where `>` is `&gt;`.
- A literal private-use Unicode character written into source **silently
  vanished twice** through the write path. Build such things with
  `String.fromCharCode`.

---

# 2. Current state

## Phase 0 — `74ba476`

Discovery, authentication, status bar.

| Module | Role |
|---|---|
| `src/nest/discovery.ts` | Beacon sweep + strict payload validation |
| `src/nest/client.ts` | Every HTTP call to the gateway |
| `src/nest/types.ts` | Wire shapes + `NestHttpError` |
| `src/connection.ts` | The connect/authenticate state machine |
| `src/storage.ts` | SecretStorage + workspace state |
| `src/ui/status-bar.ts` | Connection, model, tokens/sec |

Two decisions worth knowing:

**Discovery improves on Twig's scan** rather than porting it. Twig takes the
first non-internal interface it finds, which is arbitrary on a laptop with Wi-Fi,
Ethernet and a VPN — all subnets are swept instead. The response body is capped
(we probe arbitrary hosts on an untrusted LAN), and a Nest answering
`running: false` is reported as *"found, but no model loaded"* rather than
discarded, because "not found" sends the user hunting for a network fault that
isn't there.

**The auth state machine exists mainly to disambiguate 401.** Nest keeps session
tokens in memory only, so restarting it to load a different model invalidates
every one — by far the most common 401, and it means "sign in again", not "wrong
password". A rejected `rst_` key means the opposite: re-prompting for the same
key just loops. The credential *kind* is stored alongside the credential so the
UI can say which. Nine tests pin this.

## Phase 1 — `ee83d7f`

Streaming chat in the sidebar.

| Module | Role |
|---|---|
| `src/chat/protocol.ts` | The extension↔webview message contract |
| `src/chat/session.ts` | Transcript + turn lifecycle |
| `src/nest/streaming.ts` | SSE splitting and chunk parsing |
| `src/webview/main.ts` | The renderer |
| `src/webview/markdown.ts` | Purpose-built safe markdown |
| `src/ui/chat-view.ts` | View provider + CSP shell |

**The message contract has four rules** that make later phases additive:

1. **The host is the source of truth; the webview is a renderer.** VSCode
   destroys a hidden view's DOM and rebuilds it, so on `ready` the host replies
   with a full snapshot and the panel redraws from zero.
2. **Every streaming message carries its turn id.** A late delta from an aborted
   turn must not append to the turn that replaced it; in Phase 2 the same id
   attaches a tool-call card to the right message.
3. **Text channels are text; structure gets its own message type.** `content`
   and `reasoning` share one delta message discriminated by `channel`. Tool calls
   are structured, so they get their own type — resisting a third channel is what
   keeps that addition non-breaking.
4. **No secrets cross the boundary.** The extension host owns every HTTP request.
   The gateway's CORS policy would permit the webview to call Nest directly; it
   must not.

**The markdown renderer is ~180 lines, not a library.** markdown-it plus a
sanitizer is ~100kb of webview bundle and a second thing to keep patched. The
safety argument: input is HTML-escaped *first*, every tag emitted afterwards is a
literal in that file, and the one place model text reaches an attribute (a link
href) is scheme-checked against http/https. Ten of its 36 tests are XSS cases,
including forging the internal placeholder sentinel.

## What has never been done

**Nothing has run against a live Nest.** Phases 0 and 1 were built and verified
entirely against scripted streams and fake clients. `npm run smoke` has never
been executed. This is the highest-value next action — see section 3.

---

# 3. Working method on the laptop

**Nest runs on the main PC. Yellowscript is developed on the laptop.** Three
consequences; the third changes how you work.

### Setup

```bash
git clone https://github.com/ImDeadWeight/redstart-yellowscript.git
cd redstart-yellowscript
npm install
npm run check     # typecheck both projects + tests. Must be green before starting.
npm run watch     # what F5 uses
```

### The Nest is over the LAN, not local

Beacon discovery sweeps the laptop's own subnets, so both machines must share a
network. If they don't (different subnets, a VPN between them), discovery finds
nothing — that is not a bug. Set `redstartYellowscript.serverUrl` to
`http://<pc-ip>:19080`; that path exists and is tested.

### Run the live checks first

```bash
YELLOWSCRIPT_TEST_LIVE_NEST=http://<pc-ip>:19080 YELLOWSCRIPT_TEST_TOKEN=rst_... npm run smoke
```

Then press F5 and hold a real conversation. Do this **before** building Phase 2
on top of assumptions that have never been tested.

### You can no longer read the Nest's source

Every wire fact in section 10 was verified by reading `redstart-nest` — a repo
that lives on the *other* machine. From the laptop that verification path is
gone, which changes the method:

- Treat section 10 as the spec, and `scripts/smoke.mjs` as the only way to
  confirm it still holds. **Extend the smoke test whenever you depend on a new
  shape.**
- Do **not** guess at undocumented Nest behaviour. Ask the user to check on the
  PC, or add a smoke assertion and run it.
- If an assertion fails, the Nest has drifted: fix Yellowscript to match reality,
  then update section 10 with the date and what changed.

Some Phase 2+ work needs files from the PC — notably `tool-call-parser.ts`. Ask
for them; don't reimplement from the description here.

---

# 4. The plan — positioning and grounding

**Yellowscript is the coding-agent client of the Redstart ecosystem** — what Kilo
Code / Cline / Claude Code are to their clouds, but native to a local Nest. Kilo
already works against Nest via the generic OpenAI-compatible path; Yellowscript's
reason to exist is what that path can't do:

- **Zero-config connection** — beacon discovery instead of hand-typed base URLs;
  Redstart login instead of pasted keys.
- **First-class Nest integration** — consumes Nest's MCP tools (web fetch,
  documents, sqlite, vault, git, scholar, postgres, file system), respects the
  server-side tool-permission model, shows Redstart identity in the IDE.
- **Division of labour** — Nest owns auth, models, providers, discovery.
  Yellowscript owns *only* IDE-domain logic: workspace context, editor
  integration, diffs, agentic UX. When something looks like it belongs to both,
  it belongs to Nest.
- **Tolerance for local models.** The real differentiator. Nest drives a 3B-active
  MoE on a 12GB card, and such models emit tool calls in half a dozen malformed
  shapes. A generic client drops them and the model then *narrates* work it never
  did. Yellowscript inherits Nest's recovery parsing; Kilo cannot.

### What the framework already provides (verified 2026-08-05)

| Capability | Where | Status |
|---|---|---|
| OpenAI-compatible chat + native `tool_calls` (`--jinja`) | gateway `/v1/chat/completions` | shipping |
| Auth: session login + `rst_` keys, roles | `/auth/*` | pinned by `test-contracts.mjs` |
| Discovery beacon `{app,running,port}` on :8765 | `beacon.mjs` | payload contract tested |
| MCP server (SSE) — 8 providers, capability gating, write/destructive policy | `mcp-server.mjs` | conformance-tested |
| File System = official `@modelcontextprotocol/server-filesystem` (stdio child) | `filesystem-mcp-provider.mjs` | new since v1 |
| Shared stdio-MCP process supervisor | `shared/mcp-stdio-process.mjs` | new since v1 |
| Central tool bans (`disabledTools` strip) | `enforceToolAllowList` | shipping |
| Malformed-tool-call recovery parser | `chat-ui/src/lib/utils/tool-call-parser.ts` | new since v1 |
| Conversations API (account-scoped) | `/conversations` | isolation tested |

In `redstart-project`, `npm run test:security` is 13 node suites plus the chat-ui
security run. Those suites are the written-down spec for every shape in section
10 — but they gate *that* repo, not this one (section 6).

---

# 5. Corrections that shaped the design

Ten facts drifted between the v1 plan (2026-07-20) and the code as of
`52fbf08`. Four changed the design. **This is the most important section for
anyone continuing the work** — each item is a mistake otherwise made twice.

### 1. 🔴 Nest's file-system tool names collide with Yellowscript's

v1 named the IDE-local tools `read_file`, `write_file`, `edit_file`,
`list_directory`, `glob`, `grep`. Since `3db8514` the Nest File System capability
is the **official MCP filesystem server**, advertising exactly:

```
read_file  read_text_file  read_media_file  read_multiple_files
write_file  edit_file  create_directory  list_directory
list_directory_with_sizes  directory_tree  move_file  search_files
get_file_info  list_allowed_directories
```

Six direct collisions. One `tools` array cannot carry two functions with the same
name, and the failure is **silent and dangerous**: the model asks for
`write_file` meaning the workspace and gets Nest's configured `rootDir` instead,
writing into the wrong tree.

**Decision: namespace every IDE-local tool `ws_*`.** Rejected alternatives:
suppressing Nest's fs tools (the two roots are legitimately different things and
a user may want both), and prefixing Nest's instead (Yellowscript must not
rewrite names the server advertises — `disabledTools` matching would break).

`ws_` also gives the fallback parser **disjoint name sets** to match against,
which matters because that parser identifies a call by tool name appearing in
free text. Overlapping names would let a reasoning-block mention of `write_file`
be attributed to the wrong executor.

### 2. 🔴 Nest MCP speaks SSE only

v1 said "StreamableHTTP with SSE fallback." Wrong. `mcp-server.mjs` serves
exactly `GET /sse` and `POST /message`. The chat-ui was fixed for precisely this
(`29bedad`). Use **`SSEClientTransport`**. The SSE `endpoint` event sends a bare
URI (`1a93b31`), and the preflight allows `mcp-protocol-version`,
`mcp-session-id`, `last-event-id` and exposes `mcp-session-id` (`0004ab7`).

### 3. 🔴 Structured `tool_calls` are not reliable — recovery parsing is required

v1 treated native `tool_calls` from `--jinja` as sufficient. Five fix commits say
otherwise. `tool-call-parser.ts` recovers calls emitted as:

| Shape | Example |
|---|---|
| canonical JSON | `{"name":"x","arguments":{…}}`, incl. inside `<tool_call>` or a ```` ```json ```` fence |
| braces | `create_document{…}` |
| xml | `<function=create_document>…</function>` |
| fn | `create_document(…)` |
| Python kwargs | `create_document(content='hi', format='md')` |
| **orphan arguments** | a bare args object whose tool is named only in the reasoning stream |
| **in the reasoning block** | the whole call inside `reasoning_content`, with the answer merely *claiming* it ran |

The last two silently lie to the user. Attribution is deliberately conservative —
an orphan payload is claimed only when exactly one available tool is named across
the turn.

**Vendor this module; do not reimplement it** (its unit tests come with it), and
consume `reasoning_content` as a separate stream — `src/nest/streaming.ts`
already does.

### 4. 🟠 Capabilities are per-profile AND globally configured

`ceb173a` made capability selection per-profile. A capability is live only when
the admin enabled it globally **and** the launched profile's `activeToolIds`
contains it. Consequence: **the Nest tool set is not static for the life of a
connection.** Re-fetch `/redstart/mcp-servers` and re-run `tools/list` on
reconnect and on any 502 — don't cache at connect.

### 5. 🟠 The gateway only claims capabilities when the request carries tools

`cccf6fc` — `buildSystemContext(config, hasTools)` returns bare identity text
unless `parsed.tools` is non-empty. Phase 1 sends no tools, which is why the
model correctly believes it cannot call anything today. The moment Phase 2 adds
tools, the gateway's injected system message grows a capability blurb. Budget for
it, and don't be surprised by text you didn't write at the head of the prompt.

### 6. 🟠 File-system write/destructive policy is a real, separate gate

`fileSystem.allowWrite` (default on) and `fileSystem.allowDestructive` (default
off) are enforced twice: blocked tools are filtered out of `tools/list` and
refused at `tools/call` with `isError` — non-bypassable. The approval UI must
render a **server denial distinctly from a user rejection**, and the model needs
to see the refusal reason so it stops retrying.

### 7. 🟡 `/files/download` serves two roots

`fileSystem.rootDir` **and** `documents.outputDir`. `403` = outside every root,
`404` = inside a root but no file, `400` = missing `path`. The distinction is
contractual; don't collapse it.

### 8. 🟡 Reuse the shared stdio supervisor for local MCP servers

v1 said to call `StdioClientTransport` directly. Since `592b5be` there is
`redstart-project/shared/mcp-stdio-process.mjs`, used by both Twig and Nest's own
filesystem provider — it owns spawn, log capture, crash detection, restart
policy. `filesystem-mcp-provider.mjs` is the reference consumer (note its
`ELECTRON_RUN_AS_NODE` + `process.execPath` spawn trick and explicit
`shouldRestart: () => false` so it drives its own handshake-on-restart). Prefer
its design — but **vendor the file**, don't reach across repos.

### 9. 🟡 `disabledTools` derives from profile-level tool IDs

`expandDisabledToolIds` expands admin-facing capability IDs into concrete
function names. The endpoint still returns a flat `string[]` — but it changes
with the active profile (see 4).

### 10. 🟢 Nest internals moved (no wire impact)

`electron/main/index.mjs` was decomposed into `ipc/*.mjs` + `gateway-config.mjs`.
Wire sources unchanged: `tools-gateway.mjs`, `beacon.mjs`, `auth.mjs`,
`mcp-server.mjs`.

---

# 6. Standalone-repo implications

Yellowscript is its own git repo, talking to Nest over HTTP like any other
client. Three things that were a relative import away now cross a repo boundary.

### Cross-repo code: copy, don't reach

`../../redstart-project/...` must never appear here. It breaks the moment either
repo moves and makes the extension unbuildable for anyone who cloned only this.

| To reuse | Answer |
|---|---|
| `shared/mcp-stdio-process.mjs` | **Vendor** into `src/mcp/stdio-process.ts` with a header naming origin repo, path, commit. Not needed until 5.4. |
| `chat-ui/.../tool-call-parser.ts` + tests | **Vendor**, same convention. Always was a port (the `ApiChatCompletionToolCall` import doesn't exist here). |
| `path-scope.mjs` containment semantics | **Reimplement** against VSCode's workspace-folder API. The *test cases* transplant; the code doesn't. |

If a third consumer appears, promote to a published `@redstart/*` package. Two
don't justify it — a vendored file with a provenance header is cheaper and honest
about what it is.

### The contract net doesn't run in CI here

`redstart-project`'s boundary suite gates that repo. A Nest change breaking a wire
shape will go **green here and fail at runtime**. Mitigations:

1. **`scripts/smoke.mjs`** — env-gated on `YELLOWSCRIPT_TEST_LIVE_NEST`. Asserts
   beacon payload, `/auth/config`, `/auth/me`, `/redstart/mcp-servers`,
   `/v1/models`, and that an unauthenticated request is refused.
2. **Version section 10.** Re-verify at the start of each phase. That discipline
   is what the v2 revision was; it should be routine, not a rescue.

### Coordinated changes need two PRs

Anything needing a Nest-side change is two repos with an ordering constraint:
**Nest ships first, Yellowscript degrades gracefully until it has.** Design every
Nest dependency so a missing endpoint becomes a disabled feature with a clear
status-bar reason, never a hard failure at connect.

---

# 7. Architecture and feature outline

```
VSCode
├─ Extension host (Node) — the brain
│   ├─ NestClient        discovery (beacon scan) · auth (SecretStorage) · SSE streaming
│   ├─ ToolCallParser    vendored from chat-ui — recovers malformed/reasoning-block calls
│   ├─ AgentLoop         messages+tools → stream → tool_calls → approval → execute → loop
│   ├─ Local tools       ws_* workspace fs / search / diagnostics / terminal / diff+checkpoint
│   ├─ McpHost           Nest MCP over SSE + local stdio servers (vendored supervisor)
│   └─ Storage           conversations, settings, per-workspace state
├─ Webview (sidebar)     chat UI: streaming markdown, tool-call cards, diff summaries
└─ Editor surfaces       diff review tabs · context-menu actions · status bar · code actions
```

Trust boundaries: the credential lives in **SecretStorage**, never in settings
JSON, never in model context. All local tools are **workspace-contained**. Nest's
`disabledTools` still strips banned names server-side and the MCP policy gate
still refuses blocked writes — central policy keeps working regardless of what
the IDE offers.

## A. Framework integration (consume Nest, never rebuild it)

1. **Connection manager** — beacon scan + manual URL fallback; persists
   per-workspace; status-bar indicator.
2. **Auth** — Redstart login or a pasted `rst_` key; `/auth/me` for identity;
   handles `authRequired:false`; SecretStorage.
3. **Model service** — `/v1/models`, streaming completions with `tools`, abort,
   `timings`, context-size awareness.
4. **Nest MCP host** — `SSEClientTransport` against the URL from
   `/redstart/mcp-servers`, same `Authorization` header; merge tools tagged by
   origin. **Re-list on every reconnect.**
5. **Central governance compliance** — surface denials rather than fighting them;
   never re-enable a banned tool client-side.
6. **Conversation sync** — local-first; optional `/conversations` push/pull in
   Phase 5.

## B. IDE-local tools — `ws_`-namespaced, workspace-contained, approval-gated

| Tool | Notes |
|---|---|
| `ws_read_file`, `ws_list_directory`, `ws_glob`, `ws_grep` | grep via VSCode's bundled ripgrep |
| `ws_write_file`, `ws_edit_file` (exact search/replace) | never applied directly — always through diff review |
| `ws_diagnostics` | Problems panel → model-readable |
| `ws_editor_context` | open files, selection, cursor |
| `ws_run_command` | integrated terminal, shell-integration capture, always-ask default |
| `ws_apply_diff` / checkpoints | shadow-git snapshot before each write batch → revert |

Plus local stdio MCP servers (config mirroring Twig's `twig-mcp.json`).

## C. Agentic loop

1. **System prompt assembly** — OS/shell, workspace tree summary
   (`.gitignore`-respecting), open editors, MCP server instructions. The gateway
   prepends its own block.
2. **Tool-call extraction** — structured `tool_calls` first; on a turn that
   produced none, the vendored parser over the answer, then orphan-argument
   recovery, then `reasoning_content`. **Never let a turn claim work it didn't
   do.**
3. **Context management** — token budget from the model's context size (32k on
   the reference rig); oldest-turn compaction (port the concept from chat-ui's
   `context-compaction.service`).
4. **Approval tiers** — reads auto; writes approve-with-diff; terminal
   always-ask; per-tool "always allow" persisted per workspace. Server denials
   render distinctly.
5. Turn cap, user abort, error surfacing.

## D. VSCode UX surfaces

Sidebar chat webview (slim, purpose-built — not the SvelteKit PWA); native diff
review tabs with Apply/Reject/Apply-all and checkpoint revert; editor context
menu (*Add to context*, *Explain*, *Fix*, *Refactor selection*) plus a
code-action provider; command palette; status bar; settings — secrets never in
settings.json.

## E. Safety model

- Workspace Trust: untrusted workspace → read-only tools, no terminal.
- Path containment on every `ws_*` fs tool. Note Nest's own filesystem provider
  re-validates **behind** the upstream server — do the same rather than trusting
  one layer.
- Terminal commands never auto-approved by default; shown verbatim.
- Redaction: `rst_` keys and `Authorization` headers scrubbed from anything
  entering model context or logs.
- `.yellowscriptignore` + `.gitignore` respected for context collection.

---

# 8. Phases and execution units

| Phase | Deliverable | Status |
|---|---|---|
| 0 | Repo skeleton, connection manager, auth, status bar | **done** `74ba476` |
| 1 | Sidebar chat with streaming (no tools) | **done** `ee83d7f`, demoed live |
| 2 | Read-only `ws_*` tools + agent loop + recovery parser + approval cards | **in progress** — 2.5/2.1/2.2 + registry done; 2.3 next |
| 3 | Write tools + diff review + checkpoints | |
| 4 | Terminal tool + Nest-MCP host merge | |
| 5 | Editor actions, conversation sync, local stdio MCP, modes | |

Each phase ends user-demoable.

### Working pattern

The local driver is Qwen3.6-35B-A3B Q4_K_XL (MoE, ~3B active) on a 12GB card,
32k context. Each unit should be its **own fresh session** pointed at a narrow
file set — not one long agentic run across a phase. 🟢 = mechanical enough to
hand to Qwen and review the diff. 🟡 = settle the design call first, then the
typing-out can still go to Qwen. Where a unit maps to an existing tested pattern,
that's the spec to point at — it turns "get this right" into "match this."

Don't chain units in one conversation: 32k fills fast once tool output and file
contents are in play, and a long unsupervised run is where a weaker model drifts
furthest from spec.

---

## Phase 2 — read-only tools, agent loop, approval  ← **you are here**

**Do 2.5 first.** The plan numbers it last; that ordering is wrong. Without
recovery parsing the agent silently narrates work it never did, so building the
loop first means designing it around an assumption that doesn't hold on this
hardware. Written order:

- **2.5 ✅ DONE** — `src/agent/tool-call-parser.ts`, vendored from
  `redstart-project/redstart-nest/src/chat-ui/` @ `a41c9d3` (readable right
  here — see the correction at the top). `parseToolCallsFromTurn(content,
  reasoningContent, config)` is what 2.3 must call as its fallback path, and
  `createApiToolCalls` maps the result onto `ToolCall` in `nest/types.ts`.
  Behaviour verified identical to the origin over 2496 differential cases.

  The plan predicted "the only edit is the `ApiChatCompletionToolCall` import".
  It was not: this repo sets `noUncheckedIndexedAccess`, so every regex capture
  group needed narrowing, and the vitest assertions were rewritten for
  `node --test`. **Budget for the same on the vendoring still ahead** (5.4's
  `mcp-stdio-process.mjs`), and verify non-cosmetic ports differentially rather
  than trusting the transplanted tests.

- **2.1 ✅ DONE** — the containment guard (`src/tools/workspace-path.ts`, 39
  tests including a 3000-input property fuzz) plus `ws_read_file`,
  `ws_list_directory`, `ws_glob`, `ws_grep`. Reimplemented rather than vendored:
  Nest confines to one root, a VSCode workspace can have several, so the
  invariant is "inside SOME workspace folder".

- **2.2 ✅ DONE** — `ws_diagnostics` and `ws_editor_context`, both taking VSCode
  state through an injected provider so the logic stays testable with no
  extension host.

- **Registry + wiring ✅ DONE** — `src/tools/registry.ts` assembles the six,
  renders the `tools` payload, and executes by name; `src/ui/tool-providers.ts`
  is the only file translating `vscode` into tool input. Built at activation.
  **Nothing is sent to the Nest yet** — that is 2.3.

### Facts established while building the tools — do not re-derive these

Each was measured, and each changed the code. They are cheap to break and
expensive to rediscover.

**Ripgrep is not where the obvious path says.** On VSCode 1.129 it is at
`<appRoot>/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/win32-x64/rg.exe`
— differing from the long-assumed `node_modules/@vscode/ripgrep/bin/rg` in four
ways at once, with `appRoot` itself commit-hashed. `locateRipgrep` probes every
known layout; never hardcode it. Confirmed resolving at runtime through
`vscode.env.appRoot` in a development host.

**`workspace.findFiles` does not respect `.gitignore`.** Its own docs apply
`files.exclude` "but not `search.exclude`", ignore files unmentioned. That is
why both search tools go through ripgrep instead — a glob that lists
`node_modules` and a grep that skips it would be an incoherent pair.

**Ripgrep needs `--no-require-git`.** By default it applies `.gitignore` only
inside a git repository, so a workspace folder that is not a checkout silently
returns every ignored file.

**A command-line `--glob` OUTRANKS `.gitignore` in ripgrep's precedence.** An
inclusive `-g '**/*.ts'` re-admits ignored files — every `.d.ts` under
`node_modules` — which is exactly the context flood the engine was chosen to
prevent. `ws_glob` therefore lists files unfiltered and matches client-side;
`ws_grep` passes its filter as a `--type`, which scopes without touching the
ignore rules. A regression test pins this, because reverting to `--glob` looks
like a simplification.

**Ripgrep is a safety choice, not a speed one.** `ws_grep`'s pattern comes from
the model, which can be influenced by file content it just read. A
catastrophically-backtracking JS `RegExp` runs synchronously on the extension
host event loop: no timeout stops it, nothing aborts it, VSCode freezes. Rust's
regex is linear by construction and runs in a killable child process. This is
why the no-ripgrep fallback is deliberately **literal-substring only** — a
JS-regex fallback would reintroduce the hazard.

**F5 opens no folder unless told to, and VSCode will not open one folder in two
windows.** Both cost real time. With no folder open every `ws_*` tool refuses
correctly and the extension looks broken; and pointing the development host at
this repo makes it hand focus to the ordinary window that already has it, so
the host closes itself. `launch.json` therefore opens `sample-workspace/` with
`--new-window` — see that folder's README.

- **2.3 🟡 `AgentLoop` core** — stream → detect `tool_calls` → execute → append →
  loop, with turn cap, abort, error surfacing. The architectural spine; design it
  deliberately before handing pieces to Qwen. It replaces the single
  `streamChatCompletion` call in `ChatSession.send` — the seam was left
  deliberately, so transcript handling, abort, and error reporting all stay as
  they are.

  Everything it needs now exists behind one interface: `createToolRegistry(…)`
  gives `payload()` for the request and `execute(name, rawArgs, ctx)` for the
  result, and `parseToolCallsFromTurn` is the fallback for a turn that produced
  no structured `tool_calls`. Two things to remember when wiring it: sending any
  tools changes the system context the gateway injects (correction 5), and a
  tool result must carry the `tool_call_id` it answers.

- **2.4 🟢 Approval-card UI**, reads auto-approved. New message types in
  `protocol.ts` — adding types is the designed extension path; do **not**
  repurpose `turn/delta`.

## Phase 3 — write tools, diff review, checkpoints

- 3.1 🟡 `ws_write_file` / `ws_edit_file` contracts — settle the diff payload
  shape first.
- 3.2 🟢 Diff review tabs via the native diff editor; Apply/Reject/Apply-all.
- 3.3 🟡 Shadow-git checkpoint + revert — the one place a bug destroys work; get
  the snapshot strategy right deliberately.
- 3.4 🟢 Approval tiers UI + per-workspace "always allow" persistence.

## Phase 4 — terminal, Nest-MCP merge

- 4.1 🟡→🟢 `ws_run_command`: settle shell-integration output capture and the
  always-ask default, then implement.
- 4.2 🟡 `McpHost`: `SSEClientTransport` to the URL from `/redstart/mcp-servers`,
  same auth header, re-list on reconnect. Spec: `test-mcp-capabilities.mjs` +
  `test-provider-conformance.mjs`.
- 4.3 🟢 Tool-set merge with a **disjointness assertion** (`ws_*` vs. Nest names)
  that throws loudly on collision, + "runs on Nest" origin tag.
- 4.4 🟢 `disabledTools` greying in the tool picker (UX only — the gateway does
  real enforcement) + distinct rendering for policy denials.

## Phase 5 — polish

- 5.1 🟢 Editor context-menu actions + code-action provider.
- 5.2 🟢 Command palette commands (new task, resume, connect, pick model, toggle
  auto-approve).
- 5.3 🟡 Conversation sync — decide conflict/merge behaviour first.
- 5.4 🟢 Local stdio MCP config, wired through the vendored
  `mcp-stdio-process.mjs`.
- 5.5 🟡 Modes — design surface, not yet scoped.

## Testing strategy

- `redstart-project`'s boundary suite is the **written-down spec** for every Nest
  shape consumed here — point implementing sessions at those files, but don't
  assume they protect this repo.
- Extension-side: containment tests for every `ws_*` tool, the SSE parser, the
  vendored tool-call parser, the tool-name disjointness assertion, approval-tier
  logic.
- **`npm run smoke`** before every release. It is the only thing standing between
  a Nest wire change and a runtime break.

---

# 9. Ground rules

Learned the hard way across Phases 0 and 1. Don't rediscover these.

**TypeScript parameter properties are unusable under `src/`.** Tests run through
Node's native type stripping, which erases types but does not transform code, so
`constructor(private readonly x: T)` is a runtime syntax error though `tsc`
accepts it happily. Declare the field, assign it in the body.

**`exactOptionalPropertyTypes` is on.** `obj.optional = maybeUndefined` does not
compile. Assign conditionally, or spread: `...(x ? { x } : {})`.

**There are two TypeScript projects.** `tsconfig.json` covers the extension host
(Node types, no DOM); `tsconfig.webview.json` covers `src/webview/main.ts` (DOM,
no Node types). Deliberate — one widened lib would let host code reach for
`document` and typecheck cleanly, failing only when a user hit that path.
`npm run typecheck` runs both. A new webview-only file must be added to the
webview project's `include`.

**Keep `vscode` out of the core.** `connection.ts`, `nest/*` and `chat/*` import
no `vscode` API, which is what makes them testable with no extension host. Put
`vscode` imports in `extension.ts`, `storage.ts`, and `ui/`.

**Never write invisible characters into source.** The markdown renderer's
sentinel is built with `String.fromCharCode(0xe000)` because a literal
private-use character silently vanished twice through the write path.

**Always pass `--test-timeout`.** `npm test` sets 10s; a hung test otherwise
blocks for the full harness timeout.

**Don't assume `fetch` aborts an in-flight read.** The streaming loop re-checks
`signal.aborted` before every `read()`. A stream that simply stops producing
would otherwise hang a turn forever with no way to cancel.

**Emit copies, not live objects.** `ChatSession` mutates a turn as it streams;
protocol messages are snapshots. Emitting the live object made "what did we
send?" unanswerable.

**Take final text from the stream result, not the delta callbacks.** The client
already assembled the authoritative string; deltas exist to paint the screen, not
to be the record. This matters from Phase 2 on, where recovering a malformed tool
call operates on the complete text.

**Block-level markdown rules run on ESCAPED text.** `>` is already `&gt;` by the
time `renderBlocks` sees it. Any new block rule matching a special character
needs the entity.

**The webview is a hostile document.** It renders model output. Strict
nonce-based CSP, no external origins, `localResourceRoots` limited to our own
folders, and the markdown renderer escapes input *before* applying any rule. New
rendering rules go after the escape, and never emit unescaped input.

---

# 10. Nest wire reference

Verified against `redstart-nest` @ `52fbf08` on 2026-08-05. Shapes marked ✔ are
pinned by that repo's test suite. **From the laptop, re-confirm via
`npm run smoke` — not by reading source.**

## Topology & ports

| Service | Port | Bind | Notes |
|---|---|---|---|
| Gateway (public API) | default **19080** | LAN | the ONLY port clients use |
| llama-server | gateway + 1 | 127.0.0.1 only | never address it directly |
| Built-in MCP server | gateway + 2 | LAN | discover via `/redstart/mcp-servers`, don't hardcode |
| Discovery beacon | fixed **8765** | LAN | HTTP GET, no auth |

## Discovery

`GET http://<ip>:8765/` (short timeout, ~400ms) answers exactly ✔:

```json
{ "app": "redstart-nest", "running": true, "port": 19080 }
```

Three fields, no more. `app` is the identification marker; `port` is the gateway
port. Build the connection URL from the responding IP plus that port — never from
a server-supplied URL.

## Auth

- `GET /auth/config` → ✔ `{ "authRequired": boolean }`. Public.
- `POST /auth/login` `{username, password}` →
  ✔ `{ token, user: { id, username, role, apiKeyPrefix, createdAt, lastLoginAt } }`.
  Exactly those fields, never a secret. 401 on bad credentials, with an
  **identical message for an unknown user** (no enumeration) — don't invent a
  distinction the server withholds.
- `Authorization: Bearer <value>` takes **either** a session token **or** an
  `rst_` key on the same header.
- `GET /auth/me` → ✔ `{ authRequired, user }`. `user` is null when auth is off.
- Sessions are **server-memory only** — a Nest restart invalidates every token.
- When `authRequired` is false, requests need no token (admin routes stay locked).
  There is **no localhost bypass** — auth applies from 127.0.0.1 too.
- Static assets (`/`, `/index.html`, `/_app/*`, known extensions) are unauthed.

## Completions

- `POST /v1/chat/completions` — OpenAI-compatible SSE. Send `tools` and
  `stream: true`.
- The gateway **prepends its own system message** and **strips centrally-banned
  tool names** from `tools`, `tool_choice`, and prior assistant `tool_calls`. If
  stripping empties `tools`, the key is deleted. Don't fight either.
- Injection merges into an existing system message (`context + "\n\n" + yours`)
  rather than adding a second.
- Capability claims appear **only when the request carries tools**.
- Malformed JSON body → 400 ✔ `{ error: { message, type } }`.
- Reasoning streams on `choices[0].delta.reasoning_content`, **separate** from
  `.content`. Tool calls hide there — consume it.
- `data: [DONE]` terminates.
- **Timings arrive at the chunk top level** (`chunk.timings`), not inside
  `choices`. They stream repeatedly; the last wins. Fields: `predicted_n`,
  `predicted_ms`, `prompt_n`, `prompt_ms`, `cache_n`. `predicted_per_second` may
  be present — prefer it, fall back to computing, and return null rather than
  Infinity when `predicted_ms` is 0.
- No llama-server running → **502** (auth still checked first).
- The gateway strips llama-server's reflected CORS origin and emits exactly one
  `*`.

## MCP

- `GET /redstart/mcp-servers` (authed) → `{ servers: [{ name, url }], disabledTools: string[] }`.
  The built-in server appears as `http://<host>:<gateway+2>/sse`. **This is the
  discovery mechanism** — never hardcode the port.
- **Transport is SSE only**: `GET /sse` + `POST /message`. No Streamable HTTP.
  The `endpoint` event carries a bare URI.
- Preflight allows `Content-Type, Authorization, mcp-protocol-version,
  mcp-session-id, last-event-id`; exposes `mcp-session-id`.
- `initialize` → `protocolVersion: '2024-11-05'`,
  `serverInfo: { name: 'redstart-fetch', version: '1.0.0' }`.
- `tools/list` entries are exactly `{ name, description, inputSchema }` ✔.
  Disabled capabilities are absent AND refused on direct `tools/call` — tested
  across all 8 providers (web fetch, postgres, documents, sqlite, vault, git,
  filesystem, scholar).
- Tools blocked by write/destructive policy are also filtered from `tools/list`
  and refused at `tools/call` with a human-readable reason.
- **The advertised set follows the active profile** — re-list on reconnect.
- `disabledTools` is UX guidance; the gateway strip is real enforcement.

### File System tool names (official server, pin 2026.7.10)

`read_file`, `read_text_file`, `read_media_file`, `read_multiple_files`,
`write_file`, `edit_file`, `create_directory`, `list_directory`,
`list_directory_with_sizes`, `directory_tree`, `move_file`, `search_files`,
`get_file_info`, `list_allowed_directories`.

**These are the names local tools must not reuse.** Re-audit if the pin moves.

## Other routes

- `GET/POST /conversations`, `GET/PUT/DELETE /conversations/:id` — account-scoped
  and isolation-tested. For Phase 5.
- `GET /files/download?path=<rel>` (authed) — streams from **either** the File
  System root or the Documents output dir. `400` missing path, `403` outside
  every root, `404` inside a root but no file.
- CORS allows `Authorization`, so a webview *could* call directly — but the
  extension host owns every request so the credential never enters the webview.
