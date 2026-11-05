import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node'
import { Layer } from 'effect'
import { HttpRouter, HttpServerResponse } from 'effect/http'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

import * as Hyper from '@hyper-effect/core'

import * as Auth from '@/app/auth'
import * as TaskPage from '@/app/tasks/page'
import { Tasks } from '@/app/tasks/store'

/* The server: one hyper-effect layer per page, plain routes for sign-in and
   the stylesheet, the app's services, and the session snapshot store.

   Environment:
   - PORT (default 4000)
   - APP_SECRET signs the sign-in cookie; HYPER_SNAPSHOT_SECRET seals session
     snapshots. Both have development values in the source: set them
     everywhere else. */

const port = Number(process.env['PORT'] ?? 4000)
const publicFile = (path: string) => fileURLToPath(new URL(`../public/${path}`, import.meta.url))

const page: Hyper.Options = {
  stylesheets: ['/styles.css'],
  // Sessions belong to the signed-in user; signing out ends them.
  principal: Auth.principal,
  snapshotSecret: Hyper.secretFromEnvironment('HYPER_SNAPSHOT_SECRET', 'dev-snapshot-secret, set HYPER_SNAPSHOT_SECRET'),
}

const Routes = Layer.mergeAll(
  Hyper.layer(TaskPage.program, { ...page, path: '/' }),
  Auth.routes,
  HttpRouter.add('GET', '/styles.css', HttpServerResponse.file(publicFile('styles.css'), { contentType: 'text/css' })),
)

HttpRouter.serve(Routes).pipe(
  Layer.provide([
    Tasks.layer,
    // Session snapshots on disk: restart the server and open pages carry on.
    // Several machines: Hyper.sqlStore() on Postgres instead.
    Hyper.fileStore('.hyper-sessions'),
  ]),
  Layer.provide(NodeServices.layer),
  Layer.provide(NodeHttpServer.layer(createServer, { port })),
  Layer.launch,
  NodeRuntime.runMain,
)
