// =============================================================================
// Live-Nest smoke test.
// =============================================================================
// Yellowscript lives in its own repo, so it does NOT run redstart-project's
// ~13-suite boundary test net. That suite is the written-down spec for every
// shape below, but nothing here fails when Nest's wire format drifts — this
// script is the only thing that would notice.
//
// Run it against a real Nest before every release:
//
//     YELLOWSCRIPT_TEST_LIVE_NEST=http://192.168.1.20:19080 node scripts/smoke.mjs
//     YELLOWSCRIPT_TEST_LIVE_NEST=... YELLOWSCRIPT_TEST_TOKEN=rst_... node scripts/smoke.mjs
//
// Without the env var it exits 0 and does nothing, so it is safe to wire into
// CI that has no Nest.
// =============================================================================

import { discoverNests, BEACON_PORT } from '../src/nest/discovery.ts'

const baseUrl = process.env.YELLOWSCRIPT_TEST_LIVE_NEST
const token = process.env.YELLOWSCRIPT_TEST_TOKEN

if (!baseUrl) {
  console.log('YELLOWSCRIPT_TEST_LIVE_NEST is not set — skipping the live smoke test.')
  process.exit(0)
}

const results = []

async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, detail: err.message })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const authHeaders = token ? { Authorization: `Bearer ${token}` } : {}

async function getJson(path, { authenticated = true } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: authenticated ? authHeaders : {},
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
  return res.json()
}

console.log(`\nsmoke-testing ${baseUrl}\n`)

await check('beacon answers with the identity contract', async () => {
  const host = new URL(baseUrl).hostname
  const res = await fetch(`http://${host}:${BEACON_PORT}/`, { signal: AbortSignal.timeout(2000) })
  const body = await res.json()
  assert(body.app === 'redstart-nest', `app marker was ${JSON.stringify(body.app)}`)
  assert(typeof body.running === 'boolean', 'running is not a boolean')
  assert(Number.isInteger(body.port), 'port is not an integer')
  assert(Object.keys(body).length === 3, `beacon leaked extra fields: ${Object.keys(body).join(', ')}`)
  return `port ${body.port}, running=${body.running}`
})

await check('discovery finds this Nest on the network', async () => {
  const found = await discoverNests({ timeoutMs: 800 })
  assert(found.length > 0, 'the LAN sweep found no Nest')
  return found.map((f) => f.url).join(', ')
})

await check('GET /auth/config is public and returns authRequired', async () => {
  const body = await getJson('/auth/config', { authenticated: false })
  assert(typeof body.authRequired === 'boolean', `authRequired was ${typeof body.authRequired}`)
  return `authRequired=${body.authRequired}`
})

await check('GET /auth/me returns an identity of the pinned shape', async () => {
  const body = await getJson('/auth/me')
  assert(typeof body.authRequired === 'boolean', 'authRequired missing')
  if (body.user === null) return 'auth disabled — user is null'
  for (const field of ['id', 'username', 'role', 'apiKeyPrefix', 'createdAt']) {
    assert(field in body.user, `user.${field} is missing`)
  }
  // The contract is that a secret never appears here. Assert it, don't assume.
  const leaked = Object.keys(body.user).filter((k) => /password|secret|apiKey$/i.test(k))
  assert(leaked.length === 0, `user object leaked: ${leaked.join(', ')}`)
  return `${body.user.username} (${body.user.role})`
})

await check('GET /redstart/mcp-servers returns servers + disabledTools', async () => {
  const body = await getJson('/redstart/mcp-servers')
  assert(Array.isArray(body.servers), 'servers is not an array')
  assert(Array.isArray(body.disabledTools), 'disabledTools is not an array')
  for (const server of body.servers) {
    assert(typeof server.name === 'string' && typeof server.url === 'string', 'malformed server entry')
  }
  return `${body.servers.length} server(s), ${body.disabledTools.length} banned tool(s)`
})

await check('GET /v1/models reaches llama-server', async () => {
  const body = await getJson('/v1/models')
  assert(Array.isArray(body.data), 'data is not an array')
  return body.data.map((m) => m.id).join(', ') || 'no models listed'
})

await check('an unauthenticated request is refused when auth is on', async () => {
  const config = await getJson('/auth/config', { authenticated: false })
  if (!config.authRequired) return 'skipped — auth is disabled on this Nest'
  const res = await fetch(`${baseUrl}/auth/me`, { signal: AbortSignal.timeout(5000) })
  assert(res.status === 401, `expected 401 without a token, got ${res.status}`)
  return '401 as expected'
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log('\nThe Nest wire contract has drifted from what Yellowscript expects:')
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
