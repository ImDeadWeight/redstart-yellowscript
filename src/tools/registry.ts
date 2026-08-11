// =============================================================================
// The tool registry — one place that knows the whole ws_* set.
// =============================================================================
// Assembles the tools, renders the `tools` array for /v1/chat/completions, and
// executes a call by name. The agent loop (2.3) talks to this and to nothing
// else in the tool layer.
//
// Two responsibilities that look small and are not:
//
// 1. ARGUMENTS ARRIVE AS A STRING AND ARE OFTEN MALFORMED. A local model emits
//    `arguments` as JSON text, and a 3B-active MoE gets that wrong regularly —
//    trailing commas, single quotes, a bare value, an empty string. Parsing is
//    centralised here so every tool gets the same forgiving treatment and the
//    same correctable error message, rather than each one reinventing it.
//
// 2. DUPLICATE NAMES MUST BE LOUD. A tools array carrying two entries with one
//    name silently drops one of them, and the symptom is a tool that "sometimes
//    doesn't work". Asserted at construction, where it is a startup crash in
//    development rather than a mystery at runtime.
// =============================================================================

import { toolError, toolOk, type JsonSchema, type Tool, type ToolContext, type ToolResult } from './types.ts'
import { readFileTool } from './read-file.ts'
import { listDirectoryTool } from './list-directory.ts'
import { createGlobTool } from './glob.ts'
import { createGrepTool } from './grep.ts'
import { createDiagnosticsTool, type DiagnosticsProvider } from './diagnostics.ts'
import { createEditorContextTool, type EditorStateProvider } from './editor-context.ts'
import { createEditFileTool, createWriteFileTool, nodeWriteFs, type WriteFs } from './write-file.ts'
import { runCommandTool } from './run-command.ts'

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
}

export interface ToolRegistry {
  readonly tools: readonly Tool[]
  readonly names: readonly string[]
  /** The `tools` array to send to the gateway. Note that sending ANY tools
   *  changes the system context the gateway injects — it only claims Nest
   *  capabilities when a request carries tools (HANDOFF.md correction 5). */
  payload(): ToolPayloadEntry[]
  get(name: string): Tool | undefined
  /** Execute by name with the raw `arguments` string from the model. */
  execute(name: string, rawArguments: string, context: ToolContext): Promise<ToolResult>
}

export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  const writeFs = options.writeFs ?? nodeWriteFs

  const tools: Tool[] = [
    readFileTool,
    listDirectoryTool,
    createGlobTool(options.ripgrepPath),
    createGrepTool(options.ripgrepPath),
    createDiagnosticsTool(options.diagnostics),
    createEditorContextTool(options.editorState),
    createEditFileTool(writeFs),
    createWriteFileTool(writeFs),
    runCommandTool,
  ]

  const byName = new Map<string, Tool>()
  for (const tool of tools) {
    const { name } = tool.definition
    if (byName.has(name)) {
      throw new Error(`Duplicate tool name "${name}" — one of them would be silently unreachable`)
    }
    byName.set(name, tool)
  }

  return {
    tools,
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
      const tool = byName.get(name)
      if (!tool) {
        // Name the alternatives: a model that invented `read_file` can correct
        // itself to `ws_read_file` if told what exists.
        return toolError(
          `There is no tool called "${name}". Available tools: ${[...byName.keys()].join(', ')}.`,
        )
      }

      const parsed = parseToolArguments(rawArguments)
      if (!parsed.ok) {
        return toolError(
          `The arguments for ${name} were not valid JSON (${parsed.reason}). ` +
            `Send them as a JSON object, e.g. {"path": "src/index.ts"}.`,
        )
      }

      return tool.execute(parsed.value, context)
    },
  }
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
  execute: (args: unknown) => Promise<string>
}

/**
 * Merge local ws_* tools with live Nest MCP tools, enforcing the disjointness
 * invariant (HANDOFF 4.3 / correction 1): no Nest tool name may begin with `ws_`,
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
    // The ws_ namespace is the local tool contract (HANDOFF correction 1). A
    // Nest tool leaking in here is the silent, dangerous failure this prevents:
    // the model calls `write_file` intending a workspace write and hits Nest's
    // configured rootDir instead.
    if (nest.name.startsWith('ws_')) {
      throw new Error(
        `Nest tool "${nest.name}" collides with the ws_ prefix — refusing to merge`,
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
    wrapped.execute = (_args: unknown) => {
      void _args
      return ref.execute(_args).then((content) => ({
        content,
        isError: false,
        summary: `${ref.name} (ran on Nest)`,
        truncated: false,
      }))
    }

    merged.push(wrapped)
    byName.set(nest.name, wrapped)
  }

  return {
    tools: merged,
    names: merged.map((t) => t.definition.name),
    payload() {
      return merged.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.definition.name,
          description: tool.definition.description,
          parameters: tool.definition.inputSchema,
        },
      }))
    },
    get(name: string) {
      return byName.get(name)
    },
    async execute(name: string, rawArguments: string, context: ToolContext): Promise<ToolResult> {
      const tool = byName.get(name)
      if (!tool) {
        return toolError(
          `There is no tool called "${name}". Available tools: ${[...byName.keys()].join(', ')}.`,
        )
      }

      const parsed = parseToolArguments(rawArguments)
      if (!parsed.ok) {
        return toolError(
          `The arguments for ${name} were not valid JSON (${parsed.reason}). ` +
            `Send them as a JSON object, e.g. {"path": "src/index.ts"}.`,
        )
      }

      void context
      return tool.execute(parsed.value, { workspaceRoots: [] })
    },
  }
}

export type ParsedArguments = { ok: true; value: unknown } | { ok: false; reason: string }

/**
 * Read the model's `arguments` string.
 *
 * Deliberately forgiving about the shapes a small model actually produces:
 * an empty string means "no arguments" rather than a parse error, and a bare
 * JSON value is passed through for the tool's own validation to reject with a
 * message about the missing field. Only genuinely unparseable text is an error
 * here — the tools themselves are better placed to say what was wrong.
 */
export function parseToolArguments(raw: string): ParsedArguments {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  // A tool with no required arguments is called with "" or "{}" constantly.
  if (trimmed === '') return { ok: true, value: {} }

  try {
    return { ok: true, value: JSON.parse(trimmed) }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'unparseable' }
  }
}
