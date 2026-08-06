// =============================================================================
// The system message Yellowscript sends.
// =============================================================================
// Added after the first live agentic session, in which the model stated it
// could "edit files" and "create documents (.docx, .pdf, .markdown)" — neither
// true. That text came from the gateway's own injected context, which describes
// what NEST has configured rather than what the client actually forwards. The
// consequence is the worst kind of failure this project has: the model reports
// having saved a file, nothing happens, and nothing errors.
//
// The gateway merges an existing system message rather than adding a second
// (`context + "\n\n" + yours`), so this narrows the claim instead of fighting it.
//
// WRITTEN TO NOT GO STALE. The tool list is passed in, never hardcoded, and the
// limits are phrased against that list ("only the tools listed above") rather
// than enumerated ("you cannot write files"). When Phase 3 adds write tools they
// appear in the list and every sentence here is still true. A prompt that named
// its own restrictions would need editing in lockstep with the tool set, and
// would be wrong the first time someone forgot — which is exactly the bug this
// exists to fix, one level up.
//
// This is also where architecture item C.1 grows: the workspace tree summary and
// open-editor context belong in this message.
// =============================================================================

/**
 * Build the system message for a request that carries `toolNames`.
 *
 * Only meaningful when tools are actually being sent: the gateway returns bare
 * identity text for a request with no tools, and there is nothing to correct.
 */
export function buildSystemPrompt(toolNames: readonly string[]): string {
  const tools = [...toolNames].sort()

  const lines = [
    'You are running inside Yellowscript, a Visual Studio Code extension.',
    'The user is working in an editor with a workspace folder open, and reads your',
    'replies in a sidebar panel next to their code.',
    '',
    'The tools available to you in this session are exactly these:',
    '',
    ...tools.map((name) => `  - ${name}`),
    '',
    // Phrased against the list, not against a fixed set of prohibitions, so it
    // stays correct as the tool set grows.
    'That list is complete. You have no other capabilities here: if you cannot',
    'name a tool above that does something, you cannot do it in this session,',
    'whatever you may have been told elsewhere about what this server can do.',
    '',
    'Never state or imply that you have used a tool you did not actually call, and',
    'never describe work as done when no tool call produced it. If you are asked',
    'for something you have no tool for, say so plainly and suggest what you can',
    'do instead.',
    '',
    'File paths are relative to the workspace folder. Prefer reading a file over',
    'guessing at its contents, and prefer checking diagnostics over assuming code',
    'compiles.',
  ]

  return lines.join('\n')
}
