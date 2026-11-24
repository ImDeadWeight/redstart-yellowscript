// =============================================================================
// The tool registry — one place that knows the whole ys_* set.
// =============================================================================
// Assembles the tools, renders the `tools` array for /v1/chat/completions, and
// executes a call by name. The agent loop (2.3) talks to this and to nothing
// else in the tool layer.
//
// Two responsibilities that look small and are not:
//
// 1. ARGUMENTS ARRIVE AS A STRING AND ARE OFTEN MALFORMED. A local model emits
//    `arguments` as JSON text, and a 3B-active MoE gets that wrong regularly.
//    Parsing is centralised here so every tool gets the same treatment: an
//    empty string is "no arguments"; text JSON.parse rejects is repaired when
//    the mistake is mechanical (raw newlines in a string, a stray backslash,
//    single quotes, a trailing comma, a code fence; argument-repair.ts), and
//    otherwise gets one correctable error message.
//
// 2. DUPLICATE NAMES MUST BE LOUD. A tools array carrying two entries with one
//    name silently drops one of them, and the symptom is a tool that "sometimes
//    doesn't work". Asserted at construction, where it is a startup crash in
//    development rather than a mystery at runtime.
// =============================================================================

import { toolError, toolOk, type JsonSchema, type Tool, type ToolContext, type ToolResult } from './types.ts'
import { migrateToolName } from './approval.ts'
import { createReadFileTool } from './read-file.ts'
import { createNoteTool } from './notes.ts'
import { createFindSymbolTool, createOutlineTool, createReferencesTool, type SymbolProvider } from './symbols.ts'
import { listDirectoryTool } from './list-directory.ts'
import { createGlobTool } from './glob.ts'
import { createGrepTool } from './grep.ts'
import { createDiagnosticsTool, type DiagnosticsProvider } from './diagnostics.ts'
import { createEditorContextTool, type EditorStateProvider } from './editor-context.ts'
import { createEditFileTool, createWriteFileTool, nodeWriteFs, type WriteFs } from './write-file.ts'
import { runCommandTool } from './run-command.ts'
import { createDeleteFileTool, createMoveFileTool, createReplaceTool } from './file-ops.ts'
import { createProcessTool, legacyProcessCall } from './process-tools.ts'
import { repairJson, type RepairKind } from './argument-repair.ts'
import { checkWrite, stricter, type WriteVerdict } from './protected-paths.ts'
import * as fs from 'node:fs'
import type { BackgroundProcesses } from './background-processes.ts'
import { createCheckPageTool, type CheckPageDeps } from './browser-check.ts'

/** One entry of the OpenAI-compatible `tools` array. */
export interface ToolPayloadEntry {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: unknown
  }
}

export interface ToolRegistryOptions {
  /** Resolved once at activation; null puts the search tools in degraded mode. */
  ripgrepPath: string | null
  diagnostics: DiagnosticsProvider
  editorState: EditorStateProvider
  /** Read-only fs for the write tools' planning phase. Defaults to node:fs. */
  writeFs?: WriteFs
  /** The window's background processes. Absent: no ys_process tool. */
  processes?: BackgroundProcesses
  /** The headless browser for ys_check_page. Absent: no such tool. */
  browser?: CheckPageDeps
  /** The language server's symbols (ys_find_symbol, ys_references, and a
   *  better ys_outline). Absent: ys_outline reads the text alone. */
  symbols?: SymbolProvider
  /** Offer ys_edit_file (unified diffs) to the model. Off by default: small
   *  models get diffs wrong, and ys_replace covers the case. A call to it
   *  still runs either way, since old transcripts and habits carry it. */
  unifiedDiff?: boolean
  /** Tool names to leave out: the bench measures a task with and without
   *  a tool this way. */
  withhold?: readonly string[]
}

export interface ToolRegistry {
  readonly tools: readonly Tool[]
  readonly names: readonly string[]
  /** The `tools` array to send to the gateway. Note that sending ANY tools
   *  changes the system context the gateway injects — it only claims Nest
   *  capabilities when a request carries tools (HANDOFF.md correction 5). */
  payload(): ToolPayloadEntry[]
  get(name: string): Tool | undefined
  /** Tools that run when called by name but are not offered (ys_edit_file
   *  unless `unifiedDiff`). */
  readonly hidden: readonly Tool[]
  /** Execute by name with the raw `arguments` string from the model. */
  execute(name: string, rawArguments: string, context: ToolContext): Promise<ToolResult>
}

