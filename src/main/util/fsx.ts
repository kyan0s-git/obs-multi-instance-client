import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}

export async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile()
  } catch {
    return false
  }
}

export async function ensureDir(target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true })
}

export async function readJson<T>(target: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8')) as T
  } catch {
    return null
  }
}

/**
 * Writes JSON through a temp file + rename so a crash mid-write cannot leave
 * a half-serialised config behind.
 */
export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(target))
  const tmp = `${target}.${process.pid}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, target)
}

export async function writeTextAtomic(target: string, text: string): Promise<void> {
  await ensureDir(path.dirname(target))
  const tmp = `${target}.${process.pid}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, target)
}

export interface CopyOptions {
  /** Return false to exclude an entry (and its subtree) from the copy. */
  filter?: (src: string, rel: string) => boolean
  /** When false, existing destination files are left untouched. */
  overwrite?: boolean
  /** Follow symlinks instead of recreating them. */
  dereference?: boolean
}

/** Recursive copy that preserves symlinks by default and reports how much it moved. */
export async function copyTree(
  src: string,
  dest: string,
  options: CopyOptions = {}
): Promise<{ files: number; bytes: number }> {
  const { filter, overwrite = true, dereference = false } = options
  let files = 0
  let bytes = 0

  async function walk(from: string, to: string, rel: string): Promise<void> {
    const stat = dereference ? await fs.stat(from) : await fs.lstat(from)

    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(from)
      await fs.rm(to, { force: true, recursive: true }).catch(() => undefined)
      await fs.symlink(target, to)
      return
    }

    if (stat.isDirectory()) {
      await ensureDir(to)
      for (const entry of await fs.readdir(from)) {
        const childRel = rel === '' ? entry : `${rel}/${entry}`
        if (filter && !filter(path.join(from, entry), childRel)) continue
        await walk(path.join(from, entry), path.join(to, entry), childRel)
      }
      return
    }

    if (!stat.isFile()) return
    if (!overwrite && (await pathExists(to))) return
    await ensureDir(path.dirname(to))
    await fs.copyFile(from, to)
    files += 1
    bytes += stat.size
  }

  await walk(src, dest, '')
  return { files, bytes }
}

/** SHA-1 of a file's bytes. Cheap, and only ever used for change detection. */
export async function hashFile(target: string): Promise<string> {
  const hash = createHash('sha1')
  hash.update(await fs.readFile(target))
  return hash.digest('hex')
}

/**
 * Content hash of a whole directory. Paths are sorted so the digest is stable
 * across filesystems that enumerate in different orders.
 */
export async function hashTree(root: string): Promise<string> {
  const hash = createHash('sha1')
  const entries: string[] = []

  async function walk(dir: string, rel: string): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return
    }
    for (const name of names.sort()) {
      const abs = path.join(dir, name)
      const childRel = rel === '' ? name : `${rel}/${name}`
      const stat = await fs.lstat(abs).catch(() => null)
      if (!stat) continue
      if (stat.isDirectory()) await walk(abs, childRel)
      else if (stat.isFile()) entries.push(`${childRel}:${await hashFile(abs)}`)
    }
  }

  await walk(root, '')
  for (const entry of entries) hash.update(`${entry}\n`)
  return hash.digest('hex')
}

export async function dirSize(root: string): Promise<number> {
  let total = 0
  async function walk(dir: string): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      const abs = path.join(dir, name)
      const stat = await fs.lstat(abs).catch(() => null)
      if (!stat) continue
      if (stat.isDirectory()) await walk(abs)
      else if (stat.isFile()) total += stat.size
    }
  }
  await walk(root)
  return total
}

/** Recursive delete that never throws when the target is already gone. */
export async function removeQuiet(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * OBS derives on-disk names from display names by dropping characters that are
 * illegal in a path. Mirrors `os_generate_safe_filename` behaviour closely
 * enough for us to locate an existing profile folder.
 */
export function slugifyObsName(name: string): string {
  return name
    .replace(/[<>:"/\\|?* -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Appends " (2)", " (3)" and so on until the candidate name is unused. */
export function uniqueName(desired: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(desired)) return desired
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${desired} (${n})`
    if (!used.has(candidate)) return candidate
  }
  return `${desired} (${Date.now()})`
}

/** Turns an instance name into a filesystem-safe folder name. */
export function safeFolderName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned === '' ? 'instance' : cleaned.slice(0, 64)
}
