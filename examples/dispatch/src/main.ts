import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { FileSystem, Layer, Path, Redacted } from 'effect'
import { HttpRouter, HttpServerResponse, HttpStaticServer } from 'effect/http'
import { KeyValueStore } from 'effect/persistence'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

import * as Auth from '@/app/dispatch/auth'
import * as ClusterStore from '@/app/dispatch/cluster-store'
import * as Board from '@/app/dispatch/board'
import * as Incident from '@/app/dispatch/incident'
import * as Levers from '@/app/dispatch/levers'
import * as Dispatch from '@/app/dispatch/store'
import * as Greeter from '@/app/greeter'
import * as Hyper from '@hyper-effect/core'

const port = Number(process.env['PORT'] ?? 3000)
const publicFile = (path: string) => fileURLToPath(new URL(`../public/${path}`, import.meta.url))

const experiments = process.env['HYPER_METRICS'] === '1'
// Set by src/cluster.ts when this process is one of several workers.
const node = process.env['HYPER_NODE']
const isWorker = process.env['DISPATCH_CLUSTER'] === '1'

const secured: Hyper.Options = {
  stylesheets: ['/styles.css'],
  ...(node === undefined ? {} : { node }),
  // Sealed snapshots: the session store sees neither Models nor visitors.
  snapshotSecret: Hyper.secretFromEnvironment('HYPER_SNAPSHOT_SECRET', 'hyper-dev-secret, set HYPER_SNAPSHOT_SECRET'),
  durableEvents: Levers.durableEvents,
  compression: Levers.compression,
  // Load tests open hundreds of pages from one address.
  ...(experiments ? { limits: { pagesPerSecond: 1_000, pageBurst: 10_000 } } : {}),
}

const page: Hyper.Options = {
  ...secured,
  // Pages with islands load the islands bundle; it registers the custom
  // elements and lazily loads MapLibre when a map mounts.
  scripts: ['/assets/islands.js'],
  // The map loads its style, tiles and glyphs from OpenFreeMap.
  contentSecurityPolicy: { directives: { 'connect-src': ['https://tiles.openfreemap.org'] } },
  // Dispatch pages need a signed-in dispatcher; signing out ends them.
  principal: Auth.principal,
}

const Routes = Layer.mergeAll(
  Hyper.layer(Board.program, { ...page, path: '/' }),
  Hyper.layer(Incident.program, { ...page, path: '/incidents/:id' }),
  Hyper.layer(Greeter.program, { ...secured, path: '/greeter' }),
  Auth.routes,
  HttpRouter.add(
    'GET',
    '/styles.css',
    HttpServerResponse.file(publicFile('styles.css'), { contentType: 'text/css' }),
  ),
  HttpStaticServer.layer({ root: publicFile('assets'), prefix: '/assets' }),
  // Load and memory figures for experiments; never on by default.
  experiments ? Hyper.metricsRoutes : Layer.empty,
)

// Session snapshots on disk: restart the server and open pages carry on.
// For measurements: in memory, or in Postgres (DATABASE_URL).
const Snapshots: Layer.Layer<KeyValueStore.KeyValueStore, unknown, FileSystem.FileSystem | Path.Path> =
  Levers.snapshots === 'memory'
    ? KeyValueStore.layerMemory
    : Levers.snapshots === 'postgres'
      ? Hyper.sqlStore().pipe(
          Layer.provide(PgClient.layer({ url: Redacted.make(process.env['DATABASE_URL'] ?? '') })),
        )
      : Hyper.fileStore(process.env['DISPATCH_SESSIONS_DIR'] ?? '.hyper-sessions')

HttpRouter.serve(Routes).pipe(
  Layer.provide([isWorker ? ClusterStore.workerLayer : Dispatch.layer, Snapshots]),
  Layer.provide(NodeServices.layer),
  Layer.provide(NodeHttpServer.layer(createServer, { port })),
  Layer.launch,
  NodeRuntime.runMain,
)
