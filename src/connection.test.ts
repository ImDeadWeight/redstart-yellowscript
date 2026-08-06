import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  ConnectionManager,
  type ConnectionState,
  type CredentialStore,
  type StateStore,
} from './connection.ts'
import { NestClient } from './nest/client.ts'
import { NestHttpError, type Credential } from './nest/types.ts'
import type { DiscoveredNest } from './nest/discovery.ts'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const USER = {
  id: 'u1',
  username: 'ada',
  role: 'admin',
  apiKeyPrefix: 'rst_abc',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
}

class FakeCredentialStore implements CredentialStore {
  entries = new Map<string, Credential>()
  async get(url: string) {
    return this.entries.get(url) ?? null
  }
  async set(url: string, credential: Credential) {
    this.entries.set(url, credential)
  }
  async delete(url: string) {
    this.entries.delete(url)
  }
}

class FakeStateStore implements StateStore {
  last: string | undefined
  constructor(last?: string) {
    this.last = last
  }
  getLastServerUrl() {
    return this.last
  }
  async setLastServerUrl(url: string | undefined) {
    this.last = url
  }
}

/** Route table for the fake transport: path -> handler. */
type Routes = Record<string, (init?: RequestInit) => { status: number; body: unknown }>

function makeClientFactory(routes: Routes, seen: string[] = []) {
  return (baseUrl: string) =>
    new NestClient(baseUrl, {
      fetch: async (input, init) => {
        const path = input.replace(baseUrl, '')
        seen.push(`${init?.method ?? 'GET'} ${path}`)
        const handler = routes[path]
        if (!handler) return new Response('not found', { status: 404 })
        const { status, body } = handler(init)
        return new Response(status === 204 ? null : JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    })
}

const ok = (body: unknown) => () => ({ status: 200, body })
const unauthorized = () => ({ status: 401, body: { error: { message: 'Unauthorized', type: 'auth_error' } } })

const nest = (ip: string, running = true): DiscoveredNest => ({
  ip,
  port: 19080,
  running,
  url: `http://${ip}:19080`,
})

// ---------------------------------------------------------------------------

describe('ConnectionManager — discovery', () => {
  let credentials: FakeCredentialStore
  let state: FakeStateStore

  beforeEach(() => {
    credentials = new FakeCredentialStore()
    state = new FakeStateStore()
  })

  test('connects to the first running Nest found', async () => {
    const manager = new ConnectionManager({
      credentials,
      state,
      createClient: makeClientFactory({ '/auth/config': ok({ authRequired: false }) }),
      discover: async () => [nest('192.168.1.20')],
    })

    const result = await manager.connect()
    assert.equal(result.status, 'connected')
    assert.equal(state.last, 'http://192.168.1.20:19080', 'should remember the server')
  })

  test('reports an empty scan as a fixable situation, not a crash', async () => {
    const manager = new ConnectionManager({
      credentials,
      state,
      createClient: makeClientFactory({}),
      discover: async () => [],
    })

    const result = await manager.connect()
    assert.equal(result.status, 'error')
    assert.match((result as { message: string }).message, /No Redstart Nest found/)
    assert.match((result as { message: string }).message, /serverUrl/, 'should point at the manual override')
  })

  test('distinguishes "found a Nest with no model loaded" from "found nothing"', async () => {
    // The beacon answers while the Nest is open but idle. Reporting that as
    // "not found" sends the user hunting for a network fault that isn't there.
    const manager = new ConnectionManager({
      credentials,
      state,
      createClient: makeClientFactory({}),
      discover: async () => [nest('192.168.1.20', false)],
    })

    const result = await manager.connect()
    assert.equal(result.status, 'error')
    assert.match((result as { message: string }).message, /no model is running/i)
  })

  test('skips discovery entirely when a URL is remembered', async () => {
    let scanned = false
    const manager = new ConnectionManager({
      credentials,
      state: new FakeStateStore('http://10.0.0.5:19080'),
      createClient: makeClientFactory({ '/auth/config': ok({ authRequired: false }) }),
      discover: async () => {
        scanned = true
        return []
      },
    })

    const result = await manager.connect()
    assert.equal(result.status, 'connected')
    assert.equal(scanned, false, 'a remembered server must not trigger a LAN sweep')
  })

  test('silent auto-connect does not scan when nothing is remembered', async () => {
    let scanned = false
    const manager = new ConnectionManager({
      credentials,
      state,
      createClient: makeClientFactory({}),
      discover: async () => {
        scanned = true
        return []
      },
    })

    const result = await manager.connect({ noDiscovery: true })
    assert.equal(result.status, 'disconnected')
    assert.equal(scanned, false)
  })
})

describe('ConnectionManager — auth', () => {
  let credentials: FakeCredentialStore
  let state: FakeStateStore
  const url = 'http://10.0.0.5:19080'

  beforeEach(() => {
    credentials = new FakeCredentialStore()
    state = new FakeStateStore(url)
  })

  test('a Nest with auth off connects with no credential at all', async () => {
    const seen: string[] = []
    const manager = new ConnectionManager({
      credentials,
      state,
      createClient: makeClientFactory({ '/auth/config': ok({ authRequired: false }) }, seen),
      discover: async () => [],
    })

    const result = await manager.connect()
    assert.deepEqual(result, { status: 'connected', url, authRequired: false, user: null })
    assert.ok(!seen.some((s) => s.includes('/auth/me')), 'no identity call when auth is disabled')
  })

  test('asks for sign-in when auth is on and nothing is stored', async () => {
    const manager = new ConnectionManager({
      credentials,
      state,
      createClient: makeClientFactory({ '/auth/config': ok({ authRequired: true }) }),
      discover: async () => [],
    })

    const result = await manager.connect()
    assert.deepEqual(result, { status: 'unauthenticated', url, reason: 'no-credential' })
  })

  test('reuses a stored credential and resolves identity', async () => {
    await credentials.set(url, { kind: 'session', token: 't0k', username: 'ada' })
    const manager = new ConnectionManager({
      credentials,
      state,
      createClient: makeClientFactory({
        '/auth/config': ok({ authRequired: true }),
        '/auth/me': ok({ authRequired: true, user: USER }),
      }),
      discover: async () => [],
    })

    const result = await manager.connect()
    assert.equal(result.status, 'connected')
    assert.equal((result as { user: { username: string } }).user.username, 'ada')
  })

  test('sends the credential as a bearer token', async () => {
    await credentials.set(url, { kind: 'apiKey', key: 'rst_secret' })
    let authHeader: string | null = null
    const manager = new ConnectionManager({
      credentials,
      state,
      createClient: (baseUrl) =>
        new NestClient(baseUrl, {
          fetch: async (input, init) => {
            const path = input.replace(baseUrl, '')
            if (path === '/auth/config') {
              return new Response(JSON.stringify({ authRequired: true }), { status: 200 })
            }
            authHeader = new Headers(init?.headers).get('Authorization')
            return new Response(JSON.stringify({ authRequired: true, user: USER }), { status: 200 })
          },
        }),
      discover: async () => [],
    })

    await manager.connect()
    assert.equal(authHeader, 'Bearer rst_secret')
  })

  test('an expired session token reads as "sign in again", not "wrong password"', async () => {
    // Nest keeps sessions in memory only: restarting it to load a different
    // model invalidates every token. This is the single most common 401 and it
    // must not look like a credential problem.
    await credentials.set(url, { kind: 'session', token: 'stale', username: 'ada' })
    const manager = new ConnectionManager({
      credentials,
      state,
      createClient: makeClientFactory({
        '/auth/config': ok({ authRequired: true }),
        '/auth/me': unauthorized,
      }),
      discover: async () => [],
    })

    const result = await manager.connect()
    assert.deepEqual(result, { status: 'unauthenticated', url, reason: 'session-expired' })
    assert.equal(await credentials.get(url), null, 'a dead token must be discarded, never retried')
  })

  test('a rejected API key is reported differently from an expired session', async () => {
    // Re-prompting for the same API key would just loop; the user has to go get
    // a new one. The reason code is what lets the UI say so.
    await credentials.set(url, { kind: 'apiKey', key: 'rst_revoked' })
    const manager = new ConnectionManager({
      credentials,
      state,
      createClient: makeClientFactory({
        '/auth/config': ok({ authRequired: true }),
        '/auth/me': unauthorized,
      }),
      discover: async () => [],
    })

    const result = await manager.connect()
    assert.deepEqual(result, { status: 'unauthenticated', url, reason: 'key-rejected' })
    assert.equal(await credentials.get(url), null)
  })

  test('a non-401 failure is an error state, and keeps the credential', async () => {
    await credentials.set(url, { kind: 'session', token: 't0k', username: 'ada' })
    const manager = new ConnectionManager({
      credentials,
      state,
      createClient: makeClientFactory({
        '/auth/config': ok({ authRequired: true }),
        '/auth/me': () => ({ status: 500, body: { error: { message: 'boom' } } }),
      }),
      discover: async () => [],
    })

    const result = await manager.connect()
    assert.equal(result.status, 'error')
    assert.notEqual(await credentials.get(url), null, 'a server fault must not destroy a good credential')
  })

  test('an unreachable server is an error, not a sign-in prompt', async () => {
    const manager = new ConnectionManager({
      credentials,
      state,
      createClient: (baseUrl) =>
        new NestClient(baseUrl, {
          fetch: async () => {
            throw new Error('ECONNREFUSED')
          },
        }),
      discover: async () => [],
    })

    const result = await manager.connect()
    assert.equal(result.status, 'error')
    assert.match((result as { message: string }).message, /Could not reach/)
  })
})

describe('ConnectionManager — sign-in', () => {
  const url = 'http://10.0.0.5:19080'
  let credentials: FakeCredentialStore
  let state: FakeStateStore

  beforeEach(() => {
    credentials = new FakeCredentialStore()
    state = new FakeStateStore(url)
  })

  async function atSignInPrompt(routes: Routes) {
    const manager = new ConnectionManager({
      credentials,
      state,
      createClient: makeClientFactory({ '/auth/config': ok({ authRequired: true }), ...routes }),
      discover: async () => [],
    })
    await manager.connect()
    assert.equal(manager.state.status, 'unauthenticated')
    return manager
  }

  test('a password login stores the session token and its username', async () => {
    const manager = await atSignInPrompt({
      '/auth/login': ok({ token: 'fresh-token', user: USER }),
    })

    const result = await manager.signInWithPassword('ada', 'hunter2')
    assert.equal(result.status, 'connected')
    assert.deepEqual(await credentials.get(url), {
      kind: 'session',
      token: 'fresh-token',
      username: 'ada',
    })
  })

  test('bad credentials return to the prompt without claiming which field was wrong', async () => {
    // Nest returns the same 401 message for an unknown user as for a wrong
    // password, on purpose (no username enumeration). Don't invent a
    // distinction the server deliberately withholds.
    const manager = await atSignInPrompt({ '/auth/login': unauthorized })

    const result = await manager.signInWithPassword('ada', 'wrong')
    assert.deepEqual(result, { status: 'unauthenticated', url, reason: 'rejected' })
    assert.equal(await credentials.get(url), null)
  })

  test('an API key is verified before it is stored', async () => {
    const manager = await atSignInPrompt({ '/auth/me': unauthorized })

    const result = await manager.signInWithApiKey('rst_bogus')
    assert.equal(result.status, 'unauthenticated')
    assert.equal(await credentials.get(url), null, 'an unverified key must never be persisted')
  })

  test('a working API key is stored and connects', async () => {
    const manager = await atSignInPrompt({ '/auth/me': ok({ authRequired: true, user: USER }) })

    const result = await manager.signInWithApiKey('  rst_good  ')
    assert.equal(result.status, 'connected')
    assert.deepEqual(await credentials.get(url), { kind: 'apiKey', key: 'rst_good' })
  })

  test('signing out forgets the credential but keeps the server', async () => {
    await credentials.set(url, { kind: 'session', token: 't0k', username: 'ada' })
    const manager = new ConnectionManager({
      credentials,
      state,
      createClient: makeClientFactory({
        '/auth/config': ok({ authRequired: true }),
        '/auth/me': ok({ authRequired: true, user: USER }),
        '/auth/logout': () => ({ status: 204, body: null }),
      }),
      discover: async () => [],
    })
    await manager.connect()

    const result = await manager.signOut()
    assert.deepEqual(result, { status: 'unauthenticated', url, reason: 'no-credential' })
    assert.equal(await credentials.get(url), null)
    assert.equal(state.last, url, 'the server should still be remembered after sign-out')
  })

  test('disconnecting forgets the server so the next window does not reconnect', async () => {
    const manager = new ConnectionManager({
      credentials,
      state,
      createClient: makeClientFactory({ '/auth/config': ok({ authRequired: false }) }),
      discover: async () => [],
    })
    await manager.connect()

    await manager.disconnect()
    assert.deepEqual(manager.state, { status: 'disconnected' })
    assert.equal(state.last, undefined)
    assert.equal(manager.activeClient, null)
  })
})

describe('ConnectionManager — late 401s', () => {
  const url = 'http://10.0.0.5:19080'

  test('a 401 on a later request drops to the sign-in prompt', async () => {
    // Mid-session the Nest restarts. The next completion 401s. We must land at
    // a prompt with the right reason rather than silently retrying forever.
    const credentials = new FakeCredentialStore()
    await credentials.set(url, { kind: 'session', token: 't0k', username: 'ada' })
    const manager = new ConnectionManager({
      credentials,
      state: new FakeStateStore(url),
      createClient: makeClientFactory({
        '/auth/config': ok({ authRequired: true }),
        '/auth/me': ok({ authRequired: true, user: USER }),
      }),
      discover: async () => [],
    })
    await manager.connect()
    assert.equal(manager.state.status, 'connected')

    await manager.handleUnauthorized()
    assert.deepEqual(manager.state, { status: 'unauthenticated', url, reason: 'session-expired' })
    assert.equal(await credentials.get(url), null)
    assert.equal(manager.activeClient, null, 'a stale client must not be handed out')
  })
})

describe('ConnectionManager — observers', () => {
  test('emits every state transition in order', async () => {
    const seen: ConnectionState['status'][] = []
    const manager = new ConnectionManager({
      credentials: new FakeCredentialStore(),
      state: new FakeStateStore(),
      createClient: makeClientFactory({ '/auth/config': ok({ authRequired: true }) }),
      discover: async () => [{ ip: '10.0.0.5', port: 19080, running: true, url: 'http://10.0.0.5:19080' }],
    })
    manager.onDidChangeState((s) => seen.push(s.status))

    await manager.connect()
    assert.deepEqual(seen, ['discovering', 'connecting', 'unauthenticated'])
  })

  test('a disposed listener stops receiving updates', async () => {
    let count = 0
    const manager = new ConnectionManager({
      credentials: new FakeCredentialStore(),
      state: new FakeStateStore(),
      createClient: makeClientFactory({}),
      discover: async () => [],
    })
    const sub = manager.onDidChangeState(() => count++)
    await manager.connect()
    const afterFirst = count
    sub.dispose()
    await manager.connect()
    assert.equal(count, afterFirst)
  })
})

describe('NestHttpError', () => {
  test('classifies the two statuses the UI branches on', () => {
    assert.equal(new NestHttpError(401, 'x').isUnauthorized, true)
    assert.equal(new NestHttpError(502, 'x').isNoModel, true)
    assert.equal(new NestHttpError(500, 'x').isUnauthorized, false)
  })
})
