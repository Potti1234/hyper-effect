import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Stream } from 'effect'
import { KeyValueStore } from 'effect/persistence'

import { Contributions } from '../src/contributions'
import { ExtensionData, migrationsCheck, openDatabase, applyMigrations, makeData } from '../src/data'
import { graph } from '../src/graft'
import { Extensions, layer } from '../src/loader'

/* Data of an extension: its own SQLite database, append-only migrations,
   statements kept to rows, writes that pages can follow, and a check that
   replays new migrations on a copy before a run goes live. */

const root = join(import.meta.dirname, '.tmp', `data-${Date.now()}`)
const directory = join(root, 'extensions')
const dataDirectory = join(root, 'data')
mkdirSync(directory, { recursive: true })
afterAll(() => rmSync(root, { recursive: true, force: true }))

const here = (file: string) => join(import.meta.dirname, '..', 'src', file).replaceAll('\\', '/')

const CREATE = 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)'
const ADD_PINNED = 'ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0'

const writeNotes = (folder: string, migrations: ReadonlyArray<string>, label = 'Notes') => {
  mkdirSync(join(folder, 'notes'), { recursive: true })
  writeFileSync(join(folder, 'notes', 'extension.json'), JSON.stringify({ id: 'notes', name: 'Notes', version: '1', entry: 'extension.ts', migrations }))
  writeFileSync(
    join(folder, 'notes', 'extension.ts'),
    `
import { Effect, Layer } from 'effect'
import { Contributions } from '${here('contributions.ts')}'
import { ExtensionData } from '${here('data.ts')}'

export default Layer.effectDiscard(
  Effect.gen(function* () {
    const data = yield* ExtensionData
    const count = (yield* data.query('SELECT COUNT(*) AS n FROM notes'))[0]?.['n']
    const contributions = yield* Contributions
    yield* contributions.nav({ id: 'notes', label: '${label} ' + String(count), href: '/notes', icon: 'star' })
    yield* contributions.command({
      id: 'notes.add',
      run: ({ args }) =>
        data.run('INSERT INTO notes (body) VALUES (?)', [String((args as { body: string }).body)]).pipe(
          Effect.as('Added'),
          Effect.mapError(error => error.message),
        ),
    })
  }),
)
`,
  )
}

describe('data: migrations and statements', () => {
  it.effect('applies migrations once, refuses changed ones, and keeps statements to rows', () =>
    Effect.gen(function* () {
      const database = yield* openDatabase(join(root, 'unit'), 'unit')
      assert.isNull(applyMigrations(database.db, [CREATE]))
      assert.isNull(applyMigrations(database.db, [CREATE]))
      assert.isNull(applyMigrations(database.db, [CREATE, ADD_PINNED]))
      assert.include(applyMigrations(database.db, ['CREATE TABLE notes (id INTEGER PRIMARY KEY)', ADD_PINNED]) ?? '', 'Migration 0 differs')
      // A failing migration changes nothing.
      assert.include(applyMigrations(database.db, [CREATE, ADD_PINNED, 'CREATE TABLE broken (']) ?? '', 'Migration 2 failed')

      const data = makeData(database)
      assert.strictEqual(yield* data.run('INSERT INTO notes (body) VALUES (?)', ['first']), 1)
      assert.deepStrictEqual(yield* data.query('SELECT body, pinned FROM notes'), [{ body: 'first', pinned: 0 }])
      for (const statement of [
        'DROP TABLE notes',
        'CREATE TABLE other (x)',
        "ATTACH DATABASE 'elsewhere.sqlite' AS other",
        'PRAGMA writable_schema = 1',
        'DELETE FROM _jellyware_migrations',
      ]) {
        const error = yield* Effect.flip(data.run(statement))
        assert.strictEqual(error._tag, 'DataError', statement)
      }
      assert.strictEqual((yield* data.query('SELECT COUNT(*) AS n FROM _jellyware_migrations'))[0]?.['n'], 2)
      // Writes can be followed.
      const before = yield* Stream.runHead(data.changes)
      yield* data.run('UPDATE notes SET pinned = 1')
      const after = yield* Stream.runHead(data.changes)
      assert.isTrue(before._tag === 'Some' && after._tag === 'Some' && after.value > before.value)
      database.db.close()
    }),
  )
})

describe('data: through the loader and the run checks', () => {
  writeNotes(directory, [CREATE])
  const app = layer({ directory, dataDirectory, requires: [Contributions] }).pipe(
    Layer.provideMerge(graph),
    Layer.provideMerge(Contributions.layer),
    Layer.provideMerge(KeyValueStore.layerMemory),
  )
  const until = <A>(effect: Effect.Effect<A>, done: (value: A) => boolean) =>
    Effect.gen(function* () {
      for (let i = 0; i < 200; i++) {
        const value = yield* effect
        if (done(value)) return value
        yield* Effect.sleep('25 millis')
      }
      return yield* effect
    })

  it.live('keeps an extension’s rows across versions, and checks new migrations on a copy first', () =>
    Effect.gen(function* () {
      const contributions = yield* Contributions
      const extensions = yield* Extensions
      const label = Effect.map(contributions.navEntries, entries => entries[0]?.label)
      assert.strictEqual(yield* until(label, value => value !== undefined), 'Notes 0')
      assert.strictEqual(yield* contributions.run('notes.add', { args: { body: 'hello' }, memberId: 'ada' }), 'Added')

      // A new version (here: a new label) finds the row.
      writeNotes(directory, [CREATE, ADD_PINNED], 'Notes v2')
      yield* extensions.reload('notes')
      assert.strictEqual(yield* until(label, value => value === 'Notes v2 1'), 'Notes v2 1')
      const status = (yield* extensions.current).find(each => each.id === 'notes')
      assert.deepStrictEqual(status?.data, { migrations: 2, tables: [{ name: 'notes', columns: ['id', 'body', 'pinned'] }] })

      // The run check: an edited migration, and a failing one, are refused on a copy.
      const check = migrationsCheck(dataDirectory)
      const snapshot = join(root, 'snapshot')
      writeNotes(snapshot, ['CREATE TABLE notes (id INTEGER PRIMARY KEY)', ADD_PINNED])
      const changed = yield* Effect.flip(check.run({ snapshot, runDirectory: root, changed: ['notes'] }))
      assert.include(changed, 'Migration 0 differs from the one applied before')
      writeNotes(snapshot, [CREATE, ADD_PINNED, 'ALTER TABLE missing ADD COLUMN x'])
      assert.include(yield* Effect.flip(check.run({ snapshot, runDirectory: root, changed: ['notes'] })), 'Migration 2 failed')
      writeNotes(snapshot, [CREATE, ADD_PINNED, 'CREATE INDEX notes_pinned ON notes (pinned)'])
      yield* check.run({ snapshot, runDirectory: root, changed: ['notes'] })
      // The copy took it; the live database did not.
      assert.strictEqual((yield* extensions.current).find(each => each.id === 'notes')?.data?.migrations, 2)
    }).pipe(Effect.provide(app), Effect.scoped),
    30_000,
  )
})

void ExtensionData
