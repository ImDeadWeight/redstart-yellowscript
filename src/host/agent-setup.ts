// =============================================================================
// The agent's setup in VS Code: the implementations agent/compose.ts runs a
// chat's agent against.
// =============================================================================
// Writes are reviewed as diffs and checkpointed in the shadow repo; commands
// are classified, asked about on the card and streamed to the "Yellowscript
// Commands" channel; diagnostics come from the editor; the read roots and the
// turn limit are settings. A headless host builds its own AgentSetup instead.
// =============================================================================

import * as vscode from 'vscode'
import * as nodeFs from 'node:fs'

import type { AgentSetup } from '../agent/compose.ts'
import { DEFAULT_MAX_ITERATIONS } from '../agent/loop.ts'
import type { ConnectionManager } from '../connection.ts'
import { nodeCommandContext } from '../tools/command-context.ts'
import { usableReadRoots } from '../tools/read-scope.ts'
import { classifyCommand, type CommandContext } from '../tools/safe-commands.ts'
import type { PendingCommand } from '../tools/types.ts'
import { makeCommandGate } from '../ui/run-command.ts'
import { approvalStore, diagnosticsAfterWrite, workspaceRoots } from '../ui/tool-providers.ts'
import { checkpointForWorkspace, makeApprovalGate } from '../ui/write-approval.ts'
import { config, extraReadRoots } from './config.ts'
import type { Projects } from './projects.ts'
import type { Tasks } from './tasks.ts'
import type { Tooling } from './tooling.ts'

export interface AgentSetupDeps {
  manager: Pick<ConnectionManager, 'activeClient' | 'handleUnauthorized'>
  tooling: Pick<Tooling, 'current' | 'processes' | 'commandChannel'>
  projects: Pick<Projects, 'linked'>
  tasks: Pick<Tasks, 'recordCheckpoint' | 'trusted' | 'trust' | 'checkpoints' | 'writePlan'>
  log: { info(line: string): void; warn(line: string): void }
}

export function createAgentSetup(deps: AgentSetupDeps): AgentSetup {
  const { tasks, tooling } = deps

  /** What the command classifier needs to know about this workspace and run. */
  const commandContextFor = (conversationId: string, pending: PendingCommand): CommandContext =>
    nodeCommandContext({
      cwd: pending.cwd,
      roots: workspaceRoots().map((root) => {
        try {
          return nodeFs.realpathSync.native(root)
        } catch {
          return root
        }
      }),
      readRoots: usableReadRoots(extraReadRoots()),
      builtInSafe: config().get<boolean>('commands.builtInSafe') !== false,
      projectChecks: config().get<boolean>('commands.autoRunProjectChecks') !== false,
      background: pending.background === true,
      // package.json as this run's first checkpoint of it holds it.
      packageJsonBeforeRun: (file) => {
        const key = file.toLowerCase()
        for (const entry of tasks.checkpoints(conversationId)) {
          const staged = entry.files.find((f) => f.workspaceAbsolute.toLowerCase() === key)
          if (staged) return staged.wasAbsent ? '' : staged.content
        }
        return null
      },
    })

  return {
    client: () => deps.manager.activeClient ?? null,
    onUnauthorized: () => deps.manager.handleUnauthorized(),
    workspace: {
      roots: workspaceRoots,
      readRoots: extraReadRoots,
      allowReadRoot: async (folder) => {
        await config().update('extraReadRoots', [...new Set([...extraReadRoots(), folder])], vscode.ConfigurationTarget.Workspace)
      },
    },
    tools: () => tooling.current(),
    project: () => deps.projects.linked(),
    processes: tooling.processes,
    gates: {
      change: ({ conversationId, root, ask }) =>
        makeApprovalGate({
          ask,
          checkpoints: checkpointForWorkspace(root),
          root,
          store: approvalStore(),
          recordCheckpoint: (checkpoint, files) => tasks.recordCheckpoint(conversationId, root, checkpoint, files),
          task: {
            trusted: () => tasks.trusted(conversationId),
            trust: () => tasks.trust(conversationId),
          },
        }),
      command: ({ conversationId, ask }) =>
        makeCommandGate({
          channel: tooling.commandChannel,
          processes: tooling.processes,
          ask,
          classify: (command) => classifyCommand(command.command, commandContextFor(conversationId, command)),
          conversationId,
          nonInteractive: () => config().get<boolean>('commands.nonInteractive') !== false,
        }),
    },
    diagnosticsAfterWrite,
    onPlanChanged: (steps) => tasks.writePlan(steps),
    maxTurns: () => config().get<number>('agent.maxTurns') ?? DEFAULT_MAX_ITERATIONS,
    log: deps.log,
  }
}
