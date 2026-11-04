import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* Builds the publishable packages and packs them as npm would publish them.
   In the workspace their exports point at src/*.ts (tsx, Vite and Vitest run
   the source); the packed manifest points at the compiled dist/*.js and
   dist/*.d.ts instead. Each packed entry is then imported with plain node, so
   a missing extension or a source-only import fails here, not for a user.
   Output: output/pack/<package>/ and output/pack/*.tgz. */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = join(root, 'output', 'pack')
const packages = ['core', 'island']

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
// Packed packages find each other here before the workspace's source ones.
mkdirSync(join(out, 'node_modules', '@hyper-effect'), { recursive: true })

const toDist = target => target.replace(/^\.\/src\//, './dist/').replace(/\.ts$/, '.js')

for (const name of packages) {
  const dir = join(root, 'packages', name)
  rmSync(join(dir, 'dist'), { recursive: true, force: true })
  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
    cwd: dir,
    stdio: 'inherit',
  })
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const staged = join(out, name)
  mkdirSync(staged, { recursive: true })
  cpSync(join(dir, 'dist'), join(staged, 'dist'), { recursive: true })
  for (const file of ['README.md', 'LICENSE']) {
    const source = existsSync(join(dir, file)) ? join(dir, file) : join(root, file)
    if (existsSync(source)) cpSync(source, join(staged, file))
  }
  const exports = Object.fromEntries(
    Object.entries(manifest.exports).map(([path, target]) => [
      path,
      { types: toDist(target).replace(/\.js$/, '.d.ts'), default: toDist(target) },
    ]),
  )
  const { scripts, devDependencies, ...published } = manifest
  writeFileSync(join(staged, 'package.json'), `${JSON.stringify({ ...published, exports, files: ['dist'] }, null, 2)}\n`)
  symlinkSync(staged, join(out, 'node_modules', '@hyper-effect', name), 'dir')
  for (const target of Object.values(exports)) {
    execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(join(staged, target.default))})`], {
      cwd: staged,
      stdio: 'inherit',
    })
  }
  execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: staged, stdio: ['ignore', 'inherit', 'inherit'] })
  console.log(`packed @hyper-effect/${name}: ${Object.keys(exports).length} entry points import under node`)
}
