// =============================================================================
// The tools the model gets: the local ys_* registry, the Nest's own tools
// through the MCP host, and the processes the tools start.
// =============================================================================
// The local registry is built once, at activation, so a missing ripgrep is a
// known, reportable state rather than a surprise on the first search: the
// search tools drop to literal matching and say so in the description the
// model plans against. The Nest's tools are merged in on every (re)connect and
// dropped on disconnect.
// =============================================================================

import * as vscode from 'vscode'
import * as nodePath from 'node:path'

import { findBrowser } from '../browser/cdp.ts'
import type { AskApproval } from '../chat/approvals.ts'
import { PLAN_DIR } from '../chat/plan-file.ts'
import type { HostMessage } from '../chat/protocol.ts'
import { approvalInfo, callWithApproval } from '../nest/approval.ts'
import type { NestClient } from '../nest/client.ts'
import { McpHost, withProjectMeta, type McpTool } from '../nest/mcp-host.ts'
import { BackgroundProcesses } from '../tools/background-processes.ts'
import { createToolRegistry, mergeNestTools, type NestToolRef, type ToolRegistry } from '../tools/registry.ts'
import { makeNestApprovalDeps, promptInChat } from '../ui/nest-approval.ts'
import { diagnosticsProvider, editorStateProvider, resolveRipgrep, symbolProvider } from '../ui/tool-providers.ts'
import { config } from './config.ts'

export interface ToolingDeps {
  log: vscode.LogOutputChannel
  /** The open workspace folders. */
  roots: () => string[]
  /** To every view: the tool picker and the cards follow the tool set. */
  broadcast: (message: HostMessage) => void
  /** Ask on the card of the conversation that made a Nest tool call. */
  askerFor: (conversationId: string) => AskApproval | undefined
  /** The linked Nest project, which the Nest's tool calls carry. */
  projectId: () => string | undefined
}

export interface Tooling {
  /** Every process Yellowscript starts. */
  readonly processes: BackgroundProcesses
  /** Live output of approved commands ("Yellowscript Commands"). */
  readonly commandChannel: vscode.OutputChannel
  /** The local ys_* tools, merged with the Nest's while connected. */
  current(): ToolRegistry
  /** The MCP host of the current connection, or null. */
  mcp(): McpHost | null
  /** Connected: bring up the MCP host against this client. */
  connectNest(client: NestClient): void
  /** Disconnecting: drop the MCP host and the Nest's tools. */
  disconnectNest(): void
  /** The command: run the zero-argument tools and show what the model would get. */
  inspect(): Promise<void>
  /** The window is closing: no process or stream outlives it. */
  stopAll(): void
  /** For the extension's subscriptions. */
  readonly disposables: vscode.Disposable[]
}

