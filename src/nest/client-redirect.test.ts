// =============================================================================
// The Nest client never follows a redirect (2026-11-24).
// =============================================================================
// A Nest in LAN-HTTPS mode answers http://<ip>:80 with a 308 to its https
// name. Following it dropped the Authorization header (a cross-origin
// redirect), so every request came back 401 and read as a sign-out; and a 308
// keeps the body, so sign-in sent the password wherever port 80 pointed.
// =============================================================================

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'

import { NestClient } from './client.ts'
import { NestHttpError } from './types.ts'

describe('redirects from the Nest', () => {
  /** What reached the server a redirect points at. */
  const reached: Array<{ method: string; url: string; auth: string | undefined; body: string }> = []
  const target = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      reached.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"token":"stolen"}')
    })
  })
  // Port 80 in LAN-HTTPS mode: everything is a 308 somewhere else.
  const redirector = http.createServer((req, res) => {
    const { port } = target.address() as AddressInfo
    res.writeHead(308, { location: `http://localhost:${port}${req.url}` })
    res.end()
  })
  const listen = (s: http.Server) => new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()))
  const ready = Promise.all([listen(target), listen(redirector)])
  after(() => {
    target.close()
    redirector.close()
  })

  test('sign-in is not sent on to where the redirect points, and the error says where it leads', async () => {
    await ready
    const { port } = redirector.address() as AddressInfo
    const client = new NestClient(`http://127.0.0.1:${port}`)
    const err = await client.login('bench', 'hunter2').then(
      () => null,
      (e: unknown) => e,
    )
    assert.ok(err instanceof NestHttpError, String(err))
    assert.equal(err.status, 308)
    assert.match(err.message, /redirects to http:\/\/localhost:\d+\. Connect to http:\/\/localhost:\d+ instead/)
    assert.deepEqual(reached, [], 'nothing, the password least of all, reached the other server')
  })

  test('an authenticated request is a redirect error, not a 401 that reads as a sign-out', async () => {
    await ready
    const { port } = redirector.address() as AddressInfo
    const client = new NestClient(`http://127.0.0.1:${port}`)
    client.setCredential({ kind: 'session', token: 'abc', username: 'bench' })
    const err = await client.listProjects().then(
      () => null,
      (e: unknown) => e,
    )
    assert.ok(err instanceof NestHttpError)
    assert.notEqual(err.status, 401)
    assert.equal(err.status, 308)
    assert.deepEqual(reached, [])
  })
})
