// =============================================================================
// ys_outline, ys_find_symbol, ys_references — the code's structure, cheaply.
// =============================================================================
// The language server already knows where every function is and who calls
// it; without these the model pays for that knowledge in whole-file reads.
// One port, `SymbolProvider`, the way diagnostics are wired: the extension
// implements it with VS Code's providers (ui/tool-providers.ts), the bench
// with the TypeScript compiler API (bench/ts-symbols.ts), tests with a fake.
//
// When the language server has nothing (HTML, CSS, a language with no
// extension installed), ys_outline falls back to a regex outline: headings
// and ids for HTML, selectors for CSS, functions and classes for JS and
// Python, headings for Markdown.
//
// No `vscode` import.
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'

import { assertWorkspaceToolName, intArg, stringArg, toolError, toolOk, truncateForModel, type Tool, type ToolContext, type ToolResult } from './types.ts'
import { describeWorkspacePath } from './workspace-path.ts'
import { resolveReadPath } from './read-scope.ts'

/** One symbol in a file. Lines are 1-based. */
export interface OutlineSymbol {
  name: string
  /** "function", "class", "method"… lower case. */
  kind: string
  line: number
  endLine?: number
  children?: OutlineSymbol[]
}

/** A symbol found across the workspace. */
export interface WorkspaceSymbol {
  name: string
  kind: string
  /** Absolute path. */
  file: string
  line: number
  container?: string
}

/** A place a symbol is used. Line and character are 1-based. */
export interface SymbolLocation {
  file: string
  line: number
  character: number
}

export interface SymbolProvider {
  /** The file's symbols, nested; empty when no language server knows it. */
  outline(absolutePath: string): Promise<OutlineSymbol[]>
  /** Definitions matching `query` (fuzzy, as the language server matches). */
  workspaceSymbols(query: string): Promise<WorkspaceSymbol[]>
  /** Every use of the symbol at this position, its definition included. */
  references(absolutePath: string, line: number, character: number): Promise<SymbolLocation[]>
}

export const MAX_SYMBOLS = 20
export const MAX_REFERENCES = 40
/** Outline lines shown before the rest are counted. */
const MAX_OUTLINE_LINES = 300

// --- The regex outline -------------------------------------------------------

const JS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'function', 'else', 'do'])

/** A flat outline from the text alone, for files no language server knows. */
export function regexOutline(text: string, file: string): OutlineSymbol[] {
  const ext = path.extname(file).toLowerCase()
  const lines = text.split('\n')
  const out: OutlineSymbol[] = []
  const add = (kind: string, name: string, line: number) => out.push({ kind, name: name.trim().slice(0, 100), line })

  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '')
    const n = i + 1
    if (ext === '.html' || ext === '.htm' || ext === '.svelte' || ext === '.vue') {
      const heading = /<(h[1-6])\b[^>]*>(.*?)<\/\1>/i.exec(line)
      if (heading) add(heading[1]!.toLowerCase(), heading[2]!.replace(/<[^>]+>/g, ''), n)
      for (const m of line.matchAll(/<([a-z][\w-]*)\b[^>]*\bid\s*=\s*["']([^"']+)["']/gi)) add(m[1]!.toLowerCase(), `#${m[2]}`, n)
      if (/<script\b/i.test(line)) add('script', '<script>', n)
      if (/<style\b/i.test(line)) add('style', '<style>', n)
    } else if (ext === '.css' || ext === '.scss' || ext === '.less') {
      const rule = /^\s*([^{}/@\s][^{}]*?)\s*\{/.exec(line)
      if (rule) add('selector', rule[1]!, n)
      const at = /^\s*(@(media|supports|keyframes|layer|container)\b[^{]*)/.exec(line)
      if (at) add('at-rule', at[1]!, n)
    } else if (ext === '.md' || ext === '.markdown') {
      const heading = /^(#{1,6})\s+(.*)/.exec(line)
      if (heading) add(`h${heading[1]!.length}`, heading[2]!, n)
    } else if (ext === '.py') {
      const def = /^(\s*)(async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(line)
      if (def) add(def[3] === 'class' ? 'class' : def[1] ? 'method' : 'function', def[4]!, n)
    } else {
      let m: RegExpExecArray | null
      if ((m = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line))) add('function', m[1]!, n)
      else if ((m = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line))) add('class', m[1]!, n)
      else if ((m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.exec(line))) add('function', m[1]!, n)
      else if ((m = /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(line))) add('type', m[1]!, n)
      else if ((m = /^\s+(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/.exec(line)) && !JS_KEYWORDS.has(m[1]!)) add('method', m[1]!, n)
    }
  })
  return out
}

