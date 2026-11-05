import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

/* Process-wide render and session metrics, served as JSON by `metricsRoute`.
   Cheap enough to stay on: a counter, a sum and a ring buffer of samples. */

// Event-loop lag and utilization, sampled every second, for observability.
// (An experiment paced renders by utilization; it delayed healthy fan-outs and
// was removed: per-stream conflation already prevents backlogs.)
const loopDelay = monitorEventLoopDelay({ resolution: 10 })
loopDelay.enable()
let lagMillis = 0
let utilization = 0
let lastUtilization = performance.eventLoopUtilization()
setInterval(() => {
  lagMillis = loopDelay.mean / 1e6
  loopDelay.reset()
  const now = performance.eventLoopUtilization()
  utilization = performance.eventLoopUtilization(now, lastUtilization).utilization
  lastUtilization = now
}, 1000).unref()

const SAMPLE_CAPACITY = 2048

let renders = 0
let renderMillis = 0
let renderMaxMillis = 0
let patchBytes = 0
let wireBytes = 0
let patches = 0
let regionPatches = 0
let regionRenders = 0
let regionUnchanged = 0
let regionKept = 0
const samples = new Float64Array(SAMPLE_CAPACITY)
let sampleCount = 0

type ProgramCounts = Readonly<{ sessions: number; connections: number; handlerTables: number; regions: number }>

const programs = new Map<string, () => ProgramCounts>()
/** Process-wide sizes reported by other modules (caches), for soak tests. */
const gauges = new Map<string, () => number>()

export const registerGauge = (name: string, read: () => number): void => {
  gauges.set(name, read)
}

export const recordRender = (millis: number): void => {
  renders += 1
  renderMillis += millis
  renderMaxMillis = Math.max(renderMaxMillis, millis)
  samples[sampleCount % SAMPLE_CAPACITY] = millis
  sampleCount += 1
}

/** A patch sent on a stream; `regionsOnly` when it carried changed regions
 *  instead of the whole page. */
export const recordPatch = (bytes: number, regionsOnly = false): void => {
  patches += 1
  patchBytes += bytes
  if (regionsOnly) regionPatches += 1
}

/** Bytes a compressed stream wrote, after compression. */
export const recordWire = (bytes: number): void => {
  wireBytes += bytes
}

/** A region placed by a render: kept (deps unchanged, not rendered),
 *  unchanged (rendered, same markup, not sent) or rendered (new markup). */
export const recordRegion = (outcome: 'kept' | 'unchanged' | 'rendered'): void => {
  if (outcome === 'kept') regionKept += 1
  else if (outcome === 'unchanged') regionUnchanged += 1
  else regionRenders += 1
}

/** Server layers report their live session and connection counts, and what
 *  their sessions retain. */
export const registerProgram = (name: string, counts: () => ProgramCounts): void => {
  programs.set(name, counts)
}

const percentile = (sorted: Float64Array, p: number): number =>
  sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0)

export const snapshot = () => {
  const recent = samples.slice(0, Math.min(sampleCount, SAMPLE_CAPACITY)).sort()
  // With --expose-gc, measure live memory rather than garbage awaiting collection.
  const gc = (globalThis as { gc?: () => void }).gc
  gc?.()
  const memory = process.memoryUsage()
  const cpu = process.cpuUsage()
  return {
    renders,
    renderMeanMillis: renders === 0 ? 0 : renderMillis / renders,
    renderP50Millis: percentile(recent, 0.5),
    renderP95Millis: percentile(recent, 0.95),
    renderMaxMillis,
    patches,
    patchBytes,
    wireBytes,
    regionPatches,
    regionRenders,
    regionUnchanged,
    regionKept,
    programs: Object.fromEntries([...programs].map(([name, counts]) => [name, counts()])),
    gauges: Object.fromEntries([...gauges].map(([name, read]) => [name, read()])),
    eventLoopLagMillis: lagMillis,
    eventLoopUtilization: utilization,
    heapUsedBytes: memory.heapUsed,
    rssBytes: memory.rss,
    cpuUserMicros: cpu.user,
    cpuSystemMicros: cpu.system,
  }
}

export const reset = (): void => {
  renders = 0
  renderMillis = 0
  renderMaxMillis = 0
  patchBytes = 0
  wireBytes = 0
  patches = 0
  regionPatches = 0
  regionRenders = 0
  regionUnchanged = 0
  regionKept = 0
  sampleCount = 0
}

/** Records a CPU profile of this process for `millis`, as `.cpuprofile` JSON. */
export const captureProfile = async (millis: number): Promise<string> => {
  const { Session } = await import('node:inspector/promises')
  const session = new Session()
  session.connect()
  try {
    await session.post('Profiler.enable')
    await session.post('Profiler.start')
    await new Promise(resolve => setTimeout(resolve, millis))
    const { profile } = await session.post('Profiler.stop')
    return JSON.stringify(profile)
  } finally {
    session.disconnect()
  }
}
