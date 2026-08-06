// =============================================================================
// ws_diagnostics — the Problems panel, as something the model can read.
// =============================================================================
// This is the highest-value read-only tool in the set. Everything else tells
// the model what the code SAYS; this tells it what the language server THINKS,
// which is the difference between guessing whether an edit compiled and knowing.
//
// The data comes through an injected provider rather than importing `vscode`,
// for the usual reason: the selection, ordering and containment logic below is
// where the bugs live, and it is all testable with a plain array.
//
// TWO THINGS THAT ARE EASY TO GET WRONG:
//
// 1. DIAGNOSTICS ARE NOT WORKSPACE-SCOPED. VSCode reports them for every open
//    document, including files the user opened from outside the workspace. They
//    go through the containment guard like any other path, or the model learns
//    about files it is not allowed to read.
//
// 2. TRUNCATION MUST DROP HINTS, NOT ERRORS. Sorting by severity before cutting
//    is the whole game: a file with 300 lint hints would otherwise push every
//    real type error out of the result, and the model would conclude the
//    workspace is clean.
// =============================================================================

import {
  assertWorkspaceToolName,
  stringArg,
  toolError,
  toolOk,
  truncateForModel,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './types.ts'
import { describeWorkspacePath, tryResolveWithinWorkspace } from './workspace-path.ts'

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint'

/** One problem, flattened out of VSCode's shape by the adapter. */
export interface DiagnosticRecord {
  /** Absolute path — `uri.fsPath`. Rendered workspace-relative on the way out. */
  file: string
  /** 1-based, already converted from VSCode's 0-based Position. */
  line: number
  column: number
  severity: DiagnosticSeverity
  message: string
  /** e.g. "ts", "eslint". */
  source?: string
  /** e.g. "2304". */
  code?: string
}

export type DiagnosticsProvider = () => readonly DiagnosticRecord[]

export const MAX_DIAGNOSTICS = 60

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
}

export function createDiagnosticsTool(provider: DiagnosticsProvider): Tool {
  return {
    definition: {
      name: assertWorkspaceToolName('ws_diagnostics'),
      description:
        'Read the current problems (errors, warnings) reported by the language servers — the ' +
        'same list shown in the Problems panel. Use this to check whether code compiles or ' +
        'lints cleanly instead of guessing. Returns errors first. ' +
        'Note that diagnostics update asynchronously, so immediately after an edit the list may ' +
        'still be catching up.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Optional workspace-relative file or directory to report on. Omit for the whole workspace.',
          },
          severity: {
            type: 'string',
            description:
              'Optional minimum severity: "error" for errors only, "warning" for errors and warnings.',
            enum: ['error', 'warning', 'info', 'hint'],
          },
        },
        required: [],
        additionalProperties: false,
      },
    },

    async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
      if (context.workspaceRoots.length === 0) {
        return toolError('No workspace folder is open, so there are no diagnostics to report.')
      }

      const minimum = stringArg(args, 'severity')
      if (minimum !== null && !(minimum in SEVERITY_ORDER)) {
        return toolError(`Unknown severity "${minimum}". Use error, warning, info or hint.`)
      }
      const severityCutoff =
        minimum === null ? SEVERITY_ORDER.hint : SEVERITY_ORDER[minimum as DiagnosticSeverity]

      // A scope filter is resolved through the guard so it cannot be used to
      // ask about a path outside the workspace.
      const scope = stringArg(args, 'path')
      let scopePrefix: string | null = null
      if (scope !== null) {
        const resolved = tryResolveWithinWorkspace(context.workspaceRoots, scope)
        if (resolved === null) return toolError(`"${scope}" is outside the workspace.`)
        scopePrefix = resolved
      }

      const relevant = provider()
        .filter((record) => SEVERITY_ORDER[record.severity] <= severityCutoff)
        // Containment: VSCode reports diagnostics for any open document, not
        // just workspace files.
        .filter((record) => tryResolveWithinWorkspace(context.workspaceRoots, record.file) !== null)
        .filter((record) => scopePrefix === null || isUnder(record.file, scopePrefix))

      if (relevant.length === 0) {
        const where = scope === null ? 'the workspace' : `"${scope}"`
        const what = minimum === null ? 'problems' : `problems at or above "${minimum}"`
        return toolOk(`No ${what} reported in ${where}.`, 'ws_diagnostics — clean')
      }

      // Severity first so that truncation drops hints rather than errors, then
      // by location so repeated calls are byte-identical.
      const sorted = [...relevant].sort((a, b) => {
        const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
        if (bySeverity !== 0) return bySeverity
        if (a.file !== b.file) return a.file.localeCompare(b.file, 'en')
        return a.line - b.line || a.column - b.column
      })

      const shown = sorted.slice(0, MAX_DIAGNOSTICS)
      const omitted = sorted.length - shown.length

      // Grouped by file for the same token reason as ws_grep, but the counts in
      // the header describe the FULL set — a model told "3 problems" when there
      // are 300 will stop looking.
      const grouped = new Map<string, DiagnosticRecord[]>()
      for (const record of shown) {
        const label = describeWorkspacePath(context.workspaceRoots, record.file)
        const list = grouped.get(label)
        if (list) list.push(record)
        else grouped.set(label, [record])
      }

      const blocks = [...grouped].map(([label, records]) => {
        const lines = records.map((record) => {
          const origin = [record.source, record.code].filter(Boolean).join(' ')
          const suffix = origin ? `  [${origin}]` : ''
          return `  ${record.line}:${record.column}  ${record.severity}  ${record.message}${suffix}`
        })
        return `${label}\n${lines.join('\n')}`
      })

      const note = omitted > 0 ? `\n\n[${omitted} more, lowest severity first to be dropped]` : ''
      const body = `${summarise(sorted)}\n\n${blocks.join('\n\n')}${note}`
      const { text, truncated } = truncateForModel(body)

      return toolOk(text, `ws_diagnostics — ${summarise(sorted)}`, truncated || omitted > 0)
    },
  }
}

/** "3 problems (2 errors, 1 warning)" — counts describe the whole set. */
function summarise(records: readonly DiagnosticRecord[]): string {
  const counts = new Map<DiagnosticSeverity, number>()
  for (const record of records) counts.set(record.severity, (counts.get(record.severity) ?? 0) + 1)

  const parts: string[] = []
  for (const severity of ['error', 'warning', 'info', 'hint'] as const) {
    const count = counts.get(severity) ?? 0
    if (count > 0) parts.push(`${count} ${severity}${count === 1 ? '' : 's'}`)
  }
  const total = records.length
  return `${total} problem${total === 1 ? '' : 's'} (${parts.join(', ')})`
}

/** Path containment for the scope filter. Both sides are already absolute and
 *  guard-resolved, so a prefix test is enough — but it still needs the
 *  separator, or "src" would match "src-generated". */
function isUnder(file: string, directoryOrFile: string): boolean {
  const fold = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value
  const target = fold(file)
  const scope = fold(directoryOrFile)
  if (target === scope) return true
  return target.startsWith(scope.endsWith('/') || scope.endsWith('\\') ? scope : `${scope}/`) ||
    target.startsWith(`${scope}\\`)
}
