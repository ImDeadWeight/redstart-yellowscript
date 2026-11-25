// =============================================================================
// ys_run_command — run a shell command, always-ask.
// =============================================================================
// Phase 4.1. The model proposes a command; the host shows it VERBATIM and runs
// it only on the user's go-ahead. Terminal is the one tool that is never
// auto-approved — a model that can run arbitrary shell is a model that can
// `rm -rf`, so the default is "ask every time", and there is no "always allow"
// for it (intentionally; see HANDOFF 4.1 and the safety model in section E).
//
// THE TOOL ONLY PLANS. Like the write tools, it returns a `PendingCommand` and
// never spawns a process itself. The agent loop routes that through the host's
// `approveCommand` gate, which shows the command, waits for confirmation, runs
// it in the integrated terminal with shell integration, and feeds the captured
// output back to the model. A rejected command returns "not run" — the model is
// never told it executed something it didn't.
//
// CWD CONTAINMENT. A command's working directory is resolved against the
// workspace and proven to stay inside it; an absolute path outside every
// folder is refused. This is softer than file-path containment (shell commands
// legitimately read anywhere via absolute paths they type), but we will not LET
// the model SILENTLY pivot the working directory out of the workspace — if it
// wants to run somewhere else it has to say so and be told no.
//
// No `vscode` import: it takes the cwd resolution through the same
// `resolveWithinWorkspace` guard everything else uses, so the planning is
// testable with a string store.
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  assertWorkspaceToolName,
  stringArg,
  toolError,
  toolOk,
  type PendingCommand,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './types.ts'
import { PathScopeError, resolveWithinWorkspace, describeWorkspacePath } from './workspace-path.ts'

export const runCommandTool: Tool = {
  definition: {
    name: assertWorkspaceToolName('ys_run_command'),
    description:
      'Propose a shell command for a build, test, lint or git. The user sees it verbatim and approves ' +
      'it first. It waits for the command to finish; the result starts with the exit code. For a server ' +
      'or watcher that never exits, use ys_process.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'e.g. "npm test".',
        },
        cwd: {
          type: 'string',
          description: 'Optional workspace directory; default the root.',
        },
        timeout_s: {
          type: 'number',
          description: 'Default 120, max 900.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    if (context.workspaceRoots.length === 0) {
      return toolError('No workspace folder is open, so there is nowhere to run a command.')
    }

    const command = stringArg(args, 'command')
    if (command === null || command.trim() === '') {
      return toolError('ys_run_command requires a "command" string argument.')
    }

    // Resolve and contain the working directory. Absent → first workspace root.
    let cwd: string
    const requestedCwd = stringArg(args, 'cwd')
    if (requestedCwd === null) {
      cwd = context.workspaceRoots[0]!
    } else {
      try {
        cwd = resolveWithinWorkspace(context.workspaceRoots, requestedCwd)
      } catch (err) {
        if (err instanceof PathScopeError) {
          return toolError(`"${requestedCwd}" is outside the workspace; the command cannot run there.`)
        }
        return toolError(
          `Could not resolve working directory "${requestedCwd}": ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    const label = describeWorkspacePath(context.workspaceRoots, cwd)
    const trimmed = command.trim()

    // A command that only says something back is not work. A model with no way
    // to end its turn (or to ask) has been seen spinning through dozens of
    // them; refusing with what to do instead breaks that, and saves a prompt.
    if (isNoOpCommand(trimmed)) {
      return toolError(
        `Not run: \`${trimmed}\` does nothing but print text you wrote, so it cannot tell you anything. ` +
          'If you are finished, reply to the user without calling a tool. To ask the user something, call ask_user. ' +
          'To inspect the environment, run a command that reads it.',
        'ys_run_command — refused: does nothing',
      )
    }
    const escaped = packageJsonEscapeError(trimmed, cwd, context.workspaceRoots, 'ys_run_command')
    if (escaped) return escaped
    const pending: PendingCommand = { command: trimmed, cwd, label }
    const timeoutS = Number((args as { timeout_s?: unknown })?.timeout_s)
    if (Number.isFinite(timeoutS) && timeoutS > 0) pending.timeoutMs = Math.round(timeoutS * 1000)

    return toolOk(
      `Proposed command (awaits your approval):\n\n  ${trimmed}\n\n` +
        `in ${label}. It will NOT run until you approve it.`,
      `ys_run_command — ${trimmed.split('\n')[0]?.slice(0, 60) ?? trimmed} (pending approval)`,
      false,
      undefined,
      pending,
    )
  },
}