export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  const writeFs = options.writeFs ?? nodeWriteFs

  const editFile = createEditFileTool(writeFs)
  const symbols = options.symbols ?? null
  const tools: Tool[] = [
    createReadFileTool(symbols),
    listDirectoryTool,
    createGlobTool(options.ripgrepPath),
    createGrepTool(options.ripgrepPath),
    createOutlineTool(symbols),
    ...(symbols ? [createFindSymbolTool(symbols), createReferencesTool(symbols)] : []),
    createDiagnosticsTool(options.diagnostics),
    createEditorContextTool(options.editorState),
    createReplaceTool(writeFs),
    ...(options.unifiedDiff ? [editFile] : []),
    createWriteFileTool(writeFs),
    createDeleteFileTool(writeFs),
    createMoveFileTool(writeFs),
    createNoteTool(writeFs),
    runCommandTool,
    ...(options.processes
      ? [createProcessTool(options.processes)]
      : []),
    ...(options.browser ? [createCheckPageTool(options.browser)] : []),
  ]

  if (options.withhold?.length) {
    const withheld = new Set(options.withhold)
    for (let i = tools.length - 1; i >= 0; i--) if (withheld.has(tools[i]!.definition.name)) tools.splice(i, 1)
  }

  const byName = new Map<string, Tool>()
  for (const tool of tools) {
    const { name } = tool.definition
    if (byName.has(name)) {
      throw new Error(`Duplicate tool name "${name}" — one of them would be silently unreachable`)
    }
    byName.set(name, tool)
  }

  return registryOver(tools, byName, options.unifiedDiff ? [] : [editFile])
}

/**
 * The registry over a tool set. `hidden` tools are not offered to the model
 * but still run when called by name.
 */
function registryOver(tools: readonly Tool[], byName: ReadonlyMap<string, Tool>, hidden: readonly Tool[]): ToolRegistry {
  const runnable = new Map(byName)
  for (const tool of hidden) if (!runnable.has(tool.definition.name)) runnable.set(tool.definition.name, tool)

  return {
    tools,
    hidden,
    names: tools.map((tool) => tool.definition.name),

    payload(): ToolPayloadEntry[] {
      return tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.definition.name,
          description: tool.definition.description,
          parameters: tool.definition.inputSchema,
        },
      }))
    },

    get(name: string): Tool | undefined {
      return byName.get(name)
    },

    async execute(name: string, rawArguments: string, context: ToolContext): Promise<ToolResult> {
      const parsed = parseToolArguments(rawArguments)
      if (!parsed.ok) {
        return toolError(
          `The arguments for ${name} were not valid JSON (${parsed.reason}). ` +
            `Send them as a JSON object, e.g. {"path": "src/index.ts"}.`,
        )
      }

      // Old transcripts replay pre-rename ws_* calls; route them to ys_*. The
      // three ys_process_* tools are now one, with an action.
      const legacy = legacyProcessCall(name, parsed.value)
      const target = legacy?.name ?? name
      const args = legacy?.args ?? parsed.value
      const tool = runnable.get(target) ?? runnable.get(migrateToolName(target))
      if (!tool) {
        // Name the alternatives: a model that invented `read_file` can correct
        // itself to `ys_read_file` if told what exists.
        return toolError(
          `There is no tool called "${name}". Available tools: ${[...byName.keys()].join(', ')}.`,
        )
      }

      // The caller's context, roots and all: a local ys_* tool handed empty
      // roots would refuse every path once Nest's tools were merged in.
      const result = guardWrite(await tool.execute(args, context), context)
      return parsed.repairs?.length ? { ...result, argumentsRepaired: parsed.repairs } : result
    },
  }
}

/** Roots as the filesystem names them, to compare with resolved paths. */
function realRoots(roots: readonly string[]): string[] {
  return roots.map((root) => {
    try {
      return fs.realpathSync.native(root)
    } catch {
      return root
    }
  })
}

/**
 * Every planned write passes here, whichever tool planned it: a change to a
 * protected path is refused, or marked to be asked about every time
 * (protected-paths.ts).
 */
