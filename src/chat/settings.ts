// =============================================================================
// The settings the Yellowscript Settings page shows: one list, in the order
// the page shows them, shared by the host (which reads and writes them) and
// the webview (which draws them).
// =============================================================================
// Each entry mirrors a `redstartYellowscript.*` property in package.json;
// settings.test.ts keeps the two in step. Descriptions are plain text with
// `code` in backticks: the page renders nothing else.
//
// No `vscode` import.
// =============================================================================

export type SettingKind =
  | { kind: 'boolean' }
  | { kind: 'number'; min: number; max: number; integer?: boolean }
  | { kind: 'string'; placeholder?: string }
  | { kind: 'list'; placeholder?: string; options?: readonly string[] }

export type SettingValue = boolean | number | string | string[]

export type SettingDescriptor = SettingKind & {
  /** The key under redstartYellowscript. */
  key: string
  group: SettingGroup
  label: string
  description: string
  defaultValue: SettingValue
}

export const SETTING_GROUPS = ['Connection', 'Agent', 'Commands', 'Files', 'Interface'] as const
export type SettingGroup = (typeof SETTING_GROUPS)[number]

export const SETTINGS: readonly SettingDescriptor[] = [
  {
    key: 'serverUrl',
    group: 'Connection',
    label: 'Nest address',
    description: 'A fixed Nest gateway URL, e.g. `http://192.168.1.20:19080`. When set, discovery is skipped. Leave empty to find the Nest automatically.',
    kind: 'string',
    placeholder: 'Found automatically',
    defaultValue: '',
  },
  {
    key: 'autoConnect',
    group: 'Connection',
    label: 'Reconnect on open',
    description: 'Try to reconnect to the last known Nest when a window opens.',
    kind: 'boolean',
    defaultValue: true,
  },
  {
    key: 'discovery.enabled',
    group: 'Connection',
    label: 'Find the Nest on the network',
    description: 'Scan the local network for a running Redstart Nest on connect.',
    kind: 'boolean',
    defaultValue: true,
  },
  {
    key: 'discovery.timeoutMs',
    group: 'Connection',
    label: 'Discovery timeout (ms)',
    description: 'How long to wait for each host to answer. Raise this on a slow or congested network.',
    kind: 'number',
    min: 50,
    max: 5000,
    integer: true,
    defaultValue: 400,
  },
  {
    key: 'agent.maxTurns',
    group: 'Agent',
    label: 'Turns before asking',
    description: 'Model round trips one message may run before Yellowscript asks whether to keep going. Continue grants as many again. A repeated identical tool call is stopped sooner.',
    kind: 'number',
    min: 5,
    max: 500,
    integer: true,
    defaultValue: 40,
  },
  {
    key: 'tools.unifiedDiff',
    group: 'Agent',
    label: 'Offer diff edits',
    description: 'Offer the model `ys_edit_file`, which edits with a unified diff. Small models get diffs wrong, and `ys_replace` covers the same edits. Takes effect in a new window.',
    kind: 'boolean',
    defaultValue: false,
  },
  {
    key: 'commands.builtInSafe',
    group: 'Commands',
    label: 'Run read-only commands without asking',
    description: 'Listing, reading and searching workspace files, versions, read-only git and `tsc --noEmit`. A line that chains, pipes, redirects, or reaches outside the workspace always asks.',
    kind: 'boolean',
    defaultValue: true,
  },
  {
    key: 'commands.autoRunProjectChecks',
    group: 'Commands',
    label: 'Run project checks without asking',
    description: "The project's own `test`, `build`, `lint`, `typecheck` and `check` scripts, a dev server in the background, and locally installed test runners and linters. A script this run changed asks.",
    kind: 'boolean',
    defaultValue: true,
  },
  {
    key: 'commands.nonInteractive',
    group: 'Commands',
    label: 'Run commands with CI=1',
    description: 'Most tools then skip their prompts and test runners skip watch mode. Background commands never get it.',
    kind: 'boolean',
    defaultValue: true,
  },
  {
    key: 'allowedCommands',
    group: 'Commands',
    label: 'Always-allowed commands',
    description: 'Command prefixes that run without asking in this workspace, e.g. `npm test`. A line that chains, pipes or redirects always asks.',
    kind: 'list',
    placeholder: 'npm test',
    defaultValue: [],
  },
  {
    key: 'extraReadRoots',
    group: 'Files',
    label: 'Extra read-only folders',
    description: 'Folders outside the workspace that the read tools may read (never write).',
    kind: 'list',
    placeholder: 'C:\\path\\to\\folder',
    defaultValue: [],
  },
  {
    key: 'approvedWriteTools',
    group: 'Files',
    label: 'Always-allowed write tools',
    description: 'Write tools that run without asking in this workspace.',
    kind: 'list',
    options: ['ys_write_file', 'ys_edit_file'],
    defaultValue: [],
  },
  {
    key: 'notifyWhenWaiting',
    group: 'Interface',
    label: 'Notify when a chat waits',
    description: 'When the window is not focused, show a notification when a chat waits for you or a long run finishes.',
    kind: 'boolean',
    defaultValue: true,
  },
  {
    key: 'editorButton',
    group: 'Interface',
    label: 'Editor title button',
    description: 'Show the Yellowscript button in the editor title bar, which opens a new chat in an editor tab.',
    kind: 'boolean',
    defaultValue: true,
  },
]

/** A setting as the page shows it: its descriptor and its current value. */
export type SettingView = SettingDescriptor & {
  value: SettingValue
  /** Set in this workspace's settings (the page then edits that copy). */
  workspace: boolean
}

export function settingDescriptor(key: string): SettingDescriptor | undefined {
  return SETTINGS.find((s) => s.key === key)
}

/** `value` as the setting `key` takes it, or undefined when it does not fit.
 *  Numbers are clamped and rounded; lists are trimmed, deduplicated and, for
 *  a list of options, kept to those options. */
export function coerceSetting(key: string, value: unknown): SettingValue | undefined {
  const d = settingDescriptor(key)
  if (!d) return undefined
  switch (d.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
      const n = Math.min(d.max, Math.max(d.min, value))
      return d.integer ? Math.round(n) : n
    }
    case 'string':
      return typeof value === 'string' && value.length <= 2_000 ? value.trim() : undefined
    case 'list': {
      if (!Array.isArray(value) || value.length > 200) return undefined
      const items = value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter((v) => v !== '' && v.length <= 2_000)
      const allowed = d.options ? items.filter((v) => d.options!.includes(v)) : items
      return [...new Set(allowed)]
    }
  }
}
