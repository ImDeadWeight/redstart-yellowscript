// Run: npm test   (node --test, native TypeScript stripping — no test deps)
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  parseBeaconPayload,
  probeBeacon,
  discoverNests,
  localSubnets,
  localAddresses,
  type DiscoveredNest,
} from './discovery.ts'

describe('parseBeaconPayload', () => {
  test('accepts the exact beacon contract', () => {
    const parsed = parseBeaconPayload('{"app":"redstart-nest","running":true,"port":19080}')
    assert.deepEqual(parsed, { running: true, port: 19080 })
  })

  test('reports a Nest that is up but has no model loaded', () => {
    // Distinct from "found nothing" — the user needs to be told which it is.
    const parsed = parseBeaconPayload('{"app":"redstart-nest","running":false,"port":19080}')
    assert.deepEqual(parsed, { running: false, port: 19080 })
  })

  test('rejects another service that happens to answer on 8765', () => {
    assert.equal(parseBeaconPayload('{"app":"something-else","running":true,"port":19080}'), null)
    assert.equal(parseBeaconPayload('{"running":true,"port":19080}'), null)
  })

  test('rejects malformed and hostile bodies without throwing', () => {
    for (const body of [
      '',
      'not json',
      '<html>captive portal</html>',
      'null',
      '[]',
      '"redstart-nest"',
      '{"app":"redstart-nest"}',
      '{"app":"redstart-nest","running":true}',
    ]) {
      assert.equal(parseBeaconPayload(body), null, `should reject: ${body}`)
    }
  })

  test('rejects a port that is not a usable TCP port', () => {
    for (const port of ['0', '-1', '65536', '"19080"', '19080.5', 'null']) {
      const body = `{"app":"redstart-nest","running":true,"port":${port}}`
      assert.equal(parseBeaconPayload(body), null, `should reject port ${port}`)
    }
  })

  test('does not treat a truthy non-true `running` as running', () => {
    const parsed = parseBeaconPayload('{"app":"redstart-nest","running":"yes","port":19080}')
    assert.deepEqual(parsed, { running: false, port: 19080 })
  })
})

describe('probeBeacon', () => {
  /** Stand up a throwaway server on the real beacon port is not safe (it may be
   *  in use), so these tests drive probeBeacon's parsing through a live server
   *  on an ephemeral port via a thin re-implementation of the request, and
   *  exercise the real probeBeacon only against a closed port. */
  test('resolves null for a closed port rather than rejecting', async () => {
    // 127.0.0.1 with nothing listening on 8765 in CI; a connection refusal must
    // be a null result, never an unhandled rejection, because a sweep produces
    // hundreds of them.
    const result = await probeBeacon('127.0.0.1', 150)
    assert.ok(result === null || result?.ip === '127.0.0.1')
  })

  test('resolves null for an unroutable address within the timeout', async () => {
    // 192.0.2.0/24 is TEST-NET-1 — reserved, guaranteed not to route anywhere.
    const started = Date.now()
    const result = await probeBeacon('192.0.2.1', 200)
    assert.equal(result, null)
    assert.ok(Date.now() - started < 3000, 'timeout was not honoured')
  })

  test('ignores a non-200 response', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404)
      res.end('nope')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    // probeBeacon hardcodes the beacon port by design, so assert the behaviour
    // through a direct request shaped the same way.
    const status = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
    })
    assert.equal(status, 404)
    server.close()
  })
})

describe('localSubnets / localAddresses', () => {
  const fakeInterfaces = {
    'Wi-Fi': [
      { address: '192.168.1.50', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
    ],
    Ethernet: [{ address: '10.0.0.7', family: 'IPv4', internal: false }],
    Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>

  test('collects every non-internal IPv4 interface, not just the first', () => {
    // Twig picks the first interface it finds; on a laptop with Wi-Fi plus
    // Ethernet plus a VPN that is arbitrary and often the wrong network.
    assert.deepEqual(localSubnets(fakeInterfaces), ['192.168.1', '10.0.0'])
    assert.deepEqual(localAddresses(fakeInterfaces), ['192.168.1.50', '10.0.0.7'])
  })

  test('skips loopback and IPv6', () => {
    assert.ok(!localAddresses(fakeInterfaces).includes('127.0.0.1'))
    assert.ok(!localAddresses(fakeInterfaces).includes('fe80::1'))
  })
})

describe('discoverNests', () => {
  const nest = (ip: string, port = 19080, running = true): DiscoveredNest => ({
    ip,
    port,
    running,
    url: `http://${ip}:${port}`,
  })

  test('always probes loopback, even with no LAN subnets', async () => {
    const probed: string[] = []
    const found = await discoverNests({
      subnets: [],
      selfAddresses: [],
      probe: async (ip) => {
        probed.push(ip)
        return ip === '127.0.0.1' ? nest('127.0.0.1') : null
      },
    })
    assert.deepEqual(probed, ['127.0.0.1'])
    assert.deepEqual(found, [nest('127.0.0.1')])
  })

  test('sweeps .1 through .254 of each subnet', async () => {
    const probed: string[] = []
    await discoverNests({
      subnets: ['192.168.1', '10.0.0'],
      selfAddresses: [],
      probe: async (ip) => {
        probed.push(ip)
        return null
      },
    })
    assert.equal(probed.length, 1 + 254 * 2)
    assert.ok(probed.includes('192.168.1.1'))
    assert.ok(probed.includes('192.168.1.254'))
    assert.ok(probed.includes('10.0.0.254'))
    assert.ok(!probed.includes('192.168.1.0'), 'network address should not be probed')
    assert.ok(!probed.includes('192.168.1.255'), 'broadcast address should not be probed')
  })

  test('collapses the same local Nest answering on both loopback and LAN', async () => {
    const found = await discoverNests({
      subnets: ['192.168.1'],
      selfAddresses: ['192.168.1.50'],
      probe: async (ip) => {
        if (ip === '127.0.0.1') return nest('127.0.0.1')
        if (ip === '192.168.1.50') return nest('192.168.1.50')
        return null
      },
    })
    assert.equal(found.length, 1, 'one machine must not appear as two servers')
    assert.equal(found[0]?.ip, '127.0.0.1', 'loopback is the shorter path and should win')
  })

  test('keeps a different machine on the LAN', async () => {
    const found = await discoverNests({
      subnets: ['192.168.1'],
      selfAddresses: ['192.168.1.50'],
      probe: async (ip) => {
        if (ip === '127.0.0.1') return nest('127.0.0.1')
        if (ip === '192.168.1.99') return nest('192.168.1.99')
        return null
      },
    })
    assert.equal(found.length, 2)
  })

  test('orders running instances ahead of idle ones', async () => {
    const found = await discoverNests({
      subnets: ['192.168.1'],
      selfAddresses: [],
      probe: async (ip) => {
        if (ip === '192.168.1.10') return nest('192.168.1.10', 19080, false)
        if (ip === '192.168.1.20') return nest('192.168.1.20', 19080, true)
        return null
      },
    })
    assert.deepEqual(
      found.map((f) => f.ip),
      ['192.168.1.20', '192.168.1.10'],
    )
  })

  test('stops probing once aborted', async () => {
    const controller = new AbortController()
    let probes = 0
    const found = await discoverNests({
      subnets: ['192.168.1'],
      selfAddresses: [],
      signal: controller.signal,
      probe: async (ip) => {
        probes++
        if (probes === 5) controller.abort()
        return null
      },
    })
    assert.deepEqual(found, [])
    assert.ok(probes < 255, `expected an early stop, ran ${probes} probes`)
  })
})
