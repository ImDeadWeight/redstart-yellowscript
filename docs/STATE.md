# Where we left off

**Last updated: 2026-08-06.**
Repo state: typecheck clean (both projects), **131 unit tests passing**, both
bundles build. Phase 1 complete and committed.

---

## Done

### Phase 0 — `74ba476`
Connection, authentication, status bar.

### Phase 1 — complete
Streaming chat in the sidebar, end to end.

| Unit | Files |
|---|---|
| 1.1 message contract | `src/chat/protocol.ts` |
| 1.2 SSE streaming + abort + reasoning channel | `src/nest/streaming.ts`, `streamChatCompletion` in `src/nest/client.ts` |
| 1.3 webview chat UI | `src/webview/main.ts`, `src/webview/markdown.ts`, `src/ui/chat-view.ts`, `media/chat.css` |
| 1.4 models + timings → status bar | `refreshModel()` and the emit hook in `src/extension.ts` |
| session/transcript | `src/chat/session.ts` |

---

## Next: Phase 2 — read-only tools and the agent loop

Per `docs/PLAN.md`. Suggested order:

1. **2.5 first, not last.** Vendor `tool-call-parser.ts` and its tests from
   `redstart-project/redstart-nest/src/chat-ui/src/lib/utils/`. It is the thing
   that makes the agent loop survive a local model, and having it in place before
   the loop exists means the loop can be written against it rather than retrofitted.
   Add a provenance header (source repo, path, commit).
2. **2.1 / 2.2 the `ws_*` tools** — `ws_read_file`, `ws_list_directory`,
   `ws_glob`, `ws_grep`, `ws_diagnostics`, `ws_editor_context`. One per session,
   each with a containment test. **The `ws_` prefix is mandatory** — see the
   collision note below.
3. **2.3 the agent loop.** Replace the single `streamChatCompletion` call in
   `ChatSession.send`. The seam was left deliberately: transcript handling,
   abort, and error reporting all stay as they are.
4. **2.4 approval cards** — new message types in `protocol.ts`. Adding types is
   the designed extension path; do not repurpose `turn/delta`.

### The tool-name collision (read before naming anything)

Nest's File System capability is the official
`@modelcontextprotocol/server-filesystem`, which advertises `read_file`,
`write_file`, `edit_file`, `list_directory`, `search_files`, `directory_tree`
and more. Six of those clash with the obvious names for IDE-local tools, and a
clash is silent and dangerous: the model asks for `write_file` meaning the
workspace and gets the Nest's configured root instead. Hence `ws_*` on every
local tool, plus a disjointness assertion when the two sets merge in Phase 4.

---

## Things learned the hard way (don't rediscover these)

**TypeScript parameter properties are unusable under `src/`.** Tests run through
Node's native type stripping, which erases types but does not transform code —
`constructor(private readonly x: T)` is a runtime syntax error though `tsc`
accepts it. Declare the field, assign it in the body.

**`exactOptionalPropertyTypes` is on.** `obj.optional = maybeUndefined` does not
compile. Assign conditionally, or spread: `...(x ? { x } : {})`.

**There are two TypeScript projects.** `tsconfig.json` covers the extension host
(Node types, no DOM); `tsconfig.webview.json` covers `src/webview/main.ts`
(DOM, no Node types). This is deliberate — a single widened lib would let host
code reach for `document` and still typecheck. `npm run typecheck` runs both.
If you add a webview-only file, add it to the webview project's `include`.

**Don't write invisible characters into source.** The markdown renderer's
placeholder sentinel is built with `String.fromCharCode(0xe000)` because a
literal private-use character silently vanished twice through the editor/write
path.

**Always pass `--test-timeout`.** `npm test` sets 10s. A hung test otherwise
blocks for the full harness timeout.

**Don't assume `fetch` aborts an in-flight read.** The streaming loop re-checks
`signal.aborted` before every `read()`. A stream that simply stops producing
would otherwise hang a turn forever with no way to cancel.

**Emit copies, not live objects.** `ChatSession` mutates a turn as it streams;
protocol messages are snapshots. Emitting the live object made "what did we
send?" unanswerable and broke a test in a genuinely confusing way.

**Block-level markdown rules run on ESCAPED text.** `>` has already become
`&gt;` by the time `renderBlocks` sees it. Any new block rule matching a special
character needs the entity, not the raw character.

---

## Verified Nest wire facts this code depends on

Confirmed by reading `redstart-nest` @ `52fbf08`, not assumed:

- Timings arrive at the **chunk top level** (`chunk.timings`), not inside
  `choices`. They stream repeatedly; the last wins.
- Fields are `predicted_n` / `predicted_ms` / `prompt_n` / `prompt_ms` /
  `cache_n`. `predicted_per_second` may also be present — prefer it, fall back to
  computing, and return null rather than Infinity when `predicted_ms` is 0.
- Reasoning streams on `choices[0].delta.reasoning_content`, separate from
  `.content`.
- `data: [DONE]` terminates the stream.
- A request carrying **no** `tools` makes the gateway omit its capability claims
  from the injected system prompt. Phase 1 sends no tools, so this is correct —
  it stops being correct the moment Phase 2 adds them, which is the point.
- The gateway prepends its own system message to whatever we send. Budget for it.

---

## Still outstanding

**0.5 — the manual smoke test has never been run.** It needs a real Nest:

```bash
YELLOWSCRIPT_TEST_LIVE_NEST=http://<ip>:19080 YELLOWSCRIPT_TEST_TOKEN=rst_... npm run smoke
```

This is the only thing in this repo that will notice if the Nest's wire format
drifts — we do not run `redstart-project`'s boundary suite. **Phase 1 has also
never been run against a live Nest**, only against scripted streams in tests.
Worth doing both before building Phase 2 on top.
