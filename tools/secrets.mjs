import { randomBytes } from 'node:crypto'

/* Secrets for the servers the tools start with NODE_ENV=production, which
   refuses the development fallbacks: the caller's own when set, otherwise one
   random value per run, shared by every node the run starts. */
export const secrets = Object.fromEntries(
  ['HYPER_SNAPSHOT_SECRET', 'APP_SECRET', 'DISPATCH_SECRET', 'ADMIN_SECRET'].map(name => [
    name,
    process.env[name] ?? randomBytes(32).toString('hex'),
  ]),
)
