// =============================================================================
// The Yellowscript Settings page: the values it shows and the changes it makes.
// =============================================================================
// The page lists chat/settings.ts SETTINGS with their current values. A change
// is written where it will take effect: to this workspace when the workspace
// already sets that key (or the setting is per workspace by nature, such as an
// allow list), otherwise to the person's user settings. Any change, from the
// page or the Settings editor, repaints every open page.
// =============================================================================

import * as vscode from 'vscode'

import type { HostMessage } from '../chat/protocol.ts'
import { coerceSetting, SETTINGS, settingDescriptor, type SettingView } from '../chat/settings.ts'
import type { Surface } from '../ui/chat-view.ts'
import { config, CONFIG_SECTION } from './config.ts'

/** Settings that hold workspace-specific facts: written to the workspace when one is open. */
const WORKSPACE_KEYS = new Set(['serverUrl', 'allowedCommands', 'extraReadRoots', 'approvedWriteTools'])

export interface SettingsDeps {
  post: (to: Surface, message: HostMessage) => void
  broadcast: (message: HostMessage) => void
  log: { appendLine(line: string): void }
}

export interface Settings {
  /** Send the page's data to one surface. */
  push(to: Surface): void
  /** Change one setting from the page. */
  update(from: Surface, key: string, value: unknown): Promise<void>
  readonly disposables: vscode.Disposable[]
}

function snapshot(): SettingView[] {
  const c = config()
  return SETTINGS.map((d) => {
    const inspected = c.inspect(d.key)
    const value = coerceSetting(d.key, c.get(d.key)) ?? d.defaultValue
    return { ...d, value, workspace: inspected?.workspaceValue !== undefined }
  })
}

export function createSettings(deps: SettingsDeps): Settings {
  const message = (): HostMessage => ({ type: 'settings', settings: snapshot() })
  return {
    push: (to) => deps.post(to, message()),

    async update(from, key, raw) {
      const value = coerceSetting(key, raw)
      if (!settingDescriptor(key) || value === undefined) return
      const c = config()
      const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0
      const target =
        c.inspect(key)?.workspaceValue !== undefined || (hasWorkspace && WORKSPACE_KEYS.has(key))
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global
      try {
        await c.update(key, value, target)
      } catch (err) {
        deps.log.appendLine(`[settings] could not save ${key}: ${err instanceof Error ? err.message : String(err)}`)
        deps.post(from, { type: 'notice', level: 'error', message: `Could not save that setting: ${err instanceof Error ? err.message : String(err)}` })
        deps.post(from, message())
      }
    },

    disposables: [
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CONFIG_SECTION)) deps.broadcast(message())
      }),
    ],
  }
}
