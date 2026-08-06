# Sample workspace

The folder F5 opens in the Extension Development Host. It exists so that
pressing F5 gives you somewhere the `ws_*` tools can actually work.

**Do not point the launch config at the Yellowscript repo itself.** It was tried
and it is a bad test workspace on three counts: it is large enough to spin up a
full TypeScript language server in a second window, `npm run watch` is rewriting
`dist/` underneath it the whole time, and it is normally already open in another
window. Once, it took the extension host down with it.

This folder is deliberately tiny, and each file is here to exercise something:

| Path | What it is for |
|---|---|
| `src/greeting.ts` | Has a **deliberate type error**, so `ws_diagnostics` returns something. Open it to make the language server report. |
| `src/util.ts` | A second clean file, so listings and globs have more than one result. |
| `generated/output.ts` | Ignored by `.gitignore`. `ws_glob "**/*.ts"` must **not** return it — that is the ignore handling working. |

The type error is intentional. It is outside `tsconfig.json`'s `include`, so it
never reaches `npm run typecheck`.

## Checking the tools by hand

With this folder open in the development host, run **Yellowscript: Inspect
Workspace Tools** from the command palette. It writes what the model would
receive to the output channel. Expect:

- `ws_glob "**/*.ts"` → `src/greeting.ts` and `src/util.ts`, and **not**
  `generated/output.ts`.
- `ws_diagnostics` → the error in `greeting.ts`, once that file is open.
- `ws_editor_context` → whatever you have focused, with 1-based line and column.
