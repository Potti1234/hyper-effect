/* Builds the compatibility matrix against a crease/ui checkout.
   Usage: node tools/compat/run.mjs [path-to-crease] [output.json]

   Prepares a temporary environment in which crease's sources and
   hyper-effect's framework resolve one shared Foldkit instance: the
   framework is copied next to matrix.ts, node_modules is a junction to
   crease's, and `@/` maps to crease's src. */

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const crease = resolve(process.argv[2] ?? join(root, '..', 'crease'))
const output = resolve(process.argv[3] ?? join(root, 'output', 'compatibility.json'))

const environment = mkdtempSync(join(tmpdir(), 'hyper-compat-'))
try {
  mkdirSync(join(environment, 'hyper'))
  cpSync(join(root, 'packages', 'core', 'src'), join(environment, 'hyper'), { recursive: true })
  cpSync(join(root, 'tools', 'compat', 'matrix.ts'), join(environment, 'matrix.ts'))
  symlinkSync(join(crease, 'node_modules'), join(environment, 'node_modules'), 'junction')
  writeFileSync(join(environment, 'package.json'), JSON.stringify({ name: 'compat', private: true, type: 'module' }))
  writeFileSync(
    join(environment, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        noEmit: true,
        paths: { '@/*': [join(crease, 'src', '*').replace(/\\/g, '/')] },
      },
    }),
  )
  mkdirSync(resolve(output, '..'), { recursive: true })
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'matrix.ts', output], {
    cwd: environment,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' },
  })
  process.exitCode = result.status ?? 1
} finally {
  rmSync(environment, { recursive: true, force: true })
}
