// =============================================================================
// The ws_* tool contract.
// =============================================================================
// Every IDE-local tool implements `Tool`. The agent loop (2.3) executes them,
// the approval UI (2.4) renders them, and the Nest never sees any of this — it
// receives only the JSON schema in `definition`, alongside its own MCP tools.
//
// FOUR RULES, each one a mistake that is otherwise made later:
//
// 1. NAMES ARE `ws_`-PREFIXED, ALWAYS. Nest's File System capability is the
//    official MCP filesystem server and advertises `read_file`, `write_file`,
//    `edit_file`, `list_directory`, `search_files` and more. One `tools` array
//    cannot carry two functions with the same name, and the failure is silent
//    and dangerous: the model asks for `write_file` meaning the workspace and
//    gets Nest's configured rootDir instead. See HANDOFF.md correction 1.
//    `ws_` also gives the recovery parser disjoint name sets to match against.
//
// 2. A FAILED TOOL RETURNS A RESULT, IT DOES NOT THROW. "File not found" is
//    information the model needs in order to try something else; an exception
//    is a dropped turn. Only genuine bugs propagate. This mirrors MCP's
//    `isError`, and it is also how a server-side denial has to arrive in Phase
//    4 — the model must see the refusal reason or it will retry forever.
//
// 3. OUTPUT IS BUDGETED. The reference rig is a 32k-context local model, and a
//    single unbounded `ws_read_file` on a bundled .js will consume the entire
//    window and evict the conversation that motivated the call. Every tool
//    truncates deterministically and SAYS SO in-band, so the model knows it is
//    looking at a fragment rather than silently reasoning about a whole file it
//    never saw.
//
// 4. PATHS OUT ARE WORKSPACE-RELATIVE. Absolute paths leak the machine layout
//    into model context, cost tokens for no benefit, and come back as absolute
//    paths in the next call. `describeWorkspacePath` is the one renderer.
//
// No `vscode` import: tools take what they need through `ToolContext`, so the
// whole layer is testable with no extension host. The adapter that fills the
// context from `workspace.workspaceFolders` lives in ui/.
// =============================================================================

/**
 * The character budget for a single tool result, before truncation.
 *
 * Chosen against a 32k-token context: at roughly four characters per token this
 * is ~5k tokens, so a handful of tool calls can accumulate in a turn without
 * evicting the conversation. It is a character budget rather than a token one
 * because tokenizing to enforce a limit costs more than the limit saves.
 */
export const MAX_RESULT_CHARS = 20_000

/** The JSON Schema an OpenAI-compatible `tools` entry carries. Deliberately
 *  loose — this is forwarded to the gateway verbatim, not interpreted here. */
export interface JsonSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolDefinition {
  /** Must start with `ws_` — see rule 1. `assertWorkspaceToolName` enforces it. */
  name: string
  /** Written for the model, not for a human reader. State what the tool does,
   *  what it refuses to do, and what it costs — a model that knows a tool
   *  truncates will ask for a range instead of retrying the whole file. */
  description: string
  inputSchema: JsonSchema
}

export interface ToolContext {
  /** Absolute paths of the workspace folders. Every path the model supplies is
   *  resolved against these and proven to stay inside them. */
  workspaceRoots: readonly string[]
  /** Cancels a long read or walk when the user aborts the turn. */
  signal?: AbortSignal
}

export interface ToolResult {
  /** Exactly what becomes the `tool` message's content. */
  content: string
  /** True when the tool refused or failed. The content still explains why, in
   *  terms the model can act on. */
  isError: boolean
  /** One line for the UI card — never shown to the model. */
  summary: string
  /** True when `content` is a fragment. Also stated inside `content`, because
   *  this flag does not reach the model. */
  truncated: boolean
}

export interface Tool {
  readonly definition: ToolDefinition
  /**
   * `args` is whatever the model sent, already JSON-parsed but NOT validated —
   * it can be any shape at all, including null or an array. Validating it is
   * part of the tool's job, and a validation failure is a result (rule 2), not
   * a throw.
   */
  execute(args: unknown, context: ToolContext): Promise<ToolResult>
}

// --- Result construction ----------------------------------------------------

export function toolOk(content: string, summary: string, truncated = false): ToolResult {
  return { content, isError: false, summary, truncated }
}

/**
 * A failure the model is expected to read and react to. `summary` defaults to
 * the message, since a failed call's one-line summary is usually just its
 * reason.
 */
export function toolError(content: string, summary?: string): ToolResult {
  return { content, isError: true, summary: summary ?? content, truncated: false }
}

// --- Shared helpers ---------------------------------------------------------

/**
 * Enforce rule 1 at construction time.
 *
 * Called by every tool's module rather than left to review, because the
 * collision it prevents is invisible at runtime: a duplicate name simply means
 * one of the two tools silently stops being reachable. Phase 4.3 adds the
 * complementary check against the live Nest tool list.
 */
export function assertWorkspaceToolName(name: string): string {
  if (!name.startsWith('ws_')) {
    throw new Error(
      `Tool name "${name}" must start with "ws_" — unprefixed names collide with the Nest's own filesystem tools`,
    )
  }
  return name
}

/**
 * Cut `text` to the budget, appending a note saying so.
 *
 * The note is in-band on purpose (rule 3): the `truncated` flag is for the UI,
 * and the model only ever sees the string. Truncation is at a line boundary
 * where one is available, because half a line of source reads as a syntax error
 * and invites the model to "fix" something that is not broken.
 */
export function truncateForModel(
  text: string,
  limit: number = MAX_RESULT_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }

  const head = text.slice(0, limit)
  const lastNewline = head.lastIndexOf('\n')
  // Only prefer the line boundary if it doesn't cost most of the budget.
  const cut = lastNewline > limit * 0.8 ? head.slice(0, lastNewline) : head
  const omitted = text.length - cut.length

  return {
    text: `${cut}\n\n[truncated — ${omitted.toLocaleString('en-US')} more characters not shown]`,
    truncated: true,
  }
}

/**
 * Read a required string field from model-supplied arguments.
 *
 * Returns null rather than throwing so callers turn it into a `toolError`.
 * Accepts only a genuine object: models emit a bare string or an array as
 * `arguments` often enough that treating those as "no path given" produces a
 * far better error message than a TypeError would.
 */
export function stringArg(args: unknown, key: string): string | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

/** As `stringArg`, for an optional positive integer (line offsets, limits). */
export function intArg(args: unknown, key: string): number | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  const value = (args as Record<string, unknown>)[key]
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  // Local models frequently send numbers as strings.
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return null
}

export function boolArg(args: unknown, key: string): boolean | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  const value = (args as Record<string, unknown>)[key]
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}
