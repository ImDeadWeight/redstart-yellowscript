// =============================================================================
// VSCode → tool-layer adapters.
// =============================================================================
// The only file that turns editor state into the plain data the ws_* tools
// consume. Everything under src/tools/ stays free of `vscode` so its logic —
// containment, ordering, truncation, where the bugs actually are — is testable
// under `node --test` with no extension host.
//
// Keep this file dumb. If something here needs a decision, that decision
// belongs in src/tools/ where it can be tested.
// =============================================================================

import * as vscode from 'vscode'

import { locateRipgrep } from '../tools/ripgrep.ts'
import type { DiagnosticRecord, DiagnosticSeverity } from '../tools/diagnostics.ts'
import type { EditorState, EditorPosition } from '../tools/editor-context.ts'

/** Absolute paths of the open workspace folders — the roots every ws_* path is
 *  contained within. Empty when no folder is open, which the tools report as a
 *  configuration state rather than an escape attempt. */
export function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => folder.uri.fsPath)
}

/**
 * Where VSCode keeps its bundled ripgrep.
 *
 * `env.appRoot` rather than a constant: the path is commit-hashed on current
 * builds and the package layout has changed across versions. Resolved once at
 * activation — see locateRipgrep for the layouts probed.
 */
export function resolveRipgrep(): string | null {
  try {
    return locateRipgrep(vscode.env.appRoot)
  } catch {
    // env.appRoot is unavailable in some hosts (web). Degraded mode handles it.
    return null
  }
}

const SEVERITY: Record<vscode.DiagnosticSeverity, DiagnosticSeverity> = {
  [vscode.DiagnosticSeverity.Error]: 'error',
  [vscode.DiagnosticSeverity.Warning]: 'warning',
  [vscode.DiagnosticSeverity.Information]: 'info',
  [vscode.DiagnosticSeverity.Hint]: 'hint',
}

/**
 * Every diagnostic VSCode currently holds, flattened.
 *
 * Not filtered to the workspace here: the tool does that through the
 * containment guard, so there is exactly one place that decides what is inside
 * the workspace.
 */
export function diagnosticsProvider(): DiagnosticRecord[] {
  const records: DiagnosticRecord[] = []

  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== 'file') continue
    for (const diagnostic of diagnostics) {
      const record: DiagnosticRecord = {
        file: uri.fsPath,
        // VSCode positions are 0-based; everything the model sees is 1-based,
        // matching ws_read_file's gutter and what the editor displays.
        line: diagnostic.range.start.line + 1,
        column: diagnostic.range.start.character + 1,
        severity: SEVERITY[diagnostic.severity] ?? 'info',
        message: diagnostic.message,
      }
      if (typeof diagnostic.source === 'string' && diagnostic.source.length > 0) {
        record.source = diagnostic.source
      }
      const code = normalizeCode(diagnostic.code)
      if (code !== null) record.code = code
      records.push(record)
    }
  }

  return records
}

/** `code` is a string, a number, or an object carrying both a value and a link. */
function normalizeCode(code: vscode.Diagnostic['code']): string | null {
  if (typeof code === 'string') return code
  if (typeof code === 'number') return String(code)
  if (code && typeof code === 'object' && 'value' in code) return String(code.value)
  return null
}

/** What the user is looking at right now. */
export function editorStateProvider(): EditorState {
  const editor = vscode.window.activeTextEditor

  const state: EditorState = {
    activeFile: null,
    languageId: null,
    isDirty: false,
    cursor: null,
    selection: null,
    openFiles: openFiles(),
  }

  if (!editor || editor.document.uri.scheme !== 'file') return state

  state.activeFile = editor.document.uri.fsPath
  state.languageId = editor.document.languageId
  state.isDirty = editor.document.isDirty
  state.cursor = toPosition(editor.selection.active)

  if (!editor.selection.isEmpty) {
    state.selection = {
      start: toPosition(editor.selection.start),
      end: toPosition(editor.selection.end),
      text: editor.document.getText(editor.selection),
    }
  }

  return state
}

function toPosition(position: vscode.Position): EditorPosition {
  return { line: position.line + 1, column: position.character + 1 }
}

/**
 * Open editors, most recently active first.
 *
 * Read from tab groups rather than `workspace.textDocuments`, which also
 * includes documents VSCode has loaded for its own reasons and never showed
 * anyone — reporting those as "open files" would be simply wrong.
 */
function openFiles(): string[] {
  const seen = new Set<string>()
  const files: string[] = []

  const active = vscode.window.activeTextEditor?.document.uri.fsPath
  if (active) {
    seen.add(active)
    files.push(active)
  }

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input: unknown = tab.input
      if (!(input instanceof vscode.TabInputText)) continue
      if (input.uri.scheme !== 'file') continue
      const file = input.uri.fsPath
      if (seen.has(file)) continue
      seen.add(file)
      files.push(file)
    }
  }

  return files
}
