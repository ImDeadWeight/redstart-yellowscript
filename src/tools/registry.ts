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

import { toolError, type Tool, type ToolContext, type ToolResult } from './types.ts'
import { readFileTool } from './read-file.ts'
import { listDirectoryTool } from './list-directory.ts'
import { createGlobTool } from './glob.ts'
import { createGrepTool } from './grep.ts'
import { createDiagnosticsTool, type DiagnosticsProvider } from './diagnostics.ts'
import { createEditorContextTool, type EditorStateProvider } from './editor-context.ts'

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
  const tools: Tool[] = [
    readFileTool,
    listDirectoryTool,
    createGlobTool(options.ripgrepPath),
    createGrepTool(options.ripgrepPath),
    createDiagnosticsTool(options.diagnostics),
    createEditorContextTool(options.editorState),
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
