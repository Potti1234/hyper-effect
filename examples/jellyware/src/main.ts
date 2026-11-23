import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node'
import { Layer } from 'effect'
import { HttpRouter, HttpServerResponse } from 'effect/http'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

import * as Hyper from '@hyper-effect/core'
import * as Jellyware from '@hyper-effect/jellyware'

import * as Auth from '@/app/auth'
import * as Extensions from '@/app/extensions'
import * as IssuePage from '@/app/issue/page'
import * as Issues from '@/app/issues/page'
import * as Store from '@/app/store'

/* The server: the app's own pages, plain routes for sign-in and static
   files, and the extensions in `extensions/`, loaded while it runs. Each
   extension may add pages (through the page host) and sidebar entries
   (through Contributions); see src/app/extensions.ts for what it may use.

   Environment:
   - PORT (default 4200)
   - APP_SECRET signs the sign-in cookie; HYPER_SNAPSHOT_SECRET seals session
     snapshots. Both have development values in the source: set them
     everywhere else.
   - JELLYWARE_WATCH=0 turns off reloading extensions when their files
     change (on by default). */

const port = Number(process.env['PORT'] ?? 4200)
const publicFile = (path: string) => fileURLToPath(new URL(`../public/${path}`, import.meta.url))

const page = Extensions.pageOptions

/** Where extensions run: the page host and the sidebar entries, shared by
 *  the app's pages and the extensions (one instance of each per server). */
const Host = Layer.mergeAll(Hyper.pageHost, Jellyware.Contributions.layer)

const Loaded = Jellyware.layer({
  directory: fileURLToPath(new URL('../extensions', import.meta.url)),
  requires: Extensions.requires,
  watch: process.env['JELLYWARE_WATCH'] !== '0',
}).pipe(
  // The graph sees the app's services, so extensions can require them.
  Layer.provide(Jellyware.graph),
)

const Routes = Layer.mergeAll(
  // Resting on a link to another page prefetches it (no session until followed).
  Hyper.layer(Issues.program, { ...page, path: '/team/:team', paths: Issues.paths, prefetch: ['/issue/*'] }),
  Hyper.layer(IssuePage.program, { ...page, path: '/issue/:identifier', prefetch: ['/team/*', '/my-issues', '/issues'] }),
  HttpRouter.add('GET', '/', HttpServerResponse.redirect('/team/ENG', { status: 303 })),
  Auth.routes,
  HttpRouter.add('GET', '/styles.css', HttpServerResponse.file(publicFile('styles.css'), { contentType: 'text/css' })),
  Loaded,
).pipe(Layer.provideMerge(Host))

HttpRouter.serve(Routes).pipe(
  Layer.provide([
    Store.layer,
    // Session snapshots on disk: restart the server and open pages carry on,
    // and a page swapped for a new version of its extension restores them.
    Hyper.fileStore('.hyper-sessions'),
  ]),
  Layer.provide(NodeServices.layer),
  Layer.provide(NodeHttpServer.layer(createServer, { port })),
  Layer.launch,
  NodeRuntime.runMain,
)
