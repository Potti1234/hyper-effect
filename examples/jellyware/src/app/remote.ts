import { remoteService } from '@hyper-effect/jellyware'

import { Viewers, Workspace } from './store'

/* What an extension in its own process may use of the app's services
   (the loader's `isolation` option, src/main.ts): the server serves these
   members, the extension's process gets stand-ins of the same shape. The
   page host, the registry and the key-value store come on top.

   This is the extension's whole reach into the app: no `setRole` (giving
   the administrator role) and no `remove` (deleting issues). The bundle of
   every extension imports this module. */

export const remoteServices = [
  remoteService(Workspace, {
    current: 'value',
    changes: 'stream',
    memberFor: 'call',
    create: 'call',
    update: 'call',
    comment: 'call',
    setTheme: 'call',
  }),
  remoteService(Viewers, { join: 'scoped', of: 'callStream' }),
]
