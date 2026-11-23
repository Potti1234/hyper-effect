import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'jellyware',
    include: ['test/**/*.test.ts'],
  },
})
