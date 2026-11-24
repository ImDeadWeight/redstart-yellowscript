// =============================================================================
// Tests for the workspace's project link and the workflows page.
// =============================================================================

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { ConnectionState } from '../connection.ts'
import type { HostMessage } from '../chat/protocol.ts'
import type { NestProject } from '../nest/client.ts'
import type { Surface } from '../ui/chat-view.ts'
import { PROJECT_LINK_KEY, createProjects, type LinkStore, type ProjectsDeps } from './projects.ts'

const surface: Surface = { id: 's1', conversationId: 'c1' }

function memoryStore(): LinkStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      if (value === undefined) data.delete(key)
      else data.set(key, value)
    },
  }
}

function setup(options: { url?: string; account?: string | null; projects?: NestProject[] } = {}) {
  const posted: HostMessage[] = []
  const sent: Array<{ text: string; workflow: { name: string; title: string } }> = []
  let linkChanges = 0
  const store = memoryStore()
  const state = { status: 'connected', url: options.url ?? 'http://nest:19080' } as ConnectionState
  const connection = {
    state,
    activeClient: {
      listProjects: async () => ({ projects: options.projects ?? [{ id: 'p1', name: 'Alpha' }] as NestProject[] }),
      createProject: async (name: string) => ({ id: 'p2', name }) as NestProject,
    },
  }
  const deps: ProjectsDeps = {
    connection,
    account: () => (options.account === undefined ? 'pat' : options.account),
    store,
    post: (_to, message) => posted.push(message),
    mcp: () => ({
      listPrompts: async () => [{ name: 'review', title: 'Review the diff', description: '', arguments: [] }],
      getPrompt: async (name: string) => `run ${name}`,
    }),
    onLinkChanged: () => linkChanges++,
    send: (_from, text, workflow) => sent.push({ text, workflow }),
  }
  return { projects: createProjects(deps), posted, sent, store, linkChanges: () => linkChanges }
}

describe('the project link', () => {
  test('a link holds only for the server and account it was made with', async () => {
    const { projects, store } = setup()
    await projects.link(surface, 'p1')
    assert.deepEqual(projects.linked(), { server: 'http://nest:19080', account: 'pat', id: 'p1', name: 'Alpha' })

    const otherServer = setup({ url: 'http://other:19080' })
    otherServer.store.data.set(PROJECT_LINK_KEY, store.data.get(PROJECT_LINK_KEY))
    assert.equal(otherServer.projects.linked(), null)

    const otherAccount = setup({ account: 'sam' })
    otherAccount.store.data.set(PROJECT_LINK_KEY, store.data.get(PROJECT_LINK_KEY))
    assert.equal(otherAccount.projects.linked(), null)
  })

  test('linking a project that is gone says so and keeps the old link', async () => {
    const { projects, posted, linkChanges } = setup()
    await projects.link(surface, 'missing')
    assert.equal(projects.linked(), null)
    assert.equal(linkChanges(), 0)
    assert.deepEqual(posted.at(-1), { type: 'notice', level: 'error', message: 'That project is no longer on the Nest.' })
  })

  test('the page unlinks a project deleted elsewhere', async () => {
    const first = setup()
    await first.projects.link(surface, 'p1')
    const later = setup({ projects: [{ id: 'p9', name: 'Other' } as NestProject] })
    later.store.data.set(PROJECT_LINK_KEY, first.store.data.get(PROJECT_LINK_KEY))
    await later.projects.push(surface)
    assert.equal(later.projects.linked(), null)
    assert.equal(later.linkChanges(), 1)
    assert.deepEqual(later.posted.at(-1), { type: 'projects', projects: [{ id: 'p9', name: 'Other' }], linkedId: null })
  })

  test('a created project is linked', async () => {
    const { projects } = setup({ projects: [{ id: 'p2', name: 'Beta' } as NestProject] })
    await projects.create(surface, 'Beta')
    assert.equal(projects.linked()?.id, 'p2')
  })
})

describe('workflows', () => {
  test('a workflow runs as a message titled from the page', async () => {
    const { projects, sent } = setup()
    await projects.pushWorkflows(surface)
    await projects.runWorkflow(surface, 'review', {})
    assert.deepEqual(sent, [{ text: 'run review', workflow: { name: 'review', title: 'Review the diff' } }])
  })
})
