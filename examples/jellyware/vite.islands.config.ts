import { islandsBuild } from '@hyper-effect/island/vite'
import { defineConfig } from 'vite'

/* The islands bundle: the app's widgets (charts, maps) that run in the
   browser inside server pages, served at /assets. */
export default defineConfig(
  islandsBuild({
    entry: new URL('./src/client/islands.ts', import.meta.url),
    outDir: new URL('./public/assets', import.meta.url),
    alias: { '@': new URL('./src', import.meta.url), '#app': new URL('./src/app', import.meta.url) },
  }),
)
