import http from 'node:http'

import { nodeOfPath } from '@hyper-effect/core'

/* A router in front of several hyper-effect processes on one machine.
   - A session's stream and events go to the process whose node its id names
     (`Options.node`). If that process is gone, its sessions go to one heir, a
     survivor chosen once and kept while it lives (the heir of a dead heir
     takes over both): a session must never move again just because a
     replacement worker started, or two processes would hold it.
   - A session request whose process fails before answering gets its
     connection reset, not a 502: Datastar retries a failed request (after
     1 s, doubling), but takes an error status as final. An event is answered
     only once it is durable (`durableEvents`), so a retry loses nothing and
     applies nothing twice.
   - Everything else (page loads, assets, sign-in) is spread round-robin.
   - `GET /_hyper/metrics` sums every process's metrics, the router's own CPU
     and memory included, so load tests see the whole machine. */

export type Upstream = Readonly<{ node: string; port: number; pid: number | undefined; isAlive: () => boolean }>

const hash = (text: string): number => {
  let value = 0
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0
  return value
}

type Metrics = Readonly<Record<string, unknown>> & {
  renders: number
  renderMeanMillis: number
  renderP50Millis: number
  renderP95Millis: number
  renderMaxMillis: number
  programs: Readonly<Record<string, Readonly<{ sessions: number; connections: number }>>>
  eventLoopLagMillis: number
  eventLoopUtilization: number
}

const SUMMED = [
  'renders',
  'patches',
  'patchBytes',
  'wireBytes',
  'regionPatches',
  'regionRenders',
  'regionUnchanged',
  'regionKept',
  'heapUsedBytes',
  'rssBytes',
  'cpuUserMicros',
  'cpuSystemMicros',
] as const

const combine = (all: ReadonlyArray<Metrics>): Record<string, unknown> => {
  const total: Record<string, unknown> = {}
  for (const key of SUMMED) total[key] = all.reduce((sum, metrics) => sum + Number(metrics[key] ?? 0), 0)
  const renders = Number(total['renders'])
  total['renderMeanMillis'] =
    renders === 0 ? 0 : all.reduce((sum, metrics) => sum + metrics.renderMeanMillis * metrics.renders, 0) / renders
  for (const key of ['renderP50Millis', 'renderP95Millis', 'renderMaxMillis', 'eventLoopLagMillis'] as const) {
    total[key] = Math.max(0, ...all.map(metrics => metrics[key]))
  }
  total['eventLoopUtilization'] = all.reduce((sum, metrics) => sum + metrics.eventLoopUtilization, 0) / Math.max(1, all.length)
  const programs: Record<string, { sessions: number; connections: number }> = {}
  for (const metrics of all) {
    for (const [name, counts] of Object.entries(metrics.programs)) {
      const entry = (programs[name] ??= { sessions: 0, connections: 0 })
      entry.sessions += counts.sessions
      entry.connections += counts.connections
    }
  }
  total['programs'] = programs
  total['processes'] = all.length
  return total
}

export const startRouter = (config: Readonly<{ port: number; upstreams: () => ReadonlyArray<Upstream> }>) => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity })
  let turn = 0

  const live = () => config.upstreams().filter(upstream => upstream.isAlive())
  /** Dead node → the node that took over its sessions. */
  const heirs = new Map<string, string>()

  /** The live process holding a node's sessions. */
  const holder = (node: string, upstreams: ReadonlyArray<Upstream>): Upstream | undefined => {
    for (let current = node, hops = 0; hops <= heirs.size; hops += 1) {
      const alive = upstreams.find(upstream => upstream.node === current)
      if (alive !== undefined) return alive
      const heir = heirs.get(current)
      if (heir === undefined) {
        const chosen = upstreams[hash(current) % upstreams.length]
        if (chosen !== undefined) heirs.set(current, chosen.node)
        return chosen
      }
      current = heir
    }
    return undefined
  }

  const pick = (path: string): Upstream | undefined => {
    const upstreams = live()
    if (upstreams.length === 0) return undefined
    const node = nodeOfPath(path)
    if (node !== undefined) return holder(node, upstreams)
    turn += 1
    return upstreams[turn % upstreams.length]
  }

  const fetchAll = (path: string, method: string) =>
    Promise.all(
      live().map(upstream =>
        fetch(`http://127.0.0.1:${upstream.port}${path}`, { method }).then(response =>
          method === 'GET' ? (response.json() as Promise<Metrics>) : undefined,
        ),
      ),
    )

  const own = (): Metrics => {
    const cpu = process.cpuUsage()
    const memory = process.memoryUsage()
    return {
      renders: 0,
      renderMeanMillis: 0,
      renderP50Millis: 0,
      renderP95Millis: 0,
      renderMaxMillis: 0,
      programs: {},
      eventLoopLagMillis: 0,
      eventLoopUtilization: 0,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
    }
  }

  const server = http.createServer((request, response) => {
    const path = request.url ?? '/'
    if (path === '/_hyper/metrics' && request.method === 'GET') {
      fetchAll(path, 'GET')
        .then(all => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(combine([...(all as ReadonlyArray<Metrics>), own()])))
        })
        .catch(() => {
          response.writeHead(502)
          response.end()
        })
      return
    }
    // Which node listens where, for load tests that bypass the router.
    if (path === '/_hyper/cluster' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' })
      const inherited = (node: string) => [...heirs].filter(([, heir]) => heir === node).map(([dead]) => dead)
      response.end(
        JSON.stringify(live().map(({ node, port, pid }) => ({ node, port, pid, heirOf: inherited(node) }))),
      )
      return
    }
    if (path === '/_hyper/metrics/reset' && request.method === 'POST') {
      fetchAll(path, 'POST').finally(() => {
        response.writeHead(204)
        response.end()
      })
      return
    }
    const upstream = pick(path)
    if (upstream === undefined) {
      response.writeHead(503)
      response.end()
      return
    }
    const proxied = http.request(
      { host: '127.0.0.1', port: upstream.port, method: request.method, path, headers: request.headers, agent },
      upstreamResponse => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
      },
    )
    proxied.on('error', () => {
      if (!response.headersSent && nodeOfPath(path) === undefined) {
        response.writeHead(502)
        response.end()
      } else {
        // A session request: the page retries it, on the heir.
        response.destroy()
      }
    })
    // A page that goes away closes its stream upstream too.
    response.on('close', () => proxied.destroy())
    request.pipe(proxied)
  })
  server.listen(config.port)
  return server
}
