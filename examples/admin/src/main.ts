import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { type FileSystem, Layer, type Path, Redacted } from 'effect'
import { type KeyValueStore } from 'effect/persistence'
import { HttpRouter, HttpServerResponse } from 'effect/http'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

import * as Hyper from '@hyper-effect/core'

import * as Auth from '@/app/auth'
import * as Images from '@/app/catalog/images'
import * as Postgres from '@/app/catalog/postgres'
import { Catalog } from '@/app/catalog/store'
import * as Edit from '@/app/products/edit'
import * as List from '@/app/products/list'

/* The catalog admin: one program per page, plain routes for sign-in, images
   and the stylesheet.

   With DATABASE_URL, products, images and session snapshots live in
   Postgres, so several processes can serve the admin (on any machines): a
   change on one reaches the pages on all, and a session continues on another
   process when its own fails. Without it, all three are in this process
   (snapshots on disk). HYPER_NODE names the process in session ids. */

const port = Number(process.env['PORT'] ?? 3200)
const publicFile = (path: string) => fileURLToPath(new URL(`../public/${path}`, import.meta.url))

// Metrics routes and raised limits, for load tests only.
const experiments = process.env['HYPER_METRICS'] === '1'

const page: Hyper.Options = {
  stylesheets: ['/styles.css'],
  principal: Auth.principal,
  snapshotSecret: Hyper.secretFromEnvironment('HYPER_SNAPSHOT_SECRET', 'hyper-dev-secret, set HYPER_SNAPSHOT_SECRET'),
  limits: {
    maxUploadBytes: 3 * 1024 * 1024,
    maxUploadFiles: 2,
    // Load tests open hundreds of pages from one address.
    ...(experiments ? { pagesPerSecond: 1_000, pageBurst: 10_000, eventsPerSecond: 1_000, eventBurst: 10_000 } : {}),
  },
  ...(process.env['HYPER_NODE'] === undefined ? {} : { node: process.env['HYPER_NODE'] }),
}

const databaseUrl = process.env['DATABASE_URL']
const Stores: Layer.Layer<
  Catalog | Images.Images | KeyValueStore.KeyValueStore,
  unknown,
  FileSystem.FileSystem | Path.Path
> =
  databaseUrl === undefined
    ? Layer.mergeAll(Catalog.layer, Images.Images.layer, Hyper.fileStore('.hyper-sessions'))
    : Layer.mergeAll(Postgres.layer, Hyper.sqlStore()).pipe(
        Layer.provide(PgClient.layer({ url: Redacted.make(databaseUrl) })),
      )

const Routes = Layer.mergeAll(
  experiments ? Hyper.metricsRoutes : Layer.empty,
  Hyper.layer(List.program, { ...page, path: '/products' }),
  Hyper.layer(Edit.program, { ...page, path: '/products/:id' }),
  Auth.routes,
  Images.routes,
  HttpRouter.add('GET', '/', HttpServerResponse.redirect('/products', { status: 302 })),
  HttpRouter.add(
    'GET',
    '/styles.css',
    HttpServerResponse.file(publicFile('styles.css'), { contentType: 'text/css' }),
  ),
)

HttpRouter.serve(Routes).pipe(
  Layer.provide(Stores),
  Layer.provide(NodeServices.layer),
  Layer.provide(NodeHttpServer.layer(createServer, { port })),
  Layer.launch,
  NodeRuntime.runMain,
)
