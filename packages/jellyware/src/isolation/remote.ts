import type { Context } from 'effect'

/* How an app's service crosses to an extension's process: per member,
   which kind of thing it is. The app lists its services once (in a module
   both the server and the extension's bundle import); the server serves
   them, the extension's process gets a stand-in of the same shape.

   - `value`: an Effect without arguments (`current`);
   - `stream`: a Stream without arguments (`changes`);
   - `call`: a function returning an Effect (`update(changes, actorId)`);
   - `callStream`: a function returning a Stream (`of(issueId)`);
   - `scoped`: a function returning an Effect that needs a Scope, held
     until the extension's scope closes (`join(issueId, memberId)`).

   Arguments, values and failures cross as copies (structured clone): plain
   data such as Schema values. A tagged failure arrives as a plain object
   with its `_tag`. */

export type MemberKind = 'value' | 'stream' | 'call' | 'callStream' | 'scoped'

export type RemoteService = Readonly<{
  key: Context.Key<unknown, unknown>
  members: Readonly<Record<string, MemberKind>>
}>

/** Describes a service for extensions in their own process. Members not
 *  listed are not available there. */
export const remoteService = <I, S>(key: Context.Key<I, S>, members: { readonly [K in keyof S]?: MemberKind }): RemoteService => ({
  key,
  members: Object.fromEntries(Object.entries(members).filter((entry): entry is [string, MemberKind] => typeof entry[1] === 'string')),
})
