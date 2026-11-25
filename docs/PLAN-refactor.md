# Plan: breaking up the god files

*As of 2026-11-24. Comes before [PLAN-agent-runtime.md](PLAN-agent-runtime.md),
whose benchmark work depends on item 1h. The Composer part (item 4) started in
[PR #6](https://github.com/ImDeadWeight/redstart-yellowscript/pull/6)
(`feat/turn-timeline-ui`); start this work from `main` once that is merged.*

**Goal.** Every subsystem has one owner and receives what it needs explicitly,
instead of reaching for module-level state. No behaviour changes: each step is
one commit, and `npm run check` passes after every one.

**Why now.** File size alone would not justify doing this first. The reason is
that the agent is assembled twice:

- The product builds it in `getSession()` in `extension.ts`: about 150 lines
  wiring the run log, workspace context, notes, live process state, command
  classification and diagnostics after each write.
- The benchmark builds its own in `src/bench/harness.ts`, calling
  `runAgentLoop` directly with `diagnostics: () => []` and none of that wiring.

So the benchmark does not measure what ships. Until there is one setup, every
agent-runtime fix has to be wired in twice. Item 1h removes the duplication.

---

## Status

| # | Item | Size today | Blocks | State |
|---|---|---|---|---|
| 1 | Break up `extension.ts` | 1,914 lines; 21 module-level variables; `activate()` ≈ 330 lines | Agent plan item 1 (through 1h) | Done on `refactor/god-files`: 247 lines, one `Host`; steps a–h plus `host/chat-handlers.ts` and `host/agent-setup.ts` |
| 2 | Split `process-runner.ts` | 776 lines | Nothing | Done: `tools/command-run.ts`, `tools/background-processes.ts` |
| 3 | Split the browser code from the page check | `browser-check.ts` 573 lines | Nothing | Done: `browser/cdp.ts`, `browser/page-check.ts`, `tools/check-page-tool.ts` |
| 4 | Pull attachment handling out of the Composer | 463 → 418 lines | Nothing | Done: `ComposerMenu.svelte`; Composer 418 → 313 lines |
| 5 | `ChatSession` and `agent/loop.ts` | 801 / 646 lines | — | Deferred on purpose (see item) |

Items 2 and 3 block nothing. They can be done between any of the other work.

---

## 1 — Break up `extension.ts`

**Approach.**

- The 21 module-level variables (`manager`, `chatView`, `sessions`,
  `conversations`, `mergedTools`, `tasks`, `lastCheckpoint`…) become fields of
  one `Host` object built in `activate()`. Each new module gets the parts it
  uses, passed in, never the whole object.
- Start with the self-contained pieces, so the file shrinks before the tangled
  core is touched.
- A module that needs to tell another one something does it through a callback
  passed in at construction. Modules do not import each other's globals.

| Step | New module | Takes over (today's functions) |
|---|---|---|
| a | `host/projects.ts` | `linkScope`, `linkedProject`, `pushProjects`, `linkProject`, `createProjectFromPanel`, `pushWorkflows`, `runWorkflow` |
| b | `host/tasks.ts` | `lastCheckpoint`, `tasks`, `taskFor`, the revert commands, `openTaskDiff`, `revertTask`, the workspace plan file |
| c | `host/editor-actions.ts` | `resolveAttachments`, `searchWorkspaceFiles`, `addSelectionToChat`, `fixDiagnostic` |
| d | `host/connection-commands.ts` | connect, disconnect, the sign-in flows, sign-out, show status, the server URL prompt, `onStateChanged`, `refreshModel` |
| e | `host/tooling.ts` | the tool registry, ripgrep, the MCP host, merged tools, background processes, `pushTools`, Inspect Tools |
| f | `host/surfaces.ts` | the sidebar strip and editor tabs: `createConversation`, `showIn`, `openChatInEditor`, the move commands, `retire`, `closeConversation`, `vacate`, history, `targetSurface` |
| g | `host/sessions.ts` | the `sessions` map, `getSession`, `sendTo`, `persistConversation`, `snapshot`, `contextFor` |
| h | **`agent/compose.ts`** (no `vscode` import) | everything `getSession` assembles for one chat's agent, behind small interfaces: diagnostics, approvals, the command gate, workspace context, live state. The extension supplies the VS Code-backed implementations; the benchmark supplies headless ones. |

**Target.** `extension.ts` under about 250 lines: build the `Host`, register
the commands, `deactivate`.

**Risk.** Steps f and g. Surfaces, sessions and `ChatViewProvider` call into
each other: a session emits to a surface, a surface switches which session it
shows, history reads both. The cycle is broken with a narrow interface that
`sessions.ts` takes (emit to a conversation, the conversation changed), rather
than an import in each direction.

**Tests.** Each extracted module that has no `vscode` dependency gets the
tests it can have under `node --test` (`snapshot`, choosing which surface
gets a message, `compose`). The rest is checked by the existing suite passing
unchanged and one manual F5 run after steps f–h.

---

## 2 — Split `process-runner.ts`

The file already has two halves, divided by the "Every process Yellowscript
starts" banner.

- **`tools/command-run.ts`**: one-shot runs. `runCommandLine`, `spawnShell`,
  `killTree`, `looksLikePrompt`, `formatCommandRun`, `capHeadTail`,
  `runFailed`, the labels.
- **`tools/background-processes.ts`**: `BackgroundProcesses`,
  `startInBackground`, `detectServerUrl`, `describeRunning`,
  `formatProcessList`, `describeKillTargets`.
- `shellNote` goes wherever its one caller is.

Nine files import from it; update them directly instead of keeping
`process-runner.ts` as a re-export shim.

---

## 3 — Split the browser code from the page check

The goal is that the DevTools Protocol code knows nothing about the
Yellowscript tool interface.

- **`browser/cdp.ts`**: the `Cdp` client, `launch`, `browserCandidates`,
  `findBrowser`.
- **`browser/page-check.ts`**: `checkPage`, the page summary script,
  `formatPageCheck`, `resolveTarget`.
- **`tools/check-page-tool.ts`**: `createCheckPageTool`, the only part that
  imports the tool types. `page-steps.ts` stays as it is.

The UI harness used to verify `feat/turn-timeline-ui` (headless Chrome driven
over CDP) could later reuse `browser/cdp.ts`.

---

## 4 — Pull attachment handling out of the Composer

Done in PR #6 (`feat/turn-timeline-ui`):

- `webview/images.ts`: reading, downscaling and limiting images.
- `AttachmentChips.svelte`: the chips and the "cannot read images" note.
- `AttachButton.svelte`: the paperclip menu.

Left: the `/` workflow menu and the `@` file menu share their markup and
keyboard handling. One `ComposerMenu.svelte` would take about 120 lines out
of `Composer.svelte`.

---

## 5 — `ChatSession` and `agent/loop.ts`: deferred

Left alone until the agent-runtime work shows where their responsibilities
actually separate.

**Rule meanwhile.** Each new agent feature gets its own module (for example
`agent/stagnation.ts`), and `loop.ts` only wires it in. Then the eventual
split is mostly moving the wiring.
