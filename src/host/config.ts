// =============================================================================
// The extension's settings (redstartYellowscript.*), read fresh on each use so
// a change in the Settings editor takes effect without a reload.
// =============================================================================

import * as vscode from 'vscode'

import { normalizeBaseUrl } from '../nest/client.ts'

export const CONFIG_SECTION = 'redstartYellowscript'

export function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_SECTION)
}

/** The configured server override, if any, in the shape connect() expects. */
export function explicitUrl(): { url?: string } {
  const configured = config().get<string>('serverUrl', '').trim()
  return configured ? { url: normalizeBaseUrl(configured) } : {}
}

/** Folders outside the workspace the person allowed the read tools. */
export function extraReadRoots(): string[] {
  const value = config().get<string[]>('extraReadRoots')
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim() !== '') : []
}
