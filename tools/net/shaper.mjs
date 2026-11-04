import net from 'node:net'

/* A bad network between the browser and the app (experiment 4): a TCP proxy
   that delays every chunk (latency plus jitter, order kept), stalls now and
   then the way a lost packet does while TCP retransmits, and resets some
   connections at a random time, as a mobile handover or a NAT timeout does.
   A reset hits whatever the connection carries: an SSE stream (Datastar
   reconnects) or an event post (Datastar retries it).

   usage: node tools/net/shaper.mjs [listen=3500] [target=3000]
     LATENCY=80 JITTER=40     one-way delay per chunk, ms
     STALL=0.02 STALL_MS=600  chance per chunk of a retransmission stall
     RESET=0.1                chance per connection of a reset, 2–20 s in
   Prints a line per reset and a summary every 10 s. */

const [listen = 3500, target = 3000] = process.argv.slice(2).map(Number)
const env = (name, fallback) => Number(process.env[name] ?? fallback)
const LATENCY = env('LATENCY', 80)
const JITTER = env('JITTER', 40)
const STALL = env('STALL', 0.02)
const STALL_MS = env('STALL_MS', 600)
const RESET = env('RESET', 0.1)

const stats = { connections: 0, resets: 0, stalls: 0, chunks: 0 }

/** Copies `from` to `to`, each chunk released after a delay, strictly in
 *  order: one queue and one timer per direction (timers with different
 *  delays may fire out of order, which would reorder the byte stream). */
const shape = (from, to) => {
  const queue = []
  let timer
  let ended = false
  const release = () => {
    timer = undefined
    while (queue.length > 0 && queue[0].at <= Date.now()) {
      const { chunk } = queue.shift()
      if (!to.destroyed) to.write(chunk)
    }
    if (queue.length > 0) timer = setTimeout(release, queue[0].at - Date.now())
    else if (ended && !to.destroyed) to.end()
  }
  from.on('data', chunk => {
    stats.chunks += 1
    const stall = Math.random() < STALL ? (stats.stalls += 1, STALL_MS) : 0
    const previous = queue.at(-1)?.at ?? 0
    queue.push({ chunk, at: Math.max(previous, Date.now() + LATENCY + Math.random() * JITTER) + stall })
    timer ??= setTimeout(release, queue[0].at - Date.now())
  })
  from.on('end', () => {
    ended = true
    timer ??= setTimeout(release, 0)
  })
}

net
  .createServer(client => {
    stats.connections += 1
    const upstream = net.connect(target, '127.0.0.1')
    shape(client, upstream)
    shape(upstream, client)
    const close = () => {
      client.destroy()
      upstream.destroy()
    }
    client.on('error', close)
    upstream.on('error', close)
    client.on('close', close)
    upstream.on('close', close)
    if (Math.random() < RESET) {
      setTimeout(() => {
        if (client.destroyed) return
        stats.resets += 1
        client.resetAndDestroy()
        upstream.destroy()
      }, 2000 + Math.random() * 18_000).unref()
    }
  })
  .listen(listen, () =>
    console.log(`shaper :${listen} → :${target}, latency ${LATENCY}±${JITTER} ms, stall ${STALL} × ${STALL_MS} ms, reset ${RESET}`),
  )

setInterval(() => console.log(JSON.stringify(stats)), 10_000).unref()
