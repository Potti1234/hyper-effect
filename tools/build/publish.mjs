import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* Publishes the directories `tools/build/pack.mjs` staged, in dependency
   order, skipping any version already on npm (so a rerun after a partial
   failure finishes the release). A prerelease such as 0.1.0-alpha.0 goes to
   the `alpha` dist-tag, so `npm install` keeps resolving the latest stable
   version. Prints changesets' "New tag:" line per package, from which
   changesets/action creates the GitHub releases.

   In CI, authentication is npm trusted publishing (OIDC) or, until that is
   set up, NODE_AUTH_TOKEN. Provenance is on when NPM_CONFIG_PROVENANCE=true. */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = join(root, 'output', 'pack')
const dirs = ['core', 'island', 'create-hyper-effect']
const isDryRun = process.argv.includes('--dry-run')

const isPublished = (name, version) => {
  try {
    return execFileSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === version
  } catch {
    return false
  }
}

for (const dir of dirs) {
  const staged = join(out, dir)
  const { name, version } = JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8'))
  if (version === '0.0.0') throw new Error(`${name} is still 0.0.0: run \`npm run version-packages\` first`)
  if (isPublished(name, version)) {
    console.log(`${name}@${version} is already on npm`)
    continue
  }
  const prerelease = version.match(/-([a-z]+)/)?.[1]
  const tag = prerelease ?? 'latest'
  execFileSync('npm', ['publish', '--access', 'public', '--tag', tag, ...(isDryRun ? ['--dry-run'] : [])], {
    cwd: staged,
    stdio: 'inherit',
  })
  console.log(`New tag: ${name}@${version}`)
}
