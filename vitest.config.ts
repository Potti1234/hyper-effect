import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Not packages/*: create-hyper-effect's template has tests of its own,
    // which run in the apps generated from it.
    projects: ['packages/core', 'packages/island', 'examples/*', 'apps/*'],
  },
})
