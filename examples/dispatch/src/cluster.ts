import cluster, { type Worker } from 'node:cluster'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'

import { startHub } from '@/app/dispatch/cluster-store'

import { type Upstream, startRouter } from './cluster/router'

/* Dispatch on every core: a primary process that runs the router and the
   shared store, and one worker per core, each a complete Dispatch server
   (src/main.ts) named by `HYPER_NODE`. A worker that dies is replaced by a
   new one with a new name; the sessions it held move to survivors, which
   restore them from the shared snapshot store.

   WORKERS=<n> sets the number of workers (default: one per core).
   PORT is the router's port; workers listen on the ports after it. */

const port = Number(process.env['PORT'] ?? 3000)
const count = Number(process.env['WORKERS'] ?? availableParallelism())

cluster.setupPrimary({
  exec: fileURLToPath(new URL('./main.ts', import.meta.url)),
  serialization: 'advanced',
})

type Slot = { worker: Worker; node: string; port: number; listening: boolean }
const slots: Array<Slot> = []
let stopping = false
let generation = 0

const hub = await startHub(() => slots.map(slot => slot.worker))

const spawn = (index: number) => {
  generation += 1
  const node = `w${index}g${generation}`
  const workerPort = port + 1 + index
  const worker = cluster.fork({
    HYPER_NODE: node,
    PORT: String(workerPort),
    DISPATCH_CLUSTER: '1',
  })
  const slot: Slot = { worker, node, port: workerPort, listening: false }
  slots[index] = slot
  hub.attach(worker)
  worker.on('listening', () => {
    slot.listening = true
  })
  worker.on('exit', () => {
    slot.listening = false
    if (!stopping) setTimeout(() => spawn(index), 1000)
  })
}

for (let index = 0; index < count; index += 1) spawn(index)

const upstreams = (): ReadonlyArray<Upstream> =>
  slots.map(slot => ({
    node: slot.node,
    port: slot.port,
    pid: slot.worker.process.pid,
    isAlive: () => slot.listening && slot.worker.isConnected(),
  }))

const router = startRouter({ port, upstreams })
console.log(`dispatch: router on :${port}, ${count} workers`)

const stop = () => {
  stopping = true
  router.close()
  for (const slot of slots) slot.worker.kill()
  void hub.dispose()
  setTimeout(() => process.exit(0), 500).unref()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
