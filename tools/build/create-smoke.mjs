import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* What a user does with a release, run against the packed tarballs: in an
   empty directory outside the monorepo, `npm exec` the packed
   create-hyper-effect (as `npm create hyper-effect` does), install the app
   with the packed @hyper-effect/core, then typecheck and test it. Run
   `node tools/build/pack.mjs` first. --keep leaves the app in place. */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = join(root, 'output', 'pack')
const tarball = prefix => {
  const file = existsSync(out) ? readdirSync(out).find(name => name.startsWith(prefix) && name.endsWith('.tgz')) : undefined
  if (file === undefined) throw new Error(`no ${prefix}*.tgz in output/pack: run node tools/build/pack.mjs first`)
  return join(out, file)
}
const create = tarball('create-hyper-effect-')
const core = tarball('hyper-effect-core-')

const work = mkdtempSync(join(tmpdir(), 'hyper-effect-create-'))
const app = join(work, 'smoke-app')
const run = (command, args, cwd) => {
  console.log(`$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

try {
  run('npm', ['exec', '--yes', `--package=${create}`, '--', 'create-hyper-effect', 'smoke-app', '--title', 'Smoke App', '--core', `file:${core}`], work)
  if (!existsSync(join(app, '.claude', 'skills', 'hyper-effect', 'SKILL.md'))) throw new Error('the app has no hyper-effect skill')
  run('npm', ['install', '--no-audit', '--no-fund'], app)
  run('npm', ['run', 'typecheck'], app)
  run('npm', ['test'], app)
  run('npm', ['run', 'css'], app)
  console.log(`created, installed, typechecked and tested an app outside the monorepo`)
} finally {
  if (process.argv.includes('--keep')) console.log(`kept ${app}`)
  else rmSync(work, { recursive: true, force: true })
}