function guardWrite(result: ToolResult, context: ToolContext): ToolResult {
  const pending = result.pendingWrite
  if (!pending) return result
  const roots = realRoots(context.workspaceRoots)
  let verdict: WriteVerdict = null
  for (const change of pending.changes) {
    verdict = stricter(verdict, checkWrite(roots, change.absolutePath, change))
  }
  if (verdict && 'refuse' in verdict) return toolError(`Not written: ${verdict.refuse}`)
  if (verdict) return { ...result, pendingWrite: { ...pending, alwaysAsk: verdict.ask } }
  return result
}

/**
 * A reference to a Nest-originated MCP tool, for delegation.
 */
export interface NestToolRef {
  name: string
  description: string
  inputSchema: unknown
  meta?: Record<string, unknown>
  /** The host calls this to execute the tool on the Nest via McpHost.callTool. */
  execute: (args: unknown, context: ToolContext) => Promise<string>
}

/**
 * Merge local ys_* tools with live Nest MCP tools, enforcing the disjointness
 * invariant (HANDOFF 4.3 / correction 1): no Nest tool name may begin with `ys_`,
 * and the two sets must not overlap at all.
 *
 * Nest tools are wrapped as `Tool` implementations that delegate to the supplied
 * `execute` callback. The merge is a pure function — it reads the current set of
 * local tools from the registry and the Nest tools from the caller, so it can
 * be re-run on every re-list without rebuilding the locals.
 */
export function mergeNestTools(
  local: ToolRegistry,
  nestTools: readonly NestToolRef[],
): ToolRegistry {
  const merged: Tool[] = [...local.tools]
  const byName = new Map(local.tools.map((t) => [t.definition.name, t] as const))

  for (const nest of nestTools) {
    // The ys_ namespace is the local tool contract (HANDOFF correction 1). A
    // Nest tool leaking in here is the silent, dangerous failure this prevents:
    // the model calls `write_file` intending a workspace write and hits Nest's
    // configured rootDir instead.
    if (nest.name.startsWith('ys_')) {
      throw new Error(
        `Nest tool "${nest.name}" collides with the ys_ prefix — refusing to merge`,
      )
    }
    if (byName.has(nest.name)) {
      throw new Error(
        `Nest tool "${nest.name}" duplicates an existing tool name — refusing to merge`,
      )
    }

    const wrapped: Tool = {
      definition: {
        name: nest.name,
        description: nest.description,
        inputSchema: nest.inputSchema as JsonSchema,
      },
      execute: (args: unknown) => {
        return Promise.resolve(toolOk('', `${nest.name} (ran on Nest)`, false))
      },
    }
    // Wire the real execution delegate: calls back into McpHost.callTool.
    const ref = nest
    wrapped.execute = (args: unknown, context: ToolContext) => {
      return ref.execute(args, context).then((content) => ({
        content,
        isError: false,
        summary: `${ref.name} (ran on Nest)`,
        truncated: false,
      }))
    }

    merged.push(wrapped)
    byName.set(nest.name, wrapped)
  }

  return registryOver(merged, byName, local.hidden)
}

export type ParsedArguments = { ok: true; value: unknown; repairs?: RepairKind[] } | { ok: false; reason: string }

/**
 * Read the model's `arguments` string.
 *
 * Deliberately forgiving about the shapes a small model actually produces:
 * an empty string means "no arguments" rather than a parse error, and a bare
 * JSON value is passed through for the tool's own validation to reject with a
 * message about the missing field. Only genuinely unparseable text is an error
 * here — the tools themselves are better placed to say what was wrong.
 * Text JSON.parse rejects is tried once more after `repairJson`, and the
 * repairs made are returned so the bench can count them.
 */
export function parseToolArguments(raw: string): ParsedArguments {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  // A tool with no required arguments is called with "" or "{}" constantly.
  if (trimmed === '') return { ok: true, value: {} }

  let reason: string
  try {
    return { ok: true, value: JSON.parse(trimmed) }
  } catch (err) {
    reason = err instanceof Error ? err.message : 'unparseable'
  }

  const repaired = repairJson(trimmed)
  if (repaired.repairs.length === 0) return { ok: false, reason }
  try {
    return { ok: true, value: JSON.parse(repaired.text), repairs: repaired.repairs }
  } catch {
    return { ok: false, reason }
  }
}
