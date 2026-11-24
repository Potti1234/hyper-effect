import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node'
import { Layer } from 'effect'
import { HttpRouter, HttpServerResponse } from 'effect/http'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as Hyper from '@hyper-effect/core'
import * as Jellyware from '@hyper-effect/jellyware'

import * as Agent from '@/app/agent'
import * as Auth from '@/app/auth'
import { importRules } from '@/app/extension-rules'
import * as Extensions from '@/app/extensions'
import * as IssuePage from '@/app/issue/page'
import * as Issues from '@/app/issues/page'
import * as Store from '@/app/store'
import * as Styles from '@/app/styles'
import * as Workshop from '@/app/workshop/page'

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
     change (on by default).
   - JELLYWARE_AGENT=script replaces pi with a scripted agent (browser
     checks); see src/app/agent.ts for pi's settings. */

const port = Number(process.env['PORT'] ?? 4200)
const publicFile = (path: string) => fileURLToPath(new URL(`../public/${path}`, import.meta.url))

const page = Extensions.pageOptions

const appDirectory = fileURLToPath(new URL('..', import.meta.url))
const extensionsDirectory = join(appDirectory, 'extensions')
const workDirectory = join(appDirectory, '.jellyware')

/** Where extensions run: the page host, the sidebar entries and the
 *  stylesheet, shared by the app's pages and the extensions (one instance
 *  of each per server). */
const Host = Layer.mergeAll(
  Hyper.pageHost,
  // Commands that name roles are checked against the member's role.
  Jellyware.Contributions.make({ rolesOf: Extensions.rolesOf }),
  // Rebuilds the CSS for classes extensions add, and moves open pages to it.
  Styles.layer({ appDirectory, extensionsDirectory }),
)

const Loaded = Jellyware.layer({
  directory: extensionsDirectory,
  requires: Extensions.requires,
  watch: process.env['JELLYWARE_WATCH'] !== '0',
}).pipe(
  // The graph sees the app's services, so extensions can require them.
  Layer.provide(Jellyware.graph),
)

/** Changes by prompt: the agent works on a copy of extensions/; the import
 *  rules and the typecheck decide what may go live, an administrator reads
 *  the diff and approves it, and the loader builds it (/extensions). */
const Changes = Jellyware.changesLayer({
  extensionsDirectory,
  workDirectory,
  agent:
    process.env['JELLYWARE_AGENT'] === 'script'
      ? Agent.scriptAgent
      : Agent.piAgent({ appDirectory, repository: join(appDirectory, '..', '..'), agentDirectory: join(workDirectory, 'pi-agent') }),
  checks: [Jellyware.importCheck(importRules), Agent.typecheck(appDirectory, workDirectory)],
  protectedDirectories: [join(appDirectory, 'src')],
  review: true,
}).pipe(Layer.provideMerge(Loaded))

const Routes = Layer.mergeAll(
  // Resting on a link to another page prefetches it (no session until followed).
  Hyper.layer(Issues.program, { ...page, path: '/team/:team', paths: Issues.paths, prefetch: ['/issue/*'] }),
  Hyper.layer(IssuePage.program, { ...page, path: '/issue/:identifier', prefetch: ['/team/*', '/my-issues', '/issues'] }),
  Hyper.layer(Workshop.program, { ...page, path: Workshop.PATH }),
  HttpRouter.add('GET', '/', HttpServerResponse.redirect('/team/ENG', { status: 303 })),
  Auth.routes,
  // Rebuilt while the server runs (src/app/styles.ts): never from a cache.
  HttpRouter.add(
    'GET',
    '/styles.css',
    HttpServerResponse.file(publicFile('styles.css'), { contentType: 'text/css', headers: { 'cache-control': 'no-cache' } }),
  ),
).pipe(Layer.provideMerge(Changes), Layer.provideMerge(Host))

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
