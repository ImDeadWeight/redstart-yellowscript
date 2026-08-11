// =============================================================================
// Approval tiers and per-workspace "always allow" — the testable core.
// =============================================================================
// HANDOFF 3.4: reads auto-approved; writes go through diff review; terminal is
// always-ask (Phase 4); and each tool the user approves with "always allow" is
// remembered per workspace so a long edit session is not a wall of dialogs.
//
// This module is the POLICY, kept `vscode`-free so it is unit-testable with a
// plain map. The actual storage lives behind `ApprovalStore` (implemented by
// `vscode.WorkspaceConfiguration` in ui/), and the per-tool gate is a pure
// function: given a tool name and the remembered set, is it auto-approved?
//
// Why per-WORKSPACE and not global: a user may trust writes in their own repo
// but not in a throwaway scratch folder they opened to read a single file. A
// remembered "always allow ws_edit_file" that followed them to an untrusted
// workspace would defeat the review gate exactly where it matters most.
//
// No `vscode` import.
// =============================================================================

/** Tools that write to the workspace. These are the ones a user can choose to
 *  "always allow" — reads never prompt, terminal is never auto-approved. */
export const WRITABLE_TOOLS = ['ws_write_file', 'ws_edit_file'] as const
export type WritableTool = (typeof WRITABLE_TOOLS)[number]

/** True for a tool name that belongs to the write tier. */
export function isWritableTool(name: string): name is WritableTool {
  return (WRITABLE_TOOLS as readonly string[]).includes(name)
}

/** Backing store for remembered approvals. Implemented by workspace settings;
 *  faked in tests. */
export interface ApprovalStore {
  /** The set of tool names the user has chosen to always allow, in THIS
   *  workspace. */
  getAllowedTools(): readonly string[]
  setAllowedTools(tools: readonly string[]): void
}

/**
 * Decide whether a write tool needs a prompt.
 *
 * Returns `true` to skip the diff review (auto-apply) when the user has
 * previously allowed this exact tool in this workspace. Anything unknown falls
 * through to `false` — the safe default — because a missing memory must never
 * become a silent write.
 */
export function isAutoApproved(store: ApprovalStore, toolName: string): boolean {
  if (!isWritableTool(toolName)) return false
  return store.getAllowedTools().includes(toolName)
}

/** Remember a tool as always-allowed in this workspace. Idempotent. */
export function rememberApproval(store: ApprovalStore, toolName: string): void {
  if (!isWritableTool(toolName)) return
  const current = store.getAllowedTools()
  if (current.includes(toolName)) return
  store.setAllowedTools([...current, toolName])
}

/** Forget a previously remembered approval (e.g. "ask me again"). */
export function forgetApproval(store: ApprovalStore, toolName: string): void {
  store.setAllowedTools(store.getAllowedTools().filter((name) => name !== toolName))
}
