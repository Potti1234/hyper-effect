import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/* A pi extension (https://github.com/badlogic/pi-mono, docs/extensions.md)
   that keeps the agent's file tools where a run may work. pi loads it with
   `-e` next to `--no-extensions` (src/app/agent.ts); its configuration
   comes in the environment variable JELLYWARE_GUARD as JSON `Guard`.

   - `write` and `edit` only inside the stage (the run's copy of
     extensions/).
   - `read`, `grep`, `find` and `ls` inside the stage, or inside one of the
     read roots (the repository) but not in a folder named in `hidden`
     (`.jellyware` holds other runs and pi's credentials during a run;
     `.git`, `.hyper-sessions` and `.env` files).

   Paths are resolved as pi resolves them (relative to the stage, `~` for
   the home folder, a leading `@` dropped), through symbolic links where
   the path exists, and the call gets the resolved path, so pi uses exactly
   the path that was checked. Calls of other tools are refused: the run
   gives pi only these six.

   pi loads this file itself (with jiti), so it imports only Node's
   modules. */

export type Guard = Readonly<{
  /** The folder the agent may change. */
  stage: string
  /** Folders the agent may read besides the stage. */
  read: ReadonlyArray<string>
  /** Folder or file names never read under the read roots; a name ending
   *  in `*` matches names that start with it. */
  hidden: ReadonlyArray<string>
}>

export type Decision = Readonly<{ block: true; reason: string }> | Readonly<{ block: false; path: string | null }>

const WRITE_TOOLS = new Set(['write', 'edit'])
const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls'])
const SPACES = /[  -   　]/g

const caseless = process.platform === 'win32' || process.platform === 'darwin'
const key = (path: string) => (caseless ? path.toLowerCase() : path)

/** Whether `path` is `folder` or inside it. */
const inside = (path: string, folder: string) => {
  const from = relative(key(folder), key(path))
  return from === '' || (!from.startsWith('..') && !isAbsolute(from))
}

/** The real path: symbolic links resolved for the part that exists. */
const real = (path: string): string => {
  try {
    return realpathSync.native(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : resolve(real(parent), path.slice(parent.length + 1))
  }
}

/** The absolute path pi would use for `input`, relative to `cwd`. */
export const resolvePath = (input: string, cwd: string): string => {
  let path = input.replace(SPACES, ' ')
  if (path.startsWith('@')) path = path.slice(1)
  if (path === '~') path = homedir()
  else if (path.startsWith('~/') || path.startsWith('~\\')) path = resolve(homedir(), path.slice(2))
  return real(resolve(cwd, path))
}

const hiddenName = (name: string, hidden: ReadonlyArray<string>) =>
  hidden.some(rule => (rule.endsWith('*') ? key(name).startsWith(key(rule.slice(0, -1))) : key(name) === key(rule)))

/** What to do with one tool call of the agent, whose working folder is
 *  `cwd`. */
export const decide = (tool: string, input: Readonly<Record<string, unknown>>, guard: Guard, cwd: string): Decision => {
  const writes = WRITE_TOOLS.has(tool)
  if (!writes && !READ_TOOLS.has(tool)) return { block: true, reason: `The tool ${tool} is not available in this run.` }
  const given = input['path']
  if (given !== undefined && typeof given !== 'string') return { block: true, reason: 'The path must be a string.' }
  // grep, find and ls default to the working folder.
  const path = resolvePath(given ?? '.', cwd)
  const stage = real(resolve(guard.stage))
  if (inside(path, stage)) return { block: false, path: given === undefined ? null : path }
  if (writes) {
    return { block: true, reason: `${path} is outside the extensions you are changing (${stage}). Change files only there.` }
  }
  const root = guard.read.map(folder => real(resolve(folder))).find(folder => inside(path, folder))
  if (root === undefined) {
    return { block: true, reason: `${path} is outside the folders this run may read.` }
  }
  const names = relative(root, path).split(sep).filter(name => name !== '')
  if (names.some(name => hiddenName(name, guard.hidden))) {
    return { block: true, reason: `${path} is not readable in this run.` }
  }
  return { block: false, path: given === undefined ? null : path }
}

type ToolCall = { toolName: string; input: Record<string, unknown> }
type Pi = {
  on: (
    event: 'tool_call',
    handler: (event: ToolCall, context: { cwd: string }) => Promise<{ block: true; reason: string } | undefined>,
  ) => void
}

const strings = (value: unknown): ReadonlyArray<string> | null =>
  Array.isArray(value) && value.every(each => typeof each === 'string') ? value : null

/** The configuration from JSON, or null when it is missing or malformed. */
export const parseGuard = (text: string | undefined): Guard | null => {
  if (text === undefined) return null
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) return null
    const stage: unknown = Reflect.get(value, 'stage')
    const read = strings(Reflect.get(value, 'read'))
    const hidden = strings(Reflect.get(value, 'hidden'))
    return typeof stage === 'string' && read !== null && hidden !== null ? { stage, read, hidden } : null
  } catch {
    return null
  }
}

export default function guard(pi: Pi) {
  // Without a valid configuration nothing is allowed: a misconfigured run
  // stops at its first tool call instead of running unguarded.
  const settings = parseGuard(process.env['JELLYWARE_GUARD'])
  pi.on('tool_call', async (event, context) => {
    if (settings === null) return { block: true, reason: 'The run has no JELLYWARE_GUARD configuration.' }
    const decision = decide(event.toolName, event.input, settings, context.cwd)
    if (decision.block) return { block: true, reason: decision.reason }
    if (decision.path !== null) event.input['path'] = decision.path
    return undefined
  })
}
