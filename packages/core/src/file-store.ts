import { Effect, FileSystem, Layer, Path, Schedule } from 'effect'
import { KeyValueStore } from 'effect/persistence'

/* Session snapshots in files, for development and for processes sharing one
   machine. Effect's `KeyValueStore.layerFileSystem` writes in place: a
   process killed mid-write leaves a truncated snapshot that no restore can
   read, and with `durableEvents` every event writes. This store writes a
   temporary file and renames it over the old one, so a reader finds the old
   snapshot or the new one, never part of one. Reads, removal and listing are
   `layerFileSystem`'s, on the same directory and file names. */

let temporaries = 0

export const fileStore = (directory: string) =>
  Layer.effect(KeyValueStore.KeyValueStore)(
    Effect.gen(function* () {
      const files = yield* KeyValueStore.KeyValueStore
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const failed = (key: string) => (cause: unknown) =>
        new KeyValueStoreError({ method: 'set', key, message: `Unable to set item with key ${key}`, cause })
      return KeyValueStore.make({
        get: files.get,
        getUint8Array: files.getUint8Array,
        remove: files.remove,
        has: files.has,
        clear: files.clear,
        size: files.size,
        keys: files.keys,
        set: (key, value) => {
          // The file name `layerFileSystem` uses for the key.
          const file = path.join(directory, encodeURIComponent(key))
          const temporary = `${file}.${process.pid}-${(temporaries += 1).toString(36)}.tmp`
          return (typeof value === 'string' ? fs.writeFileString(temporary, value) : fs.writeFile(temporary, value)).pipe(
            // Windows refuses to replace a file another process has open for
            // a moment; try again shortly.
            Effect.andThen(
              fs.rename(temporary, file).pipe(Effect.retry({ schedule: Schedule.spaced('10 millis'), times: 5 })),
            ),
            Effect.mapError(failed(key)),
            Effect.tapError(() => fs.remove(temporary).pipe(Effect.ignore)),
          )
        },
      })
    }),
  ).pipe(Layer.provide(KeyValueStore.layerFileSystem(directory)))

const { KeyValueStoreError } = KeyValueStore
