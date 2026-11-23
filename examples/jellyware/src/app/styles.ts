import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { Effect, Layer, Queue, Stream, SubscriptionRef } from 'effect'

import { StylesheetChanges } from '@hyper-effect/core'

/* The stylesheet while extensions change: Tailwind is built again when a
   file in extensions/ changes (src/styles.css lists it as a source), and
   open pages switch to the new build (core's StylesheetChanges). Pages
   loaded later get the current file: /styles.css is served without
   caching. */

const hashOf = (path: string) =>
  Effect.promise(() =>
    readFile(path).then(
      bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 12),
      () => '',
    ),
  )

const tailwind = (appDirectory: string) =>
  Effect.callback<void>(resume => {
    const cli = join(dirname(createRequire(import.meta.url).resolve('@tailwindcss/cli/package.json')), 'dist', 'index.mjs')
    const child = spawn(process.execPath, [cli, '-i', 'src/styles.css', '-o', 'public/styles.css', '--minify'], {
      cwd: appDirectory,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('close', () => resume(Effect.void))
    child.on('error', () => resume(Effect.void))
    return Effect.sync(() => child.kill())
  })

export const layer = (options: Readonly<{ appDirectory: string; extensionsDirectory: string }>) =>
  Layer.effect(
    StylesheetChanges,
    Effect.gen(function* () {
      const output = join(options.appDirectory, 'public', 'styles.css')
      const version = yield* SubscriptionRef.make(yield* hashOf(output))
      const changed = yield* Queue.sliding<void>(1)
      yield* Effect.acquireRelease(
        Effect.sync(() => watch(options.extensionsDirectory, { recursive: true }, () => Queue.offerUnsafe(changed, undefined))),
        watcher => Effect.sync(() => watcher.close()),
      )
      // Wait for a quiet half second, build, and publish a new version when
      // the CSS differs.
      yield* Effect.gen(function* () {
        yield* Queue.take(changed)
        while ((yield* Queue.take(changed).pipe(Effect.timeoutOption('500 millis')))._tag === 'Some');
        yield* tailwind(options.appDirectory)
        const next = yield* hashOf(output)
        if (next !== '' && next !== (yield* SubscriptionRef.get(version))) {
          yield* SubscriptionRef.set(version, next)
          yield* Effect.logInfo(`jellyware: styles rebuilt (${next})`)
        }
      }).pipe(Effect.forever, Effect.forkScoped)
      // Only builds after a page's stream opened: the page itself links the
      // current file.
      return SubscriptionRef.changes(version).pipe(
        Stream.drop(1),
        Stream.map(hash => [`/styles.css?v=${hash}`]),
      )
    }),
  )
