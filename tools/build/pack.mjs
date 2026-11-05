import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* Builds the publishable packages and stages them as npm will publish them.
   In the workspace, core's and island's exports point at src/*.ts (tsx, Vite
   and Vitest run the source) and every package is private, so nothing can be
   published from there by accident. The staged manifest:
   - points exports at the compiled dist/*.js and dist/*.d.ts;
   - drops `private`, scripts and devDependencies;
   - pins workspace dependencies (`*`) to the sibling's exact version.
   Each staged entry is then imported with plain node, so a missing extension
   or a source-only import fails here, not for a user. create-hyper-effect
   gets the agent skill (`skill/`), which it copies into apps created outside
   the monorepo. `tools/build/publish.mjs` publishes the staged directories.
   Output: output/pack/<package>/ and output/pack/*.tgz. */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = join(root, 'output', 'pack')
/** In dependency order: a package is published after what it depends on. */
const packages = [
  { dir: 'core', build: true },
  { dir: 'island', build: true },
  { dir: 'create-hyper-effect', build: false },
]

const manifests = Object.fromEntries(
  packages.map(({ dir }) => {
    const manifest = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'))
    return [manifest.name, manifest]
  }),
)

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
// Staged packages find each other here before the workspace's source ones.
mkdirSync(join(out, 'node_modules', '@hyper-effect'), { recursive: true })

const toDist = target => target.replace(/^\.\/src\//, './dist/').replace(/\.ts$/, '.js')

const pinWorkspace = dependencies =>
  dependencies === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(dependencies).map(([name, range]) => [
          name,
          range === '*' && manifests[name] !== undefined ? manifests[name].version : range,
        ]),
      )

for (const { dir, build } of packages) {
  const source = join(root, 'packages', dir)
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  const staged = join(out, dir)
  mkdirSync(staged, { recursive: true })
  const { scripts, devDependencies, private: _private, ...published } = manifest
  const next = { ...published, dependencies: pinWorkspace(manifest.dependencies), publishConfig: { access: 'public' } }

  if (build) {
    rmSync(join(source, 'dist'), { recursive: true, force: true })
    execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
      cwd: source,
      stdio: 'inherit',
    })
    cpSync(join(source, 'dist'), join(staged, 'dist'), { recursive: true })
    next.exports = Object.fromEntries(
      Object.entries(manifest.exports).map(([path, target]) => [
        path,
        { types: toDist(target).replace(/\.js$/, '.d.ts'), default: toDist(target) },
      ]),
    )
    next.files = ['dist']
  } else {
    for (const file of manifest.files) cpSync(join(source, file), join(staged, file), { recursive: true })
    cpSync(join(root, '.claude', 'skills', 'hyper-effect'), join(staged, 'skill'), { recursive: true })
    next.files = [...manifest.files, 'skill']
  }
  for (const file of ['README.md', 'LICENSE']) {
    const from = existsSync(join(source, file)) ? join(source, file) : join(root, file)
    if (existsSync(from)) cpSync(from, join(staged, file))
  }
  writeFileSync(join(staged, 'package.json'), `${JSON.stringify(next, null, 2)}\n`)

  if (build) {
    symlinkSync(staged, join(out, 'node_modules', ...manifest.name.split('/')), 'dir')
    for (const target of Object.values(next.exports)) {
      execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(join(staged, target.default))})`], {
        cwd: staged,
        stdio: 'inherit',
      })
    }
  }
  execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: staged, stdio: ['ignore', 'inherit', 'inherit'] })
  console.log(
    build
      ? `packed ${manifest.name}@${manifest.version}: ${Object.keys(next.exports).length} entry points import under node`
      : `packed ${manifest.name}@${manifest.version}`,
  )
}
