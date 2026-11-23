import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/* Folder helpers for the loader and the change pipeline: content hashes of
   an extension folder, and copies that make one folder equal to another. */

/** Every file below `folder`, as paths relative to it with `/`, sorted. */
export const listFiles = async (folder: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => entry.isFile())
    .map(entry => relative(folder, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
}

/** A hash of the folder's file names and contents; null when it does not
 *  exist. */
export const hashFolder = async (folder: string): Promise<string | null> => {
  const exists = await stat(folder).then(info => info.isDirectory(), () => false)
  if (!exists) return null
  const hash = createHash('sha256')
  for (const file of await listFiles(folder)) {
    hash.update(file).update('\0').update(await readFile(join(folder, file))).update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

/** The extension folders (direct subfolders) of `directory`, sorted. */
export const listFolders = async (directory: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort()
}

/** Makes `target` hold exactly the files of `source`, without removing the
 *  folder itself in between (a watcher would see the extension vanish). A
 *  missing `source` removes `target`. */
export const mirrorFolder = async (source: string, target: string): Promise<void> => {
  if ((await hashFolder(source)) === null) {
    await rm(target, { recursive: true, force: true })
    return
  }
  await mkdir(target, { recursive: true })
  const wanted = new Set(await listFiles(source))
  for (const file of await listFiles(target)) {
    if (!wanted.has(file)) await rm(join(target, file), { force: true })
  }
  for (const file of wanted) {
    const from = await readFile(join(source, file))
    const to = await readFile(join(target, file)).catch(() => null)
    if (to !== null && Buffer.compare(from, to) === 0) continue
    // Written in place, as an editor saves: a watcher sees a change, not a
    // file removed and added again.
    await mkdir(join(target, file, '..'), { recursive: true })
    await writeFile(join(target, file), from)
  }
}

/** Copies a folder; a missing `source` copies nothing. */
export const copyFolder = async (source: string, target: string): Promise<void> => {
  if ((await hashFolder(source)) === null) return
  await cp(source, target, { recursive: true })
}
