// =============================================================================
// ws_editor_context — what the user is actually looking at.
// =============================================================================
// The tool that makes "fix this" and "explain this" mean something. Without it
// the model has no referent for "this", and either asks or guesses.
//
// Selection text is included because it is usually the entire point of the
// question, but it is capped: a user who selects a whole 4000-line file and
// asks "what does this do" would otherwise spend the context window on the
// selection and leave none for the answer.
//
// Files outside the workspace are OMITTED rather than listed. VSCode will
// happily have a settings.json or a file from another project open, and those
// are not ours to describe — the containment guard decides, not this module.
// =============================================================================

import {
  assertWorkspaceToolName,
  toolError,
  toolOk,
  truncateForModel,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './types.ts'
import { describeWorkspacePath, tryResolveWithinWorkspace } from './workspace-path.ts'

export interface EditorPosition {
  /** 1-based, already converted from VSCode's 0-based Position. */
  line: number
  column: number
}

export interface EditorSelection {
  start: EditorPosition
  end: EditorPosition
  /** The selected text. Empty when the selection is just a cursor. */
  text: string
}

export interface EditorState {
  /** Absolute path of the focused editor, or null when none is focused. */
  activeFile: string | null
  languageId: string | null
  /** True when the active editor has unsaved changes — the model should know
   *  that what is on disk is not what the user is looking at. */
  isDirty: boolean
  cursor: EditorPosition | null
  selection: EditorSelection | null
  /** Absolute paths of all open editors, most recent first. */
  openFiles: readonly string[]
}

export type EditorStateProvider = () => EditorState

/** Characters of selected text passed to the model. */
export const MAX_SELECTION_CHARS = 4_000
/** Open editors listed. Beyond this the list is noise. */
export const MAX_OPEN_FILES = 20

export function createEditorContextTool(provider: EditorStateProvider): Tool {
  return {
    definition: {
      name: assertWorkspaceToolName('ws_editor_context'),
      description:
        'Find out what the user currently has open and selected in the editor: the active file, ' +
        'cursor position, selected text, and the list of open files. Call this when the user ' +
        'says "this", "here", or "the current file" so you know what they mean, rather than ' +
        'asking them.',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },

    async execute(_args: unknown, context: ToolContext): Promise<ToolResult> {
      if (context.workspaceRoots.length === 0) {
        return toolError('No workspace folder is open.')
      }

      const state = provider()
      const roots = context.workspaceRoots
      const inWorkspace = (file: string): boolean =>
        tryResolveWithinWorkspace(roots, file) !== null

      const lines: string[] = []

      if (state.activeFile === null || !inWorkspace(state.activeFile)) {
        // Distinguish "nothing open" from "something open that is not ours" —
        // the second is a real state the model should not be told is the first.
        lines.push(
          state.activeFile === null
            ? 'No file is currently active in the editor.'
            : 'The active editor is a file outside this workspace, so it is not shown.',
        )
      } else {
        const label = describeWorkspacePath(roots, state.activeFile)
        const attributes = [state.languageId, state.isDirty ? 'unsaved changes' : null].filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        )
        lines.push(`Active file: ${label}${attributes.length > 0 ? ` (${attributes.join(', ')})` : ''}`)

        if (state.cursor) {
          lines.push(`Cursor: line ${state.cursor.line}, column ${state.cursor.column}`)
        }

        if (state.selection && state.selection.text.length > 0) {
          const { start, end, text } = state.selection
          const span =
            start.line === end.line
              ? `line ${start.line}`
              : `lines ${start.line}–${end.line}`
          const { text: clipped, truncated } = truncateForModel(text, MAX_SELECTION_CHARS)
          lines.push(
            `Selection: ${span} (${text.length} character${text.length === 1 ? '' : 's'}${truncated ? ', shown truncated' : ''})`,
          )
          lines.push('', '```', clipped, '```')
        } else {
          lines.push('Selection: none')
        }
      }

      const open = state.openFiles.filter(inWorkspace)
      if (open.length > 0) {
        const shown = open.slice(0, MAX_OPEN_FILES)
        const omitted = open.length - shown.length
        lines.push('', `Open files (${open.length}):`)
        for (const file of shown) lines.push(`  ${describeWorkspacePath(roots, file)}`)
        if (omitted > 0) lines.push(`  [${omitted} more not shown]`)
      }

      const { text, truncated } = truncateForModel(lines.join('\n'))
      const summary =
        state.activeFile !== null && inWorkspace(state.activeFile)
          ? `ws_editor_context — ${describeWorkspacePath(roots, state.activeFile)}`
          : 'ws_editor_context — no active file'

      return toolOk(text, summary, truncated)
    },
  }
}