/** The outline as lines: `12-40 class Player`, children indented. */
export function formatOutline(symbols: readonly OutlineSymbol[], max = MAX_OUTLINE_LINES): { text: string; count: number } {
  const lines: string[] = []
  let count = 0
  const walk = (list: readonly OutlineSymbol[], depth: number) => {
    for (const s of list) {
      count++
      if (lines.length < max) {
        const range = s.endLine && s.endLine > s.line ? `${s.line}-${s.endLine}` : `${s.line}`
        lines.push(`${'  '.repeat(depth)}${range} ${s.kind} ${s.name}`)
      }
      if (s.children?.length) walk(s.children, depth + 1)
    }
  }
  walk(symbols, 0)
  if (count > lines.length) lines.push(`[${count - lines.length} more symbols not shown]`)
  return { text: lines.join('\n'), count }
}

/** The language server's outline, or the regex one when it has none. */
export async function outlineOf(provider: SymbolProvider | null, absolutePath: string, text: string): Promise<{ symbols: OutlineSymbol[]; source: 'language server' | 'text' }> {
  const fromServer = provider ? await provider.outline(absolutePath).catch(() => []) : []
  if (fromServer.length) return { symbols: fromServer, source: 'language server' }
  return { symbols: regexOutline(text, absolutePath), source: 'text' }
}

// --- Helpers ---------------------------------------------------------------------

function lineOf(file: string, line: number): string {
  try {
    return (fs.readFileSync(file, 'utf8').split('\n')[line - 1] ?? '').replace(/\r$/, '')
  } catch {
    return ''
  }
}

const inWorkspace = (context: ToolContext, file: string) => describeWorkspacePath(context.workspaceRoots, file) !== file

async function resolve(context: ToolContext, requested: string): Promise<{ ok: true; absolute: string } | { ok: false; error: ToolResult }> {
  try {
    return { ok: true, absolute: await resolveReadPath(context, requested) }
  } catch {
    return { ok: false, error: toolError(`"${requested}" is outside the workspace.`) }
  }
}

/** Definitions of `name`: exact matches first, case-insensitive ones next. */
async function definitionsOf(provider: SymbolProvider, name: string, context: ToolContext): Promise<WorkspaceSymbol[]> {
  const found = (await provider.workspaceSymbols(name).catch(() => [])).filter((s) => inWorkspace(context, s.file))
  const exact = found.filter((s) => s.name === name)
  if (exact.length) return exact
  const folded = found.filter((s) => s.name.toLowerCase() === name.toLowerCase())
  return folded.length ? folded : found
}

const describeSymbol = (context: ToolContext, s: WorkspaceSymbol) =>
  `${describeWorkspacePath(context.workspaceRoots, s.file)}:${s.line} ${s.kind} ${s.name}${s.container ? ` (in ${s.container})` : ''}`

// --- The tools ---------------------------------------------------------------------

export function createOutlineTool(provider: SymbolProvider | null): Tool {
  return {
    definition: {
      name: assertWorkspaceToolName('ys_outline'),
      description: "A file's functions, classes and methods with their line ranges, without reading it whole. Then read a range with ys_read_file.",
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative path.' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
    async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
      const requested = stringArg(args, 'path')
      if (!requested) return toolError('ys_outline requires a "path".')
      const where = await resolve(context, requested)
      if (!where.ok) return where.error
      let text: string
      try {
        text = fs.readFileSync(where.absolute, 'utf8')
      } catch {
        return toolError(`${requested} does not exist or is not a readable file.`)
      }
      const label = describeWorkspacePath(context.workspaceRoots, where.absolute)
      const { symbols, source } = await outlineOf(provider, where.absolute, text)
      const lines = text.split('\n').length
      if (symbols.length === 0) return toolOk(`${label} (${lines} lines): no symbols found. Read it with ys_read_file.`, `ys_outline ${label} — none`)
      const { text: body, count } = formatOutline(symbols)
      const note = source === 'text' ? ' (from the text; no language server for this file)' : ''
      return toolOk(`${label} — ${lines} lines, ${count} symbols${note}:\n${body}`, `ys_outline ${label} — ${count} symbols`)
    },
  }
}