/** Package managers, and their subcommands that need no project of their own. */
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PROJECTLESS = new Set([
  'exec', 'x', 'dlx', 'create', 'init', 'help', 'config', 'cache', 'view', 'info', 'show', 'search',
  'login', 'logout', 'whoami', 'ping', 'doctor', 'completion', '-v', '--version', '-h', '--help',
])

/**
 * A package manager that would act on a project outside the workspace. npm,
 * pnpm, yarn and bun look upward for the nearest package.json: run where
 * there is none, `npm run build` builds whatever project sits above. A model
 * that left out "cwd" ran Yellowscript's own check, test and build from
 * sample-workspace, rebuilding the extension it was running in (2026-11-24).
 * npx and `create`/`init` need no project, so they are left alone: a new
 * folder has no package.json until the scaffold writes one.
 */
export function packageJsonEscape(
  command: string,
  cwd: string,
  roots: readonly string[],
): { program: string; label: string; found: string; projects: string[] } | null {
  let here = cwd
  for (const part of command.split('&&').map((p) => p.trim())) {
    const cd = /^cd\s+(?:\/d\s+)?(?:"([^"]+)"|(\S+))$/i.exec(part)
    if (cd) {
      here = path.resolve(here, cd[1] ?? cd[2]!)
      continue
    }
    const words = part.split(/\s+/)
    const program = (words[0] ?? '').toLowerCase().replace(/\.(cmd|exe|bat)$/, '')
    if (!PACKAGE_MANAGERS.has(program)) continue
    const sub = words.slice(1).find((w) => !/^--?(?:prefix|C|cwd|dir)$/i.test(w))
    if (words.slice(1).some((w) => /^--?(?:prefix|C|cwd|dir)(?:=|$)/i.test(w))) continue
    if (sub !== undefined && PROJECTLESS.has(sub.toLowerCase())) continue
    const found = nearestPackageJson(here)
    if (!found || roots.some((root) => isInside(root, found))) continue
    return { program, label: describeWorkspacePath(roots, here), found, projects: projectsUnder(roots) }
  }
  return null
}

/** The refusal for a command packageJsonEscape catches, or null to plan it. */
export function packageJsonEscapeError(command: string, cwd: string, roots: readonly string[], tool: string): ToolResult | null {
  const escape = packageJsonEscape(command, cwd, roots)
  if (!escape) return null
  const where = escape.projects.length ? ` The projects in the workspace: ${escape.projects.map((p) => `"${p}"`).join(', ')}.` : ''
  return toolError(
    `Not run: there is no package.json in "${escape.label}", so ${escape.program} would use ${escape.found}, ` +
      `which is outside the workspace, and act on that project instead. Pass "cwd" with the project's folder.${where}`,
    `${tool} — refused: its package.json is outside the workspace`,
  )
}

function isInside(root: string, file: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p)
    } catch {
      return path.resolve(p)
    }
  }
  const rel = path.relative(real(root), real(file))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function nearestPackageJson(from: string): string | null {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json')
    if (fs.existsSync(candidate)) return candidate
    if (path.dirname(dir) === dir) return null
  }
}

/** Folders up to two levels into the workspace that hold a package.json, as the model would name them. */
function projectsUnder(roots: readonly string[]): string[] {
  const found: string[] = []
  const visit = (dir: string, depth: number) => {
    if (found.length >= 5) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const sub = path.join(dir, entry.name)
      if (fs.existsSync(path.join(sub, 'package.json'))) found.push(describeWorkspacePath(roots, sub))
      else if (depth < 2) visit(sub, depth + 1)
    }
  }
  for (const root of roots) visit(root, 1)
  return found
}

/**
 * A line that does nothing a model could learn from: `echo` of literal text
 * (no variable to expand, no redirect or pipe), `exit`, `true`/`false`, `:`,
 * `rem`, `cls`/`clear`. `echo $PATH` and `echo hi > file` are real work.
 */
export function isNoOpCommand(command: string): boolean {
  const line = command.trim()
  if (/^(exit|true|false|:|rem|cls|clear|pause)(\s+\S*)?$/i.test(line)) return true
  const echo = /^(echo|printf|write-host|write-output)(\s|$)(.*)$/i.exec(line)
  if (!echo) return false
  const rest = echo[3] ?? ''
  // Expands something, or sends the text somewhere: not a no-op.
  return !/[$%`|<>&;]|\$\(/.test(rest)
}
