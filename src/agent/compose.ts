// =============================================================================
// One chat's agent, put together: the ChatSession and everything it runs
// against.
// =============================================================================
// The product and the benchmark run the same agent. What differs between them
// is behind small interfaces: where the workspace is, how a write or a command
// is approved, what diagnostics follow a write, what is running. The extension
// supplies VS Code-backed implementations (host/agent-setup.ts); a headless
// host (the benchmark, a test) supplies its own. Everything else (the
// workspace message, the read prompt, the guard for a window with no folder,
// the turn limit, the trim log) is decided here, once.
//
// No `vscode` import.
// =============================================================================

import type { AskApproval } from '../chat/approvals.ts'
import type { HostMessage } from '../chat/protocol.ts'
import { ChatSession } from '../chat/session.ts'
import type { NestClient } from '../nest/client.ts'
import type { BackgroundProcesses } from '../tools/background-processes.ts'
import { describeRunning } from '../tools/background-processes.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import { buildWorkspaceContext } from '../tools/workspace-context.ts'
import type { PlanStep, StagnationLimits } from './agent-core.ts'
import type { ContextTracker, FitReport } from './context-budget.ts'
import type { AgentResult, ApprovalGate, CommandApprovalGate } from './loop.ts'

/** The folders the agent works in, and the ones it may only read. */
export interface AgentWorkspace {
  /** The open folders; none means a plain chat, with no tools. */
  roots(): string[]
  /** Folders outside the workspace the read tools may read. */
  readRoots(): string[]
  /** The person chose "Always for this folder": add it to readRoots. */
  allowReadRoot(folder: string): Promise<void>
}

/** How a planned write or command is approved for one conversation. */
export interface AgentGates {
  /** Review (or apply) a write in `root`, asking on the conversation's card. */
  change(options: { conversationId: string; root: string; ask: AskApproval }): ApprovalGate
  /** Run (or decline) a command, asking on the conversation's card. */
  command(options: { conversationId: string; ask: AskApproval }): CommandApprovalGate
}

/** Everything one chat's agent runs against, shared by every conversation. */
export interface AgentSetup {
  /** The connected client, or null when not connected. */
  client(): NestClient | null
  /** A request came back 401, so the connection can re-prompt. */
  onUnauthorized(): void | Promise<void>
  workspace: AgentWorkspace
  /** The tools the model gets (with a folder open). */
  tools(): ToolRegistry
  /** The Nest project requests are for, named in the workspace message. */
  project(): { id: string; name: string } | null
  /** What is running, told to the model on each request. */
  processes: Pick<BackgroundProcesses, 'list'>
  gates: AgentGates
  /** After an applied write: the problems now in those files. Absent: none are reported. */
  diagnosticsAfterWrite?: (files: string[]) => Promise<string | null>
  /** The plan changed (null: cleared). */
  onPlanChanged?: (steps: PlanStep[] | null) => void
  /** Round trips before the person is asked whether to keep going. */
  maxTurns(): number
  /** Stagnation thresholds (agent-core STAGNATION_LIMITS); absent: the defaults.
   *  The bench's STAGNATION_OFF keeps only the exact-repeat guard. */
  stagnation?: () => Partial<StagnationLimits> | undefined
  log: { info(line: string): void; warn(line: string): void }
}

/** What the host that keeps a session gives it. */
export interface SessionHooks {
  emit(message: HostMessage): void
  /** The transcript changed durably: save it. */
  onPersist(): void
  /** The connected client's context window. */
  context(): ContextTracker | null
  /** A run ended: everything it did. The bench records it; the editor does not need it. */
  onAgentResult?: (result: AgentResult) => void
  /** Old messages were trimmed to fit the window (besides the log line). */
  onContextTrimmed?: (report: FitReport) => void
}

/** One conversation's ChatSession, with everything its agent runs against. */
export function composeSession(setup: AgentSetup, conversationId: string, hooks: SessionHooks): ChatSession {
  const { workspace, log } = setup
  const ask: AskApproval = (request) => session.askApproval(request)

  const session: ChatSession = new ChatSession({
    getClient: () => setup.client(),
    context: hooks.context,
    ...(setup.diagnosticsAfterWrite ? { diagnosticsAfterWrite: setup.diagnosticsAfterWrite } : {}),
    ...(setup.onPlanChanged ? { onPlanChanged: setup.onPlanChanged } : {}),
    workspaceContext: () => {
      const root = workspace.roots()[0]
      if (!root) return null
      // What it is told about keeping notes, plans and memories follows the
      // tools it actually has, and whether the workspace has a project.
      return buildWorkspaceContext(root, undefined, {
        tools: setup.tools().names,
        project: setup.project()?.name ?? null,
      })
    },
    liveState: () => describeRunning(setup.processes.list()),
    maxTurns: () => setup.maxTurns(),
    ...(setup.stagnation ? { stagnation: setup.stagnation } : {}),
    ...(hooks.onAgentResult ? { onAgentResult: hooks.onAgentResult } : {}),
    onContextTrimmed: (report) => {
      hooks.onContextTrimmed?.(report)
      log.info(
        `context: trimmed to fit (~${report.before} → ~${report.after} of ${report.usable ?? '?'} usable tokens; ` +
          `${report.stubbed} old results stubbed, ${report.shrunk} calls shrunk, ${report.capped} messages capped)` +
          (report.overLimit ? '  [STILL OVER the window]' : ''),
      )
    },
    onUnauthorized: () => setup.onUnauthorized(),
    tools: () => (workspace.roots().length > 0 ? setup.tools() : null),
    toolContext: () => ({
      workspaceRoots: workspace.roots(),
      readRoots: workspace.readRoots(),
      askRead: async (request) => {
        const outside = request.outsideFolder
        const choice = await ask({
          kind: 'tool',
          title: outside ? 'Read outside the workspace' : 'Read a file that may hold secrets',
          subject: request.label,
          detail: outside
            ? `It is outside the workspace. Reading only; nothing there is ever written. "Always" allows reading ${outside}.`
            : `${request.reason}. What it says goes to the model and is saved with this chat.`,
          options: [
            { id: 'read', label: 'Allow this time', kind: 'allow' },
            ...(outside ? [{ id: 'always', label: 'Always for this folder', kind: 'always' as const }] : []),
            { id: 'deny', label: 'Deny', kind: 'deny' },
          ],
        })
        if (choice === 'always' && outside) await workspace.allowReadRoot(outside)
        return choice === 'read' || choice === 'always'
      },
    }),
    approveChange: (pending) => {
      const root = workspace.roots()[0]
      if (!root) {
        log.warn('No workspace folder is open, so writes cannot be reviewed or applied.')
        return Promise.resolve(false)
      }
      return setup.gates.change({ conversationId, root, ask })(pending)
    },
    approveCommand: (pending) => setup.gates.command({ conversationId, ask })(pending),
    conversationId,
    projectId: () => setup.project()?.id ?? null,
    onPersist: hooks.onPersist,
    emit: hooks.emit,
  })
  return session
}