export function createFindSymbolTool(provider: SymbolProvider): Tool {
  return {
    definition: {
      name: assertWorkspaceToolName('ys_find_symbol'),
      description: 'Where a function, class or variable is defined in the workspace, from the language server.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'e.g. "Player" or "jump".' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
    async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
      const name = stringArg(args, 'name')?.trim()
      if (!name) return toolError('ys_find_symbol requires a "name".')
      const found = await definitionsOf(provider, name, context)
      if (found.length === 0) {
        return toolOk(`No definition of "${name}" found. The language server may not know this file type; try ys_grep.`, `ys_find_symbol ${name} — none`)
      }
      const shown = found.slice(0, MAX_SYMBOLS).map((s) => describeSymbol(context, s))
      const more = found.length > MAX_SYMBOLS ? `\n[${found.length - MAX_SYMBOLS} more not shown]` : ''
      return toolOk(`${shown.join('\n')}${more}`, `ys_find_symbol ${name} — ${found.length}`)
    },
  }
}

export function createReferencesTool(provider: SymbolProvider): Tool {
  return {
    definition: {
      name: assertWorkspaceToolName('ys_references'),
      description: 'Every place a symbol is used, with the line. Give "name", or "path" and "line" (and "character") of a use.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          path: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
          character: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
    },
    async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
      let file: string
      let line: number
      let character: number
      const name = stringArg(args, 'name')?.trim()
      const requested = stringArg(args, 'path')
      if (requested) {
        const where = await resolve(context, requested)
        if (!where.ok) return where.error
        file = where.absolute
        line = intArg(args, 'line') ?? 0
        if (line < 1) return toolError('ys_references with a "path" needs a "line" (1-based).')
        const text = lineOf(file, line)
        const at = intArg(args, 'character') ?? (name ? text.indexOf(name) + 1 : 0)
        character = at > 0 ? at : (/[A-Za-z_$]/.exec(text)?.index ?? 0) + 1
      } else if (name) {
        const found = await definitionsOf(provider, name, context)
        if (found.length === 0) return toolError(`No definition of "${name}" found to look up. Try ys_grep for it.`)
        if (found.length > 1) {
          return toolError(
            `"${name}" names ${found.length} definitions; give "path" and "line" of the one you mean:\n` +
              found.slice(0, MAX_SYMBOLS).map((s) => describeSymbol(context, s)).join('\n'),
          )
        }
        const target = found[0]!
        file = target.file
        line = target.line
        character = Math.max(1, lineOf(file, line).indexOf(name) + 1)
      } else {
        return toolError('ys_references needs a "name", or a "path" and "line".')
      }

      const locations = (await provider.references(file, line, character).catch(() => [])).filter((l) => inWorkspace(context, l.file))
      const label = name ?? `${describeWorkspacePath(context.workspaceRoots, file)}:${line}`
      if (locations.length === 0) return toolOk(`No references found for ${label}.`, `ys_references ${label} — none`)
      const shown = locations.slice(0, MAX_REFERENCES).map((l) => `${describeWorkspacePath(context.workspaceRoots, l.file)}:${l.line}: ${lineOf(l.file, l.line).trim().slice(0, 160)}`)
      const files = new Set(locations.map((l) => l.file)).size
      const more = locations.length > MAX_REFERENCES ? `\n[${locations.length - MAX_REFERENCES} more not shown]` : ''
      const { text } = truncateForModel(`${locations.length} references in ${files} file${files === 1 ? '' : 's'}:\n${shown.join('\n')}${more}`)
      return toolOk(text, `ys_references ${label} — ${locations.length}`)
    },
  }
}
