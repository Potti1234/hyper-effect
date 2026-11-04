import { islandsBuild } from '@hyper-effect/island/vite'
import { defineConfig } from 'vite'

export default defineConfig(
  islandsBuild({
    entry: new URL('./src/client/islands.ts', import.meta.url),
    outDir: new URL('./public/assets', import.meta.url),
    alias: { '@': new URL('./src', import.meta.url) },
  }),
)
