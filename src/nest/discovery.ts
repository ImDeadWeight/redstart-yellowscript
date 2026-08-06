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
 *
 * USES `fetch`, NOT `node:http`, and that is not a style preference. VSCode
 * patches Node's http/https modules for proxy support (`http.proxySupport`
 * defaults to "override"); `fetch` is not patched the same way. With the
 * node:http implementation this sweep found nothing from inside the extension
 * host while finding the Nest instantly from plain Node on the same machine —
 * and `NestClient`, which has always used `fetch`, could reach that same host
 * throughout. Keeping both HTTP paths on `fetch` removes the discrepancy.
 *
 * `onError` receives a coarse reason per failure. Individually they are noise;
 * aggregated across a sweep they are the difference between "nothing is
 * listening" and "something is dropping our packets".
 */
export async function probeBeacon(
  ip: string,
  timeoutMs: number,
  onError?: (reason: string) => void,
): Promise<DiscoveredNest | null> {
  try {
    const response = await fetch(`http://${ip}:${BEACON_PORT}/`, {
      signal: AbortSignal.timeout(timeoutMs),
      // A beacon answers directly. A redirect means this is some other service.
      redirect: 'error',
    })

    if (!response.ok) {
      await response.body?.cancel()
      onError?.(`http-${response.status}`)
      return null
    }

    const body = await readCapped(response, MAX_BEACON_BODY_BYTES)
    const parsed = parseBeaconPayload(body)
    if (!parsed) {
      onError?.('not-a-beacon')
      return null
    }
    return { ip, port: parsed.port, running: parsed.running, url: `http://${ip}:${parsed.port}` }
  } catch (err) {
    onError?.(failureReason(err))
    return null
  }
}

/**
 * Read at most `limit` bytes of a response, then stop.
 *
 * We are probing arbitrary hosts on an untrusted LAN, so an unbounded read is
 * an invitation for whatever is listening on 8765 to stream at us forever.
 */
async function readCapped(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''

  const decoder = new TextDecoder()
  let body = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      body += decoder.decode(value, { stream: true })
      if (body.length > limit) return body.slice(0, limit)
    }
  } catch {
    // Truncated or reset mid-read: whatever arrived still gets parsed, and a
    // partial body simply fails validation.
  } finally {
    try {
      await reader.cancel()
    } catch {
      // ignored on purpose
    }
  }
  return body
}

/** A coarse, aggregatable reason. undici hides the real cause one level down. */
function failureReason(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout'
    const cause = (err as { cause?: unknown }).cause
    const code = (cause as { code?: unknown } | undefined)?.code
    if (typeof code === 'string') return code
    return err.name
  }
  return 'unknown'
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
  probe?: (
    ip: string,
    timeoutMs: number,
    onError?: (reason: string) => void,
  ) => Promise<DiscoveredNest | null>
  signal?: AbortSignal
  /** Called once per sweep with a count of each failure reason seen. A sweep
   *  that is all `timeout` is being silently dropped; one that is all
   *  `ECONNREFUSED` reached the hosts and found nothing listening. */
  onFailureSummary?: (reasons: Record<string, number>) => void
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

  const reasons: Record<string, number> = {}
  const noteFailure = (reason: string): void => {
    reasons[reason] = (reasons[reason] ?? 0) + 1
  }

  const found = await mapWithConcurrency(targets, SCAN_CONCURRENCY, async (ip) => {
    if (options.signal?.aborted) return null
    return probe(ip, timeoutMs, noteFailure)
  })

  options.onFailureSummary?.(reasons)

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
