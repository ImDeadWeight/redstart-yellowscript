// =============================================================================
// Beacon discovery — find a Redstart Nest on the local network.
// =============================================================================
// Every Nest runs a tiny HTTP beacon on a fixed port that answers exactly:
//
//     { "app": "redstart-nest", "running": true, "port": 19080 }
//
// Three fields, nothing else (the payload is deliberately minimal so it leaks
// no configuration). `app` is the positive-identification marker; `port` is the
// gateway port to connect to on the responding IP. We build the connection URL
// from the IP that answered plus that port — never from a server-supplied URL.
//
// Contract source: redstart-nest/electron/main/beacon.mjs, pinned by
// scripts/test-discovery-robustness.mjs and the chat-ui security suite.
//
// This module imports no `vscode` API so it can be unit-tested under
// `node --test` directly.
// =============================================================================

import * as http from 'node:http'
import * as os from 'node:os'

/** Fixed by protocol. Not configurable — zero-config discovery is the point. */
export const BEACON_PORT = 8765

/**
 * A beacon response is three short fields. Anything larger is not a Nest, so
 * stop reading rather than buffering whatever an unknown service on this port
 * decides to send us. We are probing arbitrary hosts on an untrusted LAN.
 */
const MAX_BEACON_BODY_BYTES = 4096

/** Sockets in flight during a sweep. 254 at once is enough to exhaust an OS
 *  handle table on some machines and gets probes dropped on cheap APs. */
const SCAN_CONCURRENCY = 32

/** More than this many local subnets and we are almost certainly looking at
 *  virtual adapters (Docker, WSL, VPN, Hyper-V) rather than the real LAN. */
const MAX_SUBNETS = 4

export interface DiscoveredNest {
  /** The IP that answered the beacon. */
  ip: string
  /** Gateway port reported by the beacon — NOT the beacon port. */
  port: number
  /** True when a model is loaded and the gateway is actually serving. */
  running: boolean
  /** Connection URL, built locally from `ip` + `port`. */
  url: string
}

/**
 * Validate a beacon body. Returns null for anything that isn't a Redstart Nest
 * — a stray service on 8765, a captive-portal login page, truncated JSON.
 *
 * Note this accepts `running: false` and reports it. A Nest that is open but
 * has no model loaded is a genuinely different situation from "nothing found",
 * and telling the user which one they are in is worth the extra field.
 */
export function parseBeaconPayload(raw: string): { running: boolean; port: number } | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null

  const obj = data as Record<string, unknown>
  if (obj.app !== 'redstart-nest') return null

  const port = obj.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null

  return { running: obj.running === true, port }
}

/**
 * Probe one host. Never rejects — an unreachable IP is the overwhelmingly
 * common case during a sweep, not an error worth propagating.
 */
export function probeBeacon(ip: string, timeoutMs: number): Promise<DiscoveredNest | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (result: DiscoveredNest | null) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const req = http.get({ host: ip, port: BEACON_PORT, path: '/', timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.destroy()
        done(null)
        return
      }

      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
        if (body.length > MAX_BEACON_BODY_BYTES) {
          res.destroy()
          done(null)
        }
      })
      res.on('end', () => {
        const parsed = parseBeaconPayload(body)
        done(parsed ? { ip, port: parsed.port, running: parsed.running, url: `http://${ip}:${parsed.port}` } : null)
      })
      res.on('error', () => done(null))
    })

    req.on('error', () => done(null))
    req.on('timeout', () => {
      req.destroy()
      done(null)
    })
  })
}

/**
 * The /24 subnets worth sweeping, derived from this machine's own IPv4
 * addresses.
 *
 * Twig's scan takes the first non-internal interface it finds. That misfires on
 * a laptop with Wi-Fi + Ethernet + a VPN adapter, where "first" is arbitrary and
 * frequently the wrong network. We collect every candidate instead and sweep
 * them all, capped so a Docker/WSL-heavy machine doesn't turn discovery into a
 * thousand-host scan.
 *
 * Only the /24 containing our own address is scanned even when the netmask is
 * wider — sweeping a /16 host by host is not a reasonable thing to do to a
 * network.
 */
export function localSubnets(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const subnets: string[] = []
  for (const address of localAddresses(interfaces)) {
    const parts = address.split('.')
    const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`
    if (!subnets.includes(subnet)) subnets.push(subnet)
  }
  return subnets.slice(0, MAX_SUBNETS)
}

/** This machine's own non-internal IPv4 addresses. */
export function localAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  const addresses: string[] = []
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      // Node <18 reported `family` as a string, newer as the number 4. Accept both.
      const isIPv4 = info.family === 'IPv4' || (info.family as unknown as number) === 4
      if (!isIPv4 || info.internal) continue
      if (info.address.split('.').length !== 4) continue
      if (!addresses.includes(info.address)) addresses.push(info.address)
    }
  }
  return addresses
}

/** Run `task` over `items` with a bounded number in flight. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await task(items[index] as T)
    }
  })

  await Promise.all(workers)
  return results
}

export interface DiscoverOptions {
  timeoutMs?: number
  /** Override the subnets to sweep. Defaults to this machine's own. */
  subnets?: string[]
  /** This machine's own IPs, used to collapse the loopback/LAN duplicate. */
  selfAddresses?: string[]
  /** Injected for tests. */
  probe?: (ip: string, timeoutMs: number) => Promise<DiscoveredNest | null>
  signal?: AbortSignal
}

/**
 * Sweep the local network for Redstart Nest instances.
 *
 * Loopback is probed first and always: when Nest and VSCode are on the same
 * machine, Nest may be bound to localhost only, in which case it appears
 * nowhere in the LAN sweep. Results are ordered running-first, then by the
 * order they were found, so the caller can take the head of the list.
 */
export async function discoverNests(options: DiscoverOptions = {}): Promise<DiscoveredNest[]> {
  const timeoutMs = options.timeoutMs ?? 400
  const probe = options.probe ?? probeBeacon
  const subnets = options.subnets ?? localSubnets()
  const selfAddresses = new Set(options.selfAddresses ?? localAddresses())

  const targets = ['127.0.0.1']
  for (const subnet of subnets) {
    for (let host = 1; host <= 254; host++) {
      const ip = `${subnet}.${host}`
      if (!targets.includes(ip)) targets.push(ip)
    }
  }

  const found = await mapWithConcurrency(targets, SCAN_CONCURRENCY, async (ip) => {
    if (options.signal?.aborted) return null
    return probe(ip, timeoutMs)
  })

  const hits = found.filter((entry): entry is DiscoveredNest => entry !== null)

  // A Nest on this machine answers twice — once on 127.0.0.1 and once on its
  // own LAN address — and they are the same server, not two choices to show the
  // user. Loopback was probed first and wins: it is the shorter path and it
  // keeps working when the machine changes networks.
  const loopbackPorts = new Set(hits.filter((h) => h.ip === '127.0.0.1').map((h) => h.port))
  const deduped = hits.filter((hit) => {
    if (hit.ip === '127.0.0.1') return true
    return !(selfAddresses.has(hit.ip) && loopbackPorts.has(hit.port))
  })

  return deduped.sort((a, b) => Number(b.running) - Number(a.running))
}
