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
// remembered "always allow ys_edit_file" that followed them to an untrusted
// workspace would defeat the review gate exactly where it matters most.
//
// No `vscode` import.
// =============================================================================

/** Tools that write to the workspace. These are the ones a user can choose to
 *  "always allow" — reads never prompt, terminal is never auto-approved. */
export const WRITABLE_TOOLS = ['ys_write_file', 'ys_edit_file'] as const
export type WritableTool = (typeof WRITABLE_TOOLS)[number]

/**
 * The prefix the local tools carried before they took Nest's reserved `ys_`
 * namespace (redstart-project docs/tool-namespacing.md). Saved settings and old
 * transcripts still hold names under it.
 */
export const LEGACY_TOOL_PREFIX = 'ws_'

/** Map a pre-rename `ws_*` name to its `ys_*` name; anything else unchanged. */
export function migrateToolName(name: string): string {
  return name.startsWith(LEGACY_TOOL_PREFIX) ? `ys_${name.slice(LEGACY_TOOL_PREFIX.length)}` : name
}

/** A remembered tool list with legacy names migrated and duplicates removed. */
export function migrateToolNames(names: readonly string[]): string[] {
  return [...new Set(names.map(migrateToolName))]
}

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

/**
 * Why a planned write may skip review, or null when it must be shown.
 *
 * - A deletion is ALWAYS shown, whatever was granted: "always allow" on an
 *   edit tool must never become a silent delete. So is a write to a path that
 *   decides what runs (`alwaysAsk`, protected-paths.ts).
 * - `task`: the person chose "Apply all in this task" earlier in the same run.
 * - `always`: the tool is remembered as always-allowed in this workspace.
 */
export function autoApplyReason(
  write: { toolName: string; deletes: boolean; alwaysAsk?: boolean },
  store: ApprovalStore,
  taskTrusted: boolean,
): 'task' | 'always' | null {
  // Protected paths (settings, tasks, package.json scripts) ask like a deletion.
  if (write.deletes || write.alwaysAsk) return null
  if (taskTrusted) return 'task'
  return write.toolName && isAutoApproved(store, write.toolName) ? 'always' : null
}

/** Run-scoped trust: "Apply all in this task" lasts until the run ends. */
export interface TaskTrust {
  trusted(): boolean
  trust(): void
}

// ---------------------------------------------------------------------------
// Commands the person allowed to run without asking (per workspace).
// ---------------------------------------------------------------------------

/**
 * Shell syntax that makes one line do more than its first command: chaining,
 * pipes, redirection, substitution, a second line. A line with any of it never
 * matches an allowed prefix, so "npm test && rm -rf ~" is not "npm test".
 */
export const SHELL_COMPOSITION = /&&|\|\||[;|&<>`\n\r]|\$\(|\$\{/

/** True when `command` may run without a prompt under `allowed` prefixes. */
export function isCommandAllowed(command: string, allowed: readonly string[]): boolean {
  // Checked on the raw line: collapsing whitespace first would turn a second
  // line into a space and let "npm test" + newline + "rm -rf ~" through.
  if (SHELL_COMPOSITION.test(command)) return false
  const line = command.trim().replace(/\s+/g, ' ')
  if (line === '') return false
  return allowed.some((raw) => {
    const prefix = raw.trim().replace(/\s+/g, ' ')
    return prefix !== '' && (line === prefix || line.startsWith(`${prefix} `))
  })
}

/** Programs whose first argument is code to run: only the exact line is safe. */
const INTERPRETERS = new Set(['node', 'deno', 'bun', 'python', 'python3', 'py', 'ruby', 'perl', 'bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd', 'php'])
/** Package runners whose "run"/"exec" names the script that matters. */
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const RUNNER_VERBS = new Set(['run', 'run-script', 'exec', 'x', 'dlx'])

/**
 * The prefix to offer for "always allow": as narrow as still useful.
 * - "npm test", "npx tsc", "git status": the program and its subcommand.
 * - "npm run build": the script is part of it ("npm run" would allow any).
 * - "node scripts/x.mjs": an interpreter runs whatever it is given, so only
 *   the exact line.
 * - A flag or a path where a subcommand would be: the exact line.
 * Null when the line composes commands, so there is nothing safe to offer.
 */
export function allowPrefixFor(command: string): string | null {
  if (SHELL_COMPOSITION.test(command)) return null
  const line = command.trim().replace(/\s+/g, ' ')
  if (line === '') return null
  const words = line.split(' ')
  const program = words[0]!.toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
  const sub = words[1]
  if (sub === undefined) return line
  if (INTERPRETERS.has(program)) return line
  const looksLikeArgument = (w: string) => w.startsWith('-') || /[/\\.:=]/.test(w)
  if (looksLikeArgument(sub)) return line
  if (RUNNERS.has(program) && RUNNER_VERBS.has(sub)) {
    const script = words[2]
    return script && !looksLikeArgument(script) ? words.slice(0, 3).join(' ') : line
  }
  return `${words[0]} ${sub}`
}
