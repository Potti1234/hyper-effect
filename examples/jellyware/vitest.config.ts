import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    name: 'jellyware-example',
    // The app's tests, and the tests extensions bring (run on every change too).
    include: ['test/**/*.test.ts', 'extensions/**/*.test.ts'],
  },
})
