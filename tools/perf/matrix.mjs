// Runs load-test configurations interleaved, several rounds, and reports the
// median of each figure per configuration. On a noisy or power-limited
// machine single runs mislead; interleaving spreads slow phases over every
// configuration, and medians drop the outliers.
//
// usage: node tools/perf/matrix.mjs <rounds> <sessions> <seconds> <config>...
//   config: label=ENV=value,ENV=value   e.g.  1proc=   2w=WORKERS=2   4w-direct=WORKERS=4,DIRECT=1
//   APP=admin in a config runs tools/perf/admin-load.sh (the catalog admin).
// Every run appends its RESULT to output/perf-matrix.jsonl.
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const [rounds = '3', sessions = '200', seconds = '10', ...specs] = process.argv.slice(2)
const configs = specs.map(spec => {
  const [label, env = ''] = spec.split(/=(.*)/s)
  return {
    label,
    // Split each pair at its first '=' only: values may contain '='.
    env: Object.fromEntries(env.split(',').filter(Boolean).map(pair => pair.split(/=(.*)/s).slice(0, 2))),
  }
})
mkdirSync(join(root, 'output'), { recursive: true })

const results = new Map(configs.map(config => [config.label, []]))
for (let round = 1; round <= Number(rounds); round += 1) {
  for (const config of configs) {
    // APP=admin runs the catalog admin's load test instead of Dispatch's.
    const script = config.env.APP === 'admin' ? 'tools/perf/admin-load.sh' : 'tools/perf/load.sh'
    const run = spawnSync('bash', [join(root, script), sessions, '1', seconds], {
      env: { ...process.env, ...config.env },
      encoding: 'utf8',
    })
    const line = run.stdout.split('\n').find(text => text.startsWith('RESULT '))
    if (line === undefined) {
      console.log(`round ${round} ${config.label}: no result`)
      continue
    }
    const result = { label: config.label, round, at: new Date().toISOString(), ...JSON.parse(line.slice(7)) }
    results.get(config.label).push(result)
    appendFileSync(join(root, 'output/perf-matrix.jsonl'), `${JSON.stringify(result)}\n`)
    console.log(`round ${round} ${config.label}: p95 ${result.latencyP95} ms, render ${result.renderMean} ms, CPU ${result.cpuPercentOfOneCore}%, answer p95 ${result.answerP95} ms`)
  }
}

const median = values => {
  const sorted = values.filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  return sorted.length === 0 ? NaN : sorted[Math.floor((sorted.length - 1) / 2)]
}
console.log(`\nmedians over ${rounds} rounds, ${sessions} pages, 1 change/s:`)
console.log('| config | p50 ms | p95 ms | p99 ms | render ms | CPU % | missed | events/s | answer p50 | answer p95 | patch kB/s | wire kB/s | RSS/page kB |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const [label, runs] of results) {
  const pick = key => median(runs.map(run => run[key]))
  console.log(
    `| ${label} | ${pick('latencyP50')} | ${pick('latencyP95')} | ${pick('latencyP99')} | ${pick('renderMean')} | ${pick('cpuPercentOfOneCore')} | ${pick('missedUpdates')} | ${pick('eventsPerSecond')} | ${pick('answerP50')} | ${pick('answerP95')} | ${pick('patchKbPerSecond')} | ${pick('wireKbPerSecond')} | ${pick('rssPerSessionKb')} |`,
  )
}
