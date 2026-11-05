#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/* create-hyper-effect: a new hyper-effect app from the template.

   usage: create-hyper-effect <name> [--title "My App"] [--dir <path>] [--core <version>]

   Until @hyper-effect/core is published, apps live in the hyper-effect
   monorepo: run from inside it and the app goes to apps/<name>, a workspace
   that uses the monorepo's packages. --core sets the dependency for an app
   elsewhere once a version is published. */

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), 'template')
/** Files renamed on the way: npm would treat them specially in the package. */
const RENAMES = { '_package.json': 'package.json', _gitignore: '.gitignore' }
const TEXT = /\.(ts|mjs|js|json|md|css|html|txt)$|^_?gitignore$/

const fail = message => {
  console.error(`create-hyper-effect: ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value`)
  args.splice(index, 2)
  return value
}
const title = option('title')
const dir = option('dir')
const core = option('core')
const [name] = args
if (name === undefined || !/^[a-z][a-z0-9-]{0,50}$/.test(name)) {
  fail('usage: create-hyper-effect <name> [--title "My App"] [--dir <path>] [--core <version>]\n  <name>: lowercase letters, digits and dashes, starting with a letter')
}

/** The hyper-effect monorepo containing `from`, if any. */
const findMonorepo = from => {
  for (let current = resolve(from); ; current = dirname(current)) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === 'hyper-effect-monorepo') return current
    if (dirname(current) === current) return undefined
  }
}

const monorepo = findMonorepo(process.cwd())
if (monorepo === undefined && core === undefined) {
  fail('@hyper-effect/core is not published yet: run this inside the hyper-effect monorepo (the app goes to apps/<name>), or pass --core <version>.')
}
const target = resolve(dir ?? (monorepo === undefined ? name : join(monorepo, 'apps', name)))
if (existsSync(target) && readdirSync(target).length > 0) fail(`${target} exists and is not empty`)

const values = {
  name,
  title: title ?? name.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' '),
  // Inside the monorepo, npm workspaces link the local package.
  coreVersion: core ?? '*',
}
const fill = text => text.replace(/\{\{(name|title|coreVersion)\}\}/g, (_, key) => values[key])

const copy = (from, to) => {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    const source = join(from, entry)
    const destination = join(to, RENAMES[entry] ?? entry)
    if (statSync(source).isDirectory()) copy(source, destination)
    else if (TEXT.test(entry)) writeFileSync(destination, fill(readFileSync(source, 'utf8')))
    else writeFileSync(destination, readFileSync(source))
  }
}
copy(TEMPLATE, target)

const shown = relative(process.cwd(), target) || '.'
console.log(`Created ${values.title} in ${shown}.

Next:
${monorepo === undefined ? `  cd ${shown}\n  npm install` : '  npm install            # at the monorepo root: links the new workspace'}
  cd ${shown}
  npm start              # http://localhost:4000, sign in with any name
  npm test
  npm run check          # the browser check, against the running server

Agents: the hyper-effect skill (.claude/skills/hyper-effect) explains how to build on it.`)
