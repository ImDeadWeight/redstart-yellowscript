// =============================================================================
// What the editor hands the chat: @file attachments, the @ picker's search,
// the selection, and "Fix with Yellowscript" on a diagnostic.
// =============================================================================

import * as vscode from 'vscode'
import * as nodeFs from 'node:fs'

import { MAX_FILE_LINES } from '../chat/attachments.ts'
import type { AttachmentView, HostMessage } from '../chat/protocol.ts'
import { secretReason } from '../tools/protected-paths.ts'
import { formatOutline, outlineOf, type SymbolProvider } from '../tools/symbols.ts'
import { resolveWithinWorkspace } from '../tools/workspace-path.ts'
import type { Surface } from '../ui/chat-view.ts'

export const FIX_DIAGNOSTIC_COMMAND = 'redstartYellowscript.fixDiagnostic'

export interface EditorActionsDeps {
  /** The open workspace folders. */
  roots: () => string[]
  symbols: SymbolProvider
  post: (to: Surface, message: HostMessage) => void
  /** Bring the chat a command lands in to the front; undefined: there is none. */
  revealTarget: () => Promise<Surface | undefined>
  send: (surface: Surface, text: string, attachments: AttachmentView[]) => void
}

export interface EditorActions {
  /**
   * A message's @file attachments, read now: the content (up to 300 lines) or
   * the outline of a longer file. Files outside the workspace or that may hold
   * secrets are not attached; a notice says so.
   */
  resolveAttachments(from: Surface, list: readonly AttachmentView[]): Promise<AttachmentView[]>
  /** The @ picker: workspace files whose path contains `query`, shortest first. */
  searchFiles(query: string): Promise<string[]>
  /** The command: the editor's selection, as a chip in the composer. */
  addSelection(): Promise<void>
  /** The command: the problem, and the lines around it, sent to the chat. */
  fixDiagnostic(uri: vscode.Uri, diagnostic: vscode.Diagnostic): Promise<void>
  /** Offers "Fix with Yellowscript" on the first error or warning under the cursor. */
  readonly codeActions: vscode.CodeActionProvider
}

export function createEditorActions(deps: EditorActionsDeps): EditorActions {
  return {
    async resolveAttachments(from, list) {
      const roots = deps.roots()
      const out: AttachmentView[] = []
      for (const a of list) {
        if (a.kind !== 'file') {
          out.push(a)
          continue
        }
        let absolute: string
        try {
          absolute = resolveWithinWorkspace(roots, a.path)
        } catch {
          deps.post(from, { type: 'notice', level: 'warning', message: `${a.path} is outside the workspace, so it was not attached.` })
          continue
        }
        if (secretReason(absolute)) {
          deps.post(from, { type: 'notice', level: 'warning', message: `${a.path} may hold secrets, so it was not attached.` })
          continue
        }
        try {
          const text = (await nodeFs.promises.readFile(absolute, 'utf8')).replace(/\r\n/g, '\n')
          const lines = text.split('\n')
          if (lines.length <= MAX_FILE_LINES) {
            out.push({ kind: 'file', path: a.path, content: text.trimEnd(), lines: lines.length })
          } else {
            const { symbols } = await outlineOf(deps.symbols, absolute, text)
            out.push({ kind: 'file', path: a.path, content: formatOutline(symbols, 150).text || '(no symbols found)', lines: lines.length, outline: true })
          }
        } catch {
          out.push({ kind: 'file', path: a.path })
        }
      }
      return out
    },

    async searchFiles(query) {
      const cleaned = query.replace(/[\\*?{}[\]]/g, '').trim()
      const pattern = cleaned ? `**/*${cleaned}*` : '**/*'
      const found = await vscode.workspace.findFiles(pattern, '{**/node_modules/**,**/.git/**,**/.yellowscript/**,**/dist/**,**/out/**}', 200)
      return found
        .map((uri) => vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/'))
        .filter((p) => !secretReason(p))
        .sort((a, b) => a.length - b.length || a.localeCompare(b))
        .slice(0, 30)
    },

    async addSelection() {
      const editor = vscode.window.activeTextEditor
      if (!editor || editor.document.uri.scheme !== 'file') return
      const selection = editor.selection.isEmpty ? editor.document.lineAt(editor.selection.active.line).range : editor.selection
      const startLine = selection.start.line + 1
      const endLine = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line : selection.end.line + 1
      const range = new vscode.Range(startLine - 1, 0, endLine - 1, editor.document.lineAt(endLine - 1).text.length)
      const target = await deps.revealTarget()
      if (!target) return
      deps.post(target, {
        type: 'addAttachment',
        attachment: { kind: 'selection', path: vscode.workspace.asRelativePath(editor.document.uri, false).replace(/\\/g, '/'), startLine, endLine, text: editor.document.getText(range) },
      })
    },

    async fixDiagnostic(uri, diagnostic) {
      const document = await vscode.workspace.openTextDocument(uri)
      const first = Math.max(0, diagnostic.range.start.line - 8)
      const last = Math.min(document.lineCount - 1, diagnostic.range.end.line + 8)
      const path = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/')
      const source = diagnostic.source ? ` (${diagnostic.source}${diagnostic.code !== undefined ? ` ${typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code}` : ''})` : ''
      const text = document.getText(new vscode.Range(first, 0, last, document.lineAt(last).text.length))
      const target = await deps.revealTarget()
      if (!target) return
      deps.send(target, `Fix this problem in ${path} at line ${diagnostic.range.start.line + 1}: ${diagnostic.message}${source}`, [
        { kind: 'selection', path, startLine: first + 1, endLine: last + 1, text },
      ])
    },

    codeActions: {
      provideCodeActions: (document, _range, context) =>
        context.diagnostics
          .filter((d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
          .slice(0, 1)
          .map((d) => {
            const action = new vscode.CodeAction('Fix with Yellowscript', vscode.CodeActionKind.QuickFix)
            action.command = { command: FIX_DIAGNOSTIC_COMMAND, title: 'Fix with Yellowscript', arguments: [document.uri, d] }
            action.diagnostics = [d]
            return action
          }),
    },
  }
}
