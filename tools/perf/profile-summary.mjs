// Summarizes a .cpuprofile: busy time, then self time by package/file and by function.
// usage: node tools/perf/profile-summary.mjs [output/server.cpuprofile]
import { readFileSync } from 'node:fs'

const profile = JSON.parse(readFileSync(process.argv[2] ?? 'output/server.cpuprofile', 'utf8'))
const byId = new Map(profile.nodes.map(node => [node.id, node]))
const self = new Map()
const interval = (profile.endTime - profile.startTime) / profile.samples.length / 1000
for (const id of profile.samples) self.set(id, (self.get(id) ?? 0) + interval)

const byFunction = new Map()
const byFile = new Map()
let total = 0
for (const [id, millis] of self) {
  const { callFrame } = byId.get(id)
  total += millis
  const file = callFrame.url.replace(/^.*node_modules\//, '').replace(/^file:\/\/\/.*hyper-effect\//, '') || `(${callFrame.functionName || 'native'})`
  const fn = `${callFrame.functionName || '(anonymous)'} ${file}:${callFrame.lineNumber + 1}`
  byFunction.set(fn, (byFunction.get(fn) ?? 0) + millis)
  const group = file.split('/').slice(0, 3).join('/')
  byFile.set(group, (byFile.get(group) ?? 0) + millis)
}
const idle = [...byFunction].filter(([name]) => name.includes('(idle)')).reduce((sum, [, ms]) => sum + ms, 0)
const busy = total - idle
const top = (map, count) =>
  [...map]
    .filter(([name]) => !name.includes('(idle)'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([name, ms]) => `${((ms / busy) * 100).toFixed(1).padStart(5)}%  ${name}`)
    .join('\n')
console.log(`busy ${busy.toFixed(0)} ms of ${total.toFixed(0)} ms\n\nby file:\n${top(byFile, 18)}\n\nby function:\n${top(byFunction, 30)}`)
