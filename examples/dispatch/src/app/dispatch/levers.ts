/* Performance levers of the Dispatch example, all on by default. Each can be
   switched off by an environment variable, so docs/performance.md's A/B
   measurements can be repeated (tools/perf/matrix.mjs):

   DISPATCH_AB_MEMO=0           every session builds its own store Messages
   DISPATCH_AB_SHAREDREGIONS=0  rows and activity render once per session
   DISPATCH_AB_SNAPDEPS=0       every Model change is snapshotted
   DISPATCH_AB_SNAPSHOTS=memory snapshots in memory instead of on disk
   DISPATCH_AB_SNAPSHOTS=postgres  snapshots in Postgres (DATABASE_URL)
   DISPATCH_AB_DURABLE=0        events are answered before their snapshot
                                (core's `durableEvents: false`)
   DISPATCH_AB_COMPRESSION=1    compressed event streams (core's
                                `compression`, off by default)

   (HYPER_VIEW_STACKS=1, a core switch, turns stack capture in views back on.) */

const off = (name: string) => process.env[name] === '0'

export const memoizeMessages = !off('DISPATCH_AB_MEMO')
export const sharedRegions = !off('DISPATCH_AB_SHAREDREGIONS')
export const snapshotOwnStateOnly = !off('DISPATCH_AB_SNAPDEPS')
export const snapshots: 'files' | 'memory' | 'postgres' =
  process.env['DISPATCH_AB_SNAPSHOTS'] === 'memory'
    ? 'memory'
    : process.env['DISPATCH_AB_SNAPSHOTS'] === 'postgres'
      ? 'postgres'
      : 'files'
export const durableEvents = !off('DISPATCH_AB_DURABLE')
export const compression = process.env['DISPATCH_AB_COMPRESSION'] === '1'
