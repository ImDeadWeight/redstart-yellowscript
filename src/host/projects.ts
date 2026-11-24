// =============================================================================
// Projects and workflows: this workspace's link to a Nest project, and the
// account's saved workflows.
// =============================================================================
// Conversations stay in the workspace; the PROJECT is what is shared with the
// other Redstart apps: its instructions and memories reach the model because
// every request names it (`redstart_project`), and Nest checks the caller may
// read it. The link is kept per workspace and is only valid for the server and
// account it was made with: another Nest, or another account, starts unlinked.
//
// Workflows are the account's saved instructions, run from `/` or the page;
// Nest composes their text from its own copy.
//
// No `vscode` import: the store, the views and the connection are passed in.
// =============================================================================

import type { ConnectionState } from '../connection.ts'
import type { HostMessage, ProjectView, WorkflowView } from '../chat/protocol.ts'
import type { NestClient, NestProject } from '../nest/client.ts'
import type { McpHost } from '../nest/mcp-host.ts'
import type { Surface } from '../ui/chat-view.ts'

export const PROJECT_LINK_KEY = 'redstartYellowscript.projectLink'

export interface ProjectLink {
  server: string
  account: string
  id: string
  name: string
}

/** Where the link is kept: the workspace's memento. */
export interface LinkStore {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): PromiseLike<void>
}

export interface ProjectsDeps {
  connection: { readonly state: ConnectionState; readonly activeClient: Pick<NestClient, 'listProjects' | 'createProject'> | null }
  /** The signed-in account, or null. */
  account: () => string | null
  store: LinkStore
  post: (to: Surface, message: HostMessage) => void
  /** The MCP host of the current connection, which serves the workflows. */
  mcp: () => Pick<McpHost, 'listPrompts' | 'getPrompt'> | null
  /** The linked project changed, so every view's snapshot should say so. */
  onLinkChanged: () => void
  /** Send a workflow's composed text as a message from that surface. */
  send: (from: Surface, text: string, workflow: { name: string; title: string }) => void
}

export interface Projects {
  /** The project this workspace is linked to on this server and account. */
  linked(): ProjectLink | null
  /** The projects page: a loading state, then the account's projects. */
  push(to: Surface): Promise<void>
  /** Link a project (null: unlink), then refresh the page. */
  link(from: Surface, id: string | null): Promise<void>
  /** Create a project from the page and link it. */
  create(from: Surface, name: string): Promise<void>
  /** The workflows page. */
  pushWorkflows(to: Surface): Promise<void>
  runWorkflow(from: Surface, name: string, args: Record<string, string>): Promise<void>
}

export function createProjects(deps: ProjectsDeps): Projects {
  /** The account's workflows, from the last prompts/list. */
  let workflowCache: WorkflowView[] = []

  const scope = (): { server: string; account: string } | null => {
    const state = deps.connection.state
    if (state.status !== 'connected' || !('url' in state) || !state.url) return null
    return { server: state.url, account: deps.account() ?? '' }
  }

  const linked = (): ProjectLink | null => {
    const current = scope()
    const link = deps.store.get<ProjectLink>(PROJECT_LINK_KEY)
    if (!current || !link) return null
    return link.server === current.server && link.account === current.account ? link : null
  }

  const push = async (to: Surface): Promise<void> => {
    const client = deps.connection.activeClient
    const linkedId = linked()?.id ?? null
    deps.post(to, { type: 'projects', projects: null, linkedId })
    if (!client) {
      deps.post(to, { type: 'projects', projects: [], linkedId, error: 'Not connected to a Nest.' })
      return
    }
    try {
      const { projects } = await client.listProjects()
      // A linked project that is gone (deleted in the chat app) is unlinked
      // here, so the panel does not claim a project the requests no longer get.
      if (linkedId && !projects.some((p) => p.id === linkedId)) {
        await deps.store.update(PROJECT_LINK_KEY, undefined)
        deps.onLinkChanged()
      }
      deps.post(to, {
        type: 'projects',
        projects: projects.map(toProjectView),
        linkedId: linked()?.id ?? null,
      })
    } catch (err) {
      deps.post(to, { type: 'projects', projects: [], linkedId, error: describeError(err, 'Could not load projects') })
    }
  }

  const link = async (from: Surface, id: string | null): Promise<void> => {
    const current = scope()
    if (!current) return
    if (id === null) {
      await deps.store.update(PROJECT_LINK_KEY, undefined)
    } else {
      const client = deps.connection.activeClient
      const project = client ? (await client.listProjects().catch(() => ({ projects: [] as NestProject[] }))).projects.find((p) => p.id === id) : undefined
      if (!project) {
        deps.post(from, { type: 'notice', level: 'error', message: 'That project is no longer on the Nest.' })
        return
      }
      const next: ProjectLink = { ...current, id: project.id, name: project.name }
      await deps.store.update(PROJECT_LINK_KEY, next)
    }
    deps.onLinkChanged()
    await push(from)
  }

  return {
    linked,
    push,
    link,
    async create(from, name) {
      const client = deps.connection.activeClient
      if (!client) return
      try {
        const project = await client.createProject(name)
        await link(from, project.id)
      } catch (err) {
        deps.post(from, { type: 'notice', level: 'error', message: describeError(err, 'Could not create the project') })
        await push(from)
      }
    },
    async pushWorkflows(to) {
      const mcp = deps.mcp()
      if (!mcp) {
        deps.post(to, { type: 'workflows', workflows: [], error: 'Workflows need the Nest connection. Try reconnecting.' })
        return
      }
      try {
        workflowCache = (await mcp.listPrompts()).map((p) => ({ ...p, arguments: p.arguments.map((a) => ({ ...a })) }))
        deps.post(to, { type: 'workflows', workflows: workflowCache })
      } catch (err) {
        deps.post(to, { type: 'workflows', workflows: [], error: describeError(err, 'Could not load workflows') })
      }
    },
    async runWorkflow(from, name, args) {
      const mcp = deps.mcp()
      if (!mcp) return
      try {
        // Nest composes the text from its own copy of the workflow.
        const text = await mcp.getPrompt(name, args)
        const title = workflowCache.find((w) => w.name === name)?.title ?? name
        deps.send(from, text, { name, title })
      } catch (err) {
        deps.post(from, { type: 'notice', level: 'error', message: describeError(err, `Could not run the workflow "${name}"`) })
      }
    },
  }
}

export function toProjectView(p: NestProject): ProjectView {
  const view: ProjectView = { id: p.id, name: p.name }
  const instructions = p.instructions?.trim()
  if (instructions) view.instructions = instructions.length > 160 ? `${instructions.slice(0, 159)}…` : instructions
  if (p.folder) view.folder = p.folder
  return view
}

function describeError(err: unknown, lead: string): string {
  return `${lead}: ${err instanceof Error ? err.message : String(err)}`
}
