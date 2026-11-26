import { describe, expect, it } from 'vitest'

import { forbiddenChain } from '../src/isolation/parent'

/* What a bundle must not include: found through the imports esbuild
   records, with the chain that pulled it in. */

const metafile = {
  inputs: {
    '<stdin>': { imports: [{ path: 'extensions/memory/extension.ts' }] },
    'extensions/memory/extension.ts': { imports: [{ path: 'src/app/extensions.ts' }] },
    'src/app/extensions.ts': { imports: [{ path: 'src/app/threads.ts' }, { path: 'src/app/domain.ts' }] },
    'src/app/domain.ts': { imports: [] },
    'src/app/threads.ts': { imports: [{ path: 'src/app/store.ts' }] },
    'src/app/store.ts': { imports: [{ path: 'node:sqlite', external: true }] },
  },
}

describe('forbiddenChain', () => {
  it('names the chain to a forbidden app module', () => {
    // Relative to the server's folder, or absolute.
    expect(forbiddenChain(metafile, ['src/app/store.ts'], '/repo')?.at(-1)).toBe('src/app/store.ts')
    expect(forbiddenChain(metafile, ['/repo/src/app/store.ts'], '/repo')).toEqual([
      'extensions/memory/extension.ts',
      'src/app/extensions.ts',
      'src/app/threads.ts',
      'src/app/store.ts',
    ])
  })

  it('finds modules by name, and passes a clean bundle', () => {
    expect(forbiddenChain(metafile, ['node:sqlite'], '/repo')?.at(-1)).toBe('node:sqlite')
    expect(forbiddenChain(metafile, ['node:child_process'], '/repo')).toBeNull()
    expect(forbiddenChain(metafile, [], '/repo')).toBeNull()
  })
})
