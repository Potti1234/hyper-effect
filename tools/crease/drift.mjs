/* Checks the creaseui copies under apps/ and examples/ against creaseui.

   creaseui is a copy-in registry: `src/ui/<name>.ts` in a workspace is the
   app's own code, installed from creaseui's `src/ui/<name>.ts`. This lists
   every copy that differs from creaseui at the commit pinned in
   upstream.json. A difference is accepted only when upstream.json records it
   (with a reason and the hash of the copy), so a local patch is a decision
   and an unnoticed edit or a stale copy fails the check.

     node tools/crease/drift.mjs           check (npm run check:crease)
     node tools/crease/drift.mjs --write   record the current differences

   Upstream files come from CREASEUI_DIR (a creaseui checkout) when set, else
   from raw.githubusercontent.com. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../..', import.meta.url).pathname
const recordPath = join(root, 'tools/crease/upstream.json')
const record = JSON.parse(readFileSync(recordPath, 'utf8'))
const isWriting = process.argv.includes('--write')

const normalize = text => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 16)

const upstream = async path => {
  const checkout = process.env['CREASEUI_DIR']
  if (checkout !== undefined && checkout !== '') {
    try {
      return execFileSync('git', ['-C', checkout, 'show', `${record.commit}:${path}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      return undefined
    }
  }
  const response = await fetch(`https://raw.githubusercontent.com/${record.repository}/${record.commit}/${path}`)
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`${path}: GitHub answered ${response.status}`)
  return response.text()
}

const copies = ['apps', 'examples'].flatMap(group =>
  readdirSync(join(root, group))
    .map(workspace => join(group, workspace, 'src/ui'))
    .filter(dir => existsSync(join(root, dir)))
    .flatMap(dir => readdirSync(join(root, dir)).filter(file => file.endsWith('.ts')).map(file => join(dir, file))),
)

const problems = []
const differences = {}
let identical = 0
for (const copy of copies.sort()) {
  const name = copy.split('/').at(-1)
  const local = normalize(readFileSync(join(root, copy), 'utf8'))
  const source = await upstream(`src/ui/${name}`)
  const recorded = record.differences[copy]
  if (source !== undefined && normalize(source) === local) {
    identical += 1
    if (recorded !== undefined) problems.push(`${copy}: matches creaseui now; drop it from upstream.json`)
    continue
  }
  const reason = recorded?.reason ?? (source === undefined ? 'not in creaseui src/ui' : 'unrecorded')
  differences[copy] = { reason, sha256: hash(local) }
  if (recorded === undefined) problems.push(`${copy}: ${source === undefined ? 'not in creaseui' : 'differs from creaseui'} and is not recorded`)
  else if (recorded.sha256 !== hash(local)) problems.push(`${copy}: changed since its difference was recorded (${recorded.reason})`)
}
for (const copy of Object.keys(record.differences)) {
  if (!copies.includes(copy)) problems.push(`${copy}: recorded in upstream.json but no longer exists`)
}

console.log(`creaseui ${record.commit.slice(0, 8)}: ${copies.length} copies, ${identical} identical, ${Object.keys(differences).length} differ`)
for (const [copy, { reason }] of Object.entries(differences)) console.log(`  ${copy}: ${reason}`)

if (isWriting) {
  writeFileSync(recordPath, `${JSON.stringify({ ...record, differences }, null, 2)}\n`)
  console.log(`wrote ${Object.keys(differences).length} differences to tools/crease/upstream.json`)
} else if (problems.length > 0) {
  console.error(`\n${problems.join('\n')}`)
  console.error('\nReinstall the copy from creaseui, or record the patch with --write and give it a reason.')
  process.exitCode = 1
}
