import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Schema as S } from 'effect'

import { listFiles } from './files.ts'

/* Line diffs of an extension's files, for the person who reviews a run:
   what the live folder holds against what the run would install. Plain
   data, so a page can keep it in its Model. */

export const DiffLine = S.Struct({
  /** `gap` stands for unchanged lines left out; `text` says how many. */
  kind: S.Literals(['same', 'added', 'removed', 'gap']),
  text: S.String,
})
export type DiffLine = typeof DiffLine.Type

export const FileDiff = S.Struct({
  extension: S.String,
  /** The file's path in the extension's folder, with `/`. */
  path: S.String,
  action: S.Literals(['added', 'changed', 'removed']),
  added: S.Number,
  removed: S.Number,
  /** The changed lines with three lines around each; null for a file that
   *  is not text. */
  lines: S.NullOr(S.Array(DiffLine)),
  /** Whether lines were left out because the file's diff is long. */
  truncated: S.Boolean,
})
export type FileDiff = typeof FileDiff.Type

const CONTEXT = 3
const MAX_LINES = 400
/** Above this many cells the files are shown as removed and added whole. */
const MAX_CELLS = 4_000_000

const splitLines = (text: string): ReadonlyArray<string> => {
  const lines = text.split(/\r?\n/)
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines
}

type Edit = Readonly<{ kind: 'same' | 'added' | 'removed'; text: string }>

/** The edits that turn `a` into `b`: a longest common subsequence, after
 *  the common start and end are taken off. */
export const diffLines = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): ReadonlyArray<Edit> => {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const head = a.slice(0, start).map((text): Edit => ({ kind: 'same', text }))
  const tail = a.slice(endA).map((text): Edit => ({ kind: 'same', text }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const n = midA.length
  const m = midB.length
  if (n * m > MAX_CELLS) {
    return [
      ...head,
      ...midA.map((text): Edit => ({ kind: 'removed', text })),
      ...midB.map((text): Edit => ({ kind: 'added', text })),
      ...tail,
    ]
  }
  // lengths[i * (m + 1) + j]: the LCS of midA[i..] and midB[j..].
  const lengths = new Uint32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * (m + 1) + j] =
        midA[i] === midB[j]
          ? lengths[(i + 1) * (m + 1) + j + 1]! + 1
          : Math.max(lengths[(i + 1) * (m + 1) + j]!, lengths[i * (m + 1) + j + 1]!)
    }
  }
  const middle: Array<Edit> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      middle.push({ kind: 'same', text: midA[i]! })
      i++
      j++
    } else if (lengths[(i + 1) * (m + 1) + j]! >= lengths[i * (m + 1) + j + 1]!) {
      middle.push({ kind: 'removed', text: midA[i++]! })
    } else {
      middle.push({ kind: 'added', text: midB[j++]! })
    }
  }
  while (i < n) middle.push({ kind: 'removed', text: midA[i++]! })
  while (j < m) middle.push({ kind: 'added', text: midB[j++]! })
  return [...head, ...middle, ...tail]
}

/** The changed lines with `CONTEXT` lines around them; runs of unchanged
 *  lines in between become one `gap` line. */
const withContext = (edits: ReadonlyArray<Edit>): ReadonlyArray<DiffLine> => {
  const near = new Array<boolean>(edits.length).fill(false)
  edits.forEach((edit, index) => {
    if (edit.kind === 'same') return
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(edits.length - 1, index + CONTEXT); k++) near[k] = true
  })
  const lines: Array<DiffLine> = []
  let skipped = 0
  const flush = () => {
    if (skipped > 0) lines.push({ kind: 'gap', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}` })
    skipped = 0
  }
  edits.forEach((edit, index) => {
    if (!near[index]) {
      skipped++
      return
    }
    flush()
    lines.push(edit)
  })
  flush()
  return lines
}

const isText = (buffer: Buffer) => !buffer.subarray(0, 8000).includes(0)

/** The diff of one file; null when it did not change. */
export const diffFile = (extension: string, path: string, before: Buffer | null, after: Buffer | null): FileDiff | null => {
  if (before !== null && after !== null && Buffer.compare(before, after) === 0) return null
  if (before === null && after === null) return null
  const action = before === null ? 'added' : after === null ? 'removed' : 'changed'
  if ((before !== null && !isText(before)) || (after !== null && !isText(after))) {
    return { extension, path, action, added: 0, removed: 0, lines: null, truncated: false }
  }
  const edits = diffLines(splitLines(before?.toString('utf8') ?? ''), splitLines(after?.toString('utf8') ?? ''))
  const lines = withContext(edits)
  return {
    extension,
    path,
    action,
    added: edits.filter(edit => edit.kind === 'added').length,
    removed: edits.filter(edit => edit.kind === 'removed').length,
    lines: lines.slice(0, MAX_LINES),
    truncated: lines.length > MAX_LINES,
  }
}

/** The diffs of every file that differs between `before/<id>` and
 *  `after/<id>`, for each id. A missing folder counts as empty. */
export const diffFolders = async (before: string, after: string, ids: ReadonlyArray<string>): Promise<ReadonlyArray<FileDiff>> => {
  const diffs: Array<FileDiff> = []
  for (const id of ids) {
    const files = [...new Set([...(await listFiles(join(before, id))), ...(await listFiles(join(after, id)))])].sort()
    for (const file of files) {
      const read = (folder: string) => readFile(join(folder, id, file)).catch(() => null)
      const diff = diffFile(id, file, await read(before), await read(after))
      if (diff !== null) diffs.push(diff)
    }
  }
  return diffs
}
