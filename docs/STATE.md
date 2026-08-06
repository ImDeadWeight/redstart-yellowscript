# Handoff — start here

**Last updated: 2026-08-06.** Phases 0 and 1 are complete and pushed.
Typecheck clean (both projects), **131 unit tests passing**, both bundles build.

---

## 0. Orientation

Yellowscript is a VSCode coding agent that talks to a **local Redstart Nest**
(the user's private, on-premises AI server) instead of a cloud. Nest owns auth,
models, providers and discovery; Yellowscript owns only IDE-domain logic —
workspace context, editor integration, diffs, the agentic UX.

Read in this order:

1. This file.
2. `docs/PLAN.md` — the roadmap, the phase breakdown, and an appendix of Nest's
   wire contracts.
3. `README.md` — commands, settings, and the development loop.

```bash
npm install
npm run check     # typecheck both projects + tests. Must be green before you start.
npm run watch     # what F5 uses
```

## 1. This is now a two-machine setup

**Nest runs on the user's main PC. Yellowscript is developed on the laptop.**
Three consequences, and the third is the important one.

**The Nest is reachable over the LAN, not locally.** Beacon discovery sweeps the
laptop's own subnets, so both machines must be on the same network. If they are
not (different subnets, a VPN in between), discovery finds nothing — that is not
a bug. Set `redstartYellowscript.serverUrl` to `http://<pc-ip>:19080` explicitly;
that path exists and is tested.

**Nothing here has ever run against a real Nest.** Phases 0 and 1 were built and
tested entirely against scripted streams and fake clients. Before building
anything on top of them, run both:

```bash
YELLOWSCRIPT_TEST_LIVE_NEST=http://<pc-ip>:19080 YELLOWSCRIPT_TEST_TOKEN=rst_... npm run smoke
```

and press F5 to try the panel against a live model.

**You can no longer read the Nest's source to check a wire fact.** Every claim in
`docs/PLAN.md`'s appendix was verified by reading `redstart-nest` at commit
`52fbf08` — a repo that lives on the *other* machine. From the laptop that
verification path is gone, which changes the working method:

- Treat the appendix as the spec, and treat `scripts/smoke.mjs` as the only way
  to confirm it still holds. Extend the smoke test whenever you depend on a new
  shape.
- Do **not** guess at a Nest behaviour that isn't documented there. Ask the user
  to check on the PC, or add a smoke assertion and run it.
- If a smoke assertion fails, the Nest has drifted — fix Yellowscript to match
  reality, and update the appendix with the date and what changed.

## 2. What exists

### Phase 0 — `74ba476`
Discovery, authentication, status bar.

| Module | Role |
|---|---|
| `src/nest/discovery.ts` | Beacon sweep + strict payload validation |
| `src/nest/client.ts` | Every HTTP call to the gateway |
| `src/nest/types.ts` | Wire shapes + `NestHttpError` |
| `src/connection.ts` | The connect/authenticate state machine |
| `src/storage.ts` | SecretStorage + workspace state |
| `src/ui/status-bar.ts` | Connection, model, tokens/sec |

The auth state machine exists mainly to **disambiguate 401**. Nest keeps session
tokens in memory only, so restarting it to load a different model invalidates
every one — the most common 401 by far, and it means "sign in again", not "wrong
password". A rejected `rst_` key means the opposite: re-prompting for the same
key just loops. The credential kind is stored alongside the credential so the UI
can say which. Nine tests pin this.

### Phase 1 — `ee83d7f`
Streaming chat in the sidebar.

| Module | Role |
|---|---|
| `src/chat/protocol.ts` | The extension↔webview message contract |
| `src/chat/session.ts` | Transcript + turn lifecycle |
| `src/nest/streaming.ts` | SSE splitting and chunk parsing |
| `src/webview/main.ts` | The renderer |
| `src/webview/markdown.ts` | Purpose-built safe markdown |
| `src/ui/chat-view.ts` | View provider + CSP shell |

## 3. Next: Phase 2 — read-only tools and the agent loop

Full detail in `docs/PLAN.md`. Suggested order, which differs from the plan's
numbering for a reason:

**1. Vendor the tool-call parser FIRST (plan unit 2.5).**
Copy `tool-call-parser.ts` and its tests from
`redstart-project/redstart-nest/src/chat-ui/src/lib/utils/` — that repo is on the
user's PC, so you will need them to hand it over. Add a provenance header naming
the source repo, path and commit.

Why first: Nest drives quantized MoE models on consumer GPUs, and those emit tool
calls in half a dozen malformed shapes — Python kwargs, bare argument objects,
and worst of all **calls made entirely inside the reasoning block while the
visible answer merely claims the call ran**. Without recovery parsing the agent
silently narrates work it never did. Building the loop first and retrofitting
this means designing the loop around an assumption that does not hold.

`src/nest/streaming.ts` already captures `reasoning_content` on its own channel
specifically so this parser has something to work with.

**2. The `ws_*` tools (2.1, 2.2).**
`ws_read_file`, `ws_list_directory`, `ws_glob`, `ws_grep`, `ws_diagnostics`,
`ws_editor_context`. One per session, each with a containment test.

> **The `ws_` prefix is mandatory.** Nest's File System capability is the
> official `@modelcontextprotocol/server-filesystem`, advertising `read_file`,
> `write_file`, `edit_file`, `list_directory`, `search_files`, `directory_tree`
> and more. Six clash with the obvious names for IDE-local tools, and a clash is
> silent and dangerous: the model asks for `write_file` meaning the workspace and
> gets the Nest's configured root instead. Phase 4 adds a disjointness assertion
> when the two sets merge.

Containment: workspace folders only, reject traversal and symlink escapes. Nest's
own filesystem provider re-validates behind the upstream server rather than
trusting one layer — do the same.

**3. The agent loop (2.3).**
Replace the single `streamChatCompletion` call in `ChatSession.send`. The seam
was left deliberately: transcript handling, abort, and error reporting all stay
as they are. Structured `tool_calls` first, then the fallback parser on a turn
that produced none.

Note that adding `tools` to the request **changes the gateway's behaviour**: it
only claims Nest capabilities in its injected system prompt when a request
actually carries them. Phase 1 sends none, which is why the model correctly
believes it cannot call anything today.

**4. Approval cards (2.4).**
New message types in `protocol.ts`. Adding types is the designed extension path —
do not repurpose `turn/delta`. Reads auto-approve; writes and terminal do not.
Render a *server* denial (a `disabledTools` strip, or the write/destructive
policy gate) distinctly from a user rejection, and let the model see the refusal
reason so it stops retrying.

## 4. Ground rules (learned the hard way — don't rediscover these)

**TypeScript parameter properties are unusable under `src/`.** Tests run through
Node's native type stripping, which erases types but does not transform code, so
`constructor(private readonly x: T)` is a runtime syntax error though `tsc`
accepts it happily. Declare the field, assign it in the body. This bit three
constructors.

**`exactOptionalPropertyTypes` is on.** `obj.optional = maybeUndefined` does not
compile. Assign conditionally, or spread: `...(x ? { x } : {})`.

**There are two TypeScript projects.** `tsconfig.json` covers the extension host
(Node types, no DOM); `tsconfig.webview.json` covers `src/webview/main.ts` (DOM,
no Node types). Deliberate — one widened lib would let host code reach for
`document` and typecheck cleanly. `npm run typecheck` runs both. A new
webview-only file must be added to the webview project's `include`.

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

**Block-level markdown rules run on ESCAPED text.** `>` is already `&gt;` by the
time `renderBlocks` sees it. Any new block rule matching a special character
needs the entity.

**The webview is a hostile document.** It renders model output. Strict
nonce-based CSP, no external origins, `localResourceRoots` limited to our own
folders, and the markdown renderer escapes input *before* applying any rule. New
rendering rules go after the escape, and never emit unescaped input.

## 5. Nest wire facts this code depends on

Verified against `redstart-nest` @ `52fbf08` on 2026-08-05. **Re-confirm via
`npm run smoke`, not by reading source — that repo is on the other machine.**

- Beacon on fixed port **8765** answers exactly
  `{ app: 'redstart-nest', running, port }` — three fields, no more. `app` is the
  identification marker; `port` is the gateway port. Build the URL from the
  responding IP plus that port.
- Gateway default **19080**. llama-server is on +1 bound to loopback (never
  address it). MCP is on +2 but must be discovered via `/redstart/mcp-servers`.
- `Authorization: Bearer <value>` takes **either** a session token or an `rst_`
  key on the same header.
- Sessions are server-memory only; a Nest restart invalidates them. No localhost
  bypass — auth applies from 127.0.0.1 too.
- Timings arrive at the **chunk top level** (`chunk.timings`), not inside
  `choices`. They stream repeatedly; the last wins. Fields: `predicted_n`,
  `predicted_ms`, `prompt_n`, `prompt_ms`, `cache_n`. Prefer
  `predicted_per_second` when present; return null rather than Infinity when
  `predicted_ms` is 0.
- Reasoning streams on `choices[0].delta.reasoning_content`, separate from
  `.content`. `data: [DONE]` terminates.
- The gateway prepends its own system message to whatever we send, and strips
  centrally-banned tool names from `tools`, `tool_choice`, and prior
  `tool_calls`. Don't fight either.
- Nest MCP is **SSE only** (`GET /sse` + `POST /message`) — no Streamable HTTP.
- The advertised tool set follows the Nest's **active profile**, so it changes
  when the operator switches profiles. Re-list on reconnect; don't cache at
  connect.
