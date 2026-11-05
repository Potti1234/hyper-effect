// Point every workspace at the newest Foldkit, Foldkit UI and the Effect
// release Foldkit accepts, so CI learns about a breaking Foldkit release
// before a user does. Run `npm install` afterwards.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const view = (...args) =>
  JSON.parse(execFileSync('npm', ['view', ...args, '--json'], { encoding: 'utf8' }))

const foldkit = view('foldkit', 'version')
const ui = view('@foldkit/ui', 'version')
const effectRange = view(`foldkit@${foldkit}`, 'peerDependencies.effect')
const effectVersions = view(`effect@${effectRange}`, 'version')
const effect = Array.isArray(effectVersions) ? effectVersions.at(-1) : effectVersions

const versionFor = name =>
  name === 'foldkit' ? foldkit : name === '@foldkit/ui' ? ui : name === 'effect' || name.startsWith('@effect/') ? effect : undefined

const files = execFileSync('git', ['ls-files', '*package.json'], { encoding: 'utf8' }).split('\n').filter(Boolean)
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const next = text.replace(/"(foldkit|@foldkit\/ui|effect|@effect\/[a-z-]+)": "[^"]+"/g, (match, name) => {
    const version = versionFor(name)
    return version === undefined ? match : `"${name}": "${version}"`
  })
  if (next !== text) writeFileSync(file, next)
}
console.log(`foldkit ${foldkit}, @foldkit/ui ${ui}, effect ${effect}`)
