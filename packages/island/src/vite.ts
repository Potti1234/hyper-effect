import { fileURLToPath } from 'node:url'

import type { UserConfig } from 'vite'

/* Vite preset for an islands bundle: one entry that registers the islands,
   built into the directory the server serves under `base`. Heavy libraries
   an island imports lazily (MapLibre in the Dispatch example) become chunks
   loaded only when an island mounts. */
export const islandsBuild = (options: Readonly<{
  /** The islands entry (registers every island), as a file URL or path. */
  entry: string | URL
  /** Output directory; it is emptied on every build. */
  outDir: string | URL
  /** Public path the server serves `outDir` at. Defaults to `/assets/`. */
  base?: string
  /** Import aliases, such as `{ '@': src }`. */
  alias?: Readonly<Record<string, string | URL>>
}>): UserConfig => {
  const path = (value: string | URL) => (value instanceof URL ? fileURLToPath(value) : value)
  return {
    resolve: {
      alias: Object.fromEntries(
        Object.entries(options.alias ?? {}).map(([key, value]) => [key, path(value)]),
      ),
    },
    base: options.base ?? '/assets/',
    publicDir: false,
    build: {
      outDir: path(options.outDir),
      emptyOutDir: true,
      target: 'es2022',
      // Lazily imported libraries become chunks; only the entry is eager.
      chunkSizeWarningLimit: 1200,
      rolldownOptions: {
        input: path(options.entry),
        output: {
          entryFileNames: 'islands.js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: '[name]-[hash][extname]',
        },
      },
    },
  }
}
