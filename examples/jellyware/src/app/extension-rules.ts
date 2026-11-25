import type { ImportRules } from '@hyper-effect/jellyware'

/* What this app's extensions may import, checked before a run goes live
   (`importCheck` in @hyper-effect/jellyware). Effect's root module, Foldkit
   without its HTTP and experimental modules, the parts of hyper-effect and
   jellyware that pages and extensions need (not `fileStore`,
   `secretFromEnvironment` or the run pipeline), and the app modules listed
   in AGENTS.md. Not `#app/agent` or `#app/styles`: they run programs and
   watch files. */

export const importRules: ImportRules = {
  allow: [
    '=effect',
    'foldkit',
    {
      module: '@hyper-effect/core',
      names: [
        'PageHost',
        'PageNotFound',
        'PageRedirect',
        'keyBindings',
        'region',
        'shared',
        'memoizeLast',
        'sampleLatest',
        'foldkitUiCommands',
        'DISMISS_EVENT',
        'local',
      ],
    },
    {
      module: '@hyper-effect/jellyware',
      names: [
        'Badge',
        'BadgeTone',
        'Contributions',
        'DataError',
        'ExtensionData',
        'ExtensionSettings',
        'NavEntry',
        'SlotAction',
        'SlotCard',
        'SlotContent',
        'SlotItem',
      ],
    },
    '=#app/extensions',
    '=#app/domain',
    '=#app/store',
    '#app/view/*',
  ],
  // Test files: the test runner, Foldkit's Story and Scene (in `foldkit`),
  // serving a page over HTTP, and the seed data.
  testAllow: ['@effect/vitest', '=vitest', '=@hyper-effect/core/testing', '=#app/seed'],
  deny: ['foldkit/http', 'foldkit/experimental', 'foldkit/devTools', 'foldkit/runtime'],
}