export function createTooling(deps: ToolingDeps): Tooling {
  const { log } = deps
  const commandChannel = vscode.window.createOutputChannel('Yellowscript Commands')
  const processes = new BackgroundProcesses((id, chunk) => commandChannel.append(`[${id}] ${chunk}`))
  /** Resolved once — the binary does not move while the window is open, and
   *  probing the filesystem on every search would be wasteful. */
  const ripgrepPath = resolveRipgrep()
  const tools = createToolRegistry({
    ripgrepPath,
    diagnostics: diagnosticsProvider,
    symbols: symbolProvider,
    editorState: editorStateProvider,
    processes,
    unifiedDiff: config().get<boolean>('tools.unifiedDiff') === true,
    browser: {
      // Looked up on use, so a browser installed later is found.
      browser: () => findBrowser(),
      screenshotDir: () => {
        const root = deps.roots()[0]
        return root ? nodePath.join(root, PLAN_DIR, 'screenshots') : null
      },
    },
  })
  /** The merged registry — local ys_* tools + live Nest tools. Rebuilt whenever the
   *  Nest tool set changes (on connect and on re-list). Cached because the agent
   *  loop reads it per turn. */
  let mergedTools: ToolRegistry | null = null
  let mcpHost: McpHost | null = null

  const roots = deps.roots()
  log.info(
    `tools: ${tools.names.length} registered (${tools.names.join(', ')}); ` +
      `search backend: ${ripgrepPath === null ? 'DEGRADED — ripgrep not found' : 'ripgrep'}; ` +
      `workspace folders: ${roots.length}`,
  )
  if (roots.length === 0) {
    // Worth stating plainly. With no folder open every ys_* tool refuses by
    // design, and that reads as a broken extension unless it is spelled out.
    log.warn('No workspace folder is open — every ys_* tool will refuse until one is.')
  }
  if (ripgrepPath === null) {
    // Worth a log line with the appRoot: the layout has changed between VSCode
    // versions before, and this is the fact needed to add the new one.
    log.warn(`ripgrep was not found under appRoot ${vscode.env.appRoot}`)
  } else {
    log.debug(`ripgrep: ${ripgrepPath}`)
  }

  const current = (): ToolRegistry => mergedTools ?? tools

  /** Push the current tool set to the webview so the picker and cards reflect it. */
  const pushTools = (): void => deps.broadcast({ type: 'tools', names: current().names })

  const disconnectNest = (): void => {
    mcpHost?.stop()
    mcpHost = null
    mergedTools = null
    pushTools()
  }

  /**
   * Bring up the MCP host against the connected Nest. Phase 4.2/4.3: discovers the
   * built-in MCP server via /redstart/mcp-servers, opens the SSE stream, lists
   * tools, and merges them with the local ys_* set under a disjointness assertion.
   *
   * Re-run on every (re)connect — the tool set follows the active profile, so a
   * cached list is stale the moment an operator switches profiles without the
   * connection dropping. On failure the extension still works with just the local
   * ys_* tools — the MCP host is a bonus, not a hard dependency.
   */
  const connectNest = (client: NestClient): void => {
    // Drop any previous session: a reconnect means a new SSE stream and a fresh
    // tool set.
    disconnectNest()
    let currentDisabled = new Set<string>()
    // Approvals for Nest's own tools: per connection, because the grant cache
    // belongs to the account this client is signed in as.
    const approvals = makeNestApprovalDeps(client, (m) => log.warn(m))
    const host = new McpHost(
      {
        baseUrl: client.baseUrl,
        listMcpServers: (signal) => client.listMcpServers(signal),
        fetch: (input, init) => fetch(input, init),
        getCredential: () => client.getCredential(),
      },
      {
        onTools: (mcpTools: readonly McpTool[]) => {
          const refs: NestToolRef[] = mcpTools
            .filter((t) => !currentDisabled.has(t.name))
            .map((t) => {
              const ref: NestToolRef = {
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
                execute: async (args: unknown, context) => {
                  // Ask on the card of the conversation that made the call.
                  const ask = context.conversationId ? deps.askerFor(context.conversationId) : undefined
                  return (
                    await callWithApproval(t.name, args, approvalInfo(t.meta), {
                      ...approvals,
                      ...(ask ? { prompt: (request) => promptInChat(request, ask) } : {}),
                      call: (meta) => host.callToolResult(t.name, args, withProjectMeta(meta, deps.projectId())),
                    })
                  ).text
                },
              }
              if (t.meta) ref.meta = t.meta
              return ref
            })
          try {
            mergedTools = mergeNestTools(tools, refs)
            log.info(`mcp: merged ${refs.length} Nest tools with ${tools.names.length} local ys_* tools`)
            pushTools()
          } catch (err) {
            log.error(`mcp: merge rejected — ${(err as Error).message}`)
          }
        },
        onConnection: (conn) => {
          log.info(`mcp: connected to ${conn.servers[0]?.name ?? 'unknown'} (${conn.servers.length} server(s))`)
          // Track server-banned tool names for UX greying (HANDOFF 4.4). The
          // gateway also strips them server-side — this is the visibility layer.
          currentDisabled = new Set(conn.disabledTools)
        },
        onError: (err) => {
          log.error(`mcp: ${err.message}`)
          // A dead MCP host should not brick the extension — clear the merged set
          // so the model sees only local tools, and let the next reconnect retry.
          mergedTools = null
          pushTools()
        },
      },
    )

    mcpHost = host
    void host.connect().catch((err: unknown) => {
      log.error('mcp: connect failed', err)
    })
  }

  /**
   * Run a ys_* tool by hand and show what the model would receive.
   *
   * This is the only way to exercise the VSCode-backed providers — diagnostics
   * and editor context — outside an agent turn, since unit tests cannot reach the
   * real `vscode` API. It doubles as the answer to "what can the agent actually
   * see in this workspace?", which is a fair question for a user to ask about a
   * tool that reads their files.
   */
  const inspect = async (): Promise<void> => {
    // Show the channel FIRST. Every failure below is then visible in it, rather
    // than the command appearing to do nothing — which is exactly what an earlier
    // version of this did when it returned early without saying so.
    log.show(true)
    log.info('--- Inspect Workspace Tools ---')

    const roots = deps.roots()
    log.info(`workspace folders: ${roots.length > 0 ? roots.join(', ') : '(none open)'}`)
    log.info(`search backend: ${ripgrepPath === null ? 'DEGRADED — ripgrep not found' : ripgrepPath}`)
    log.info(`registered: ${tools.names.join(', ')}`)

    if (roots.length === 0) {
      log.warn('No folder is open, so every tool will refuse. Open a folder and run this again.')
      return
    }

    // Run the zero-argument tools and one filesystem probe. These are the checks
    // that cannot be made from a unit test: ys_diagnostics and ys_editor_context
    // read live VSCode state through the providers, and this is the only place
    // that wiring gets exercised outside an agent turn.
    const probes: Array<{ name: string; args: string }> = [
      { name: 'ys_editor_context', args: '{}' },
      { name: 'ys_diagnostics', args: '{}' },
      { name: 'ys_list_directory', args: '{"path":"."}' },
      { name: 'ys_glob', args: '{"pattern":"**/*.ts"}' },
    ]

    for (const probe of probes) {
      try {
        const result = await tools.execute(probe.name, probe.args, { workspaceRoots: roots })
        const status = result.isError ? 'ERROR' : 'ok'
        log.info(`\n=== ${probe.name}(${probe.args}) -> ${status}${result.truncated ? ', truncated' : ''} ===\n${result.content}`)
      } catch (err) {
        // A tool throwing is a bug — the contract says failures come back as
        // results. Surface it loudly rather than swallowing it.
        log.error(`${probe.name} THREW (this is a bug, not a refusal)`, err)
      }
    }

    log.info('\n--- done ---')
    vscode.window.showInformationMessage('Yellowscript: tool report written to the output channel.')
  }

  return {
    processes,
    commandChannel,
    current,
    mcp: () => mcpHost,
    connectNest,
    disconnectNest,
    inspect,
    stopAll() {
      // A dev server the model started must not outlive the window.
      processes.stopAll()
      mcpHost?.stop()
    },
    disposables: [commandChannel, { dispose: () => void processes.stopAll() }],
  }
}
