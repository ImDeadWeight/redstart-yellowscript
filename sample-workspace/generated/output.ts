// Gitignored build output. ws_glob and ws_grep must never return this file —
// if they do, .gitignore handling has regressed.
export const GENERATED_SENTINEL = 'should-never-appear-in-tool-output'
