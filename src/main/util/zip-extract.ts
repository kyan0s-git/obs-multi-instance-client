import fsp from 'node:fs/promises'
import path from 'node:path'
import { createInflateRaw } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { ensureDir } from './fsx.js'
import { isSafeBundlePath, normalizePath } from './zip.js'

/**
 * Extracts a ZIP straight from disk, one entry at a time.
 *
 * `readZip` in `util/zip.ts` takes a Buffer, which is right for configuration
 * bundles measured in kilobytes. An OBS release is about 150 MB, and on a
 * machine already running eight OBS instances, holding the archive plus its
 * inflated output in memory is not a reasonable thing to do. This reads the
 * central directory through a file handle and streams each entry to its
 * destination, so peak memory is one entry rather than one archive.
 *
 * Same format subset as the writer: store and deflate, no ZIP64, no
 * encryption. Anything else is reported rather than silently mis-extracted.
 */

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_END = 0x06054b50

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** The end-of-central-directory record sits within 64 KB of the file's end. */
const EOCD_SEARCH_BYTES = 66 * 1024

export interface ExtractProgress {
  entriesDone: number
  entriesTotal: number
  bytesWritten: number
}

export interface ExtractOptions {
  /** Drop this many leading path segments, e.g. a single wrapping folder. */
  stripComponents?: number
  onProgress?: (progress: ExtractProgress) => void
  signal?: AbortSignal
}

export interface ExtractResult {
  files: number
  bytes: number
}

interface CentralEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

export async function extractZipFile(
  archivePath: string,
  destination: string,
  options: ExtractOptions = {}
): Promise<ExtractResult> {
  const handle = await fsp.open(archivePath, 'r')

  try {
    const { size } = await handle.stat()
    const entries = await readCentralDirectory(handle, size)

    await ensureDir(destination)
    const root = path.resolve(destination)

    let files = 0
    let bytes = 0

    for (const entry of entries) {
      options.signal?.throwIfAborted()

      const relative = strip(entry.name, options.stripComponents ?? 0)
      if (relative === null) continue

      // The archive is remote input. Refuse anything that would escape the
      // destination, before and after resolution — same rule as bundle import.
      if (!isSafeBundlePath(relative)) {
        throw new Error(`Archive entry "${entry.name}" has an unsafe path`)
      }

      const target = path.resolve(root, relative)
      if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error(`Archive entry "${entry.name}" resolves outside the destination`)
      }

      await ensureDir(path.dirname(target))
      bytes += await writeEntry(handle, entry, target)
      files += 1

      options.onProgress?.({ entriesDone: files, entriesTotal: entries.length, bytesWritten: bytes })
    }

    return { files, bytes }
  } finally {
    await handle.close()
  }
}

/** Reads and parses the central directory without loading the archive. */
async function readCentralDirectory(
  handle: fsp.FileHandle,
  size: number
): Promise<CentralEntry[]> {
  const tailLength = Math.min(EOCD_SEARCH_BYTES, size)
  const tail = Buffer.alloc(tailLength)
  await handle.read(tail, 0, tailLength, size - tailLength)

  let eocd = -1
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === SIG_END) {
      eocd = offset
      break
    }
  }
  if (eocd === -1) throw new Error('Not a ZIP archive (no end-of-central-directory record)')

  const entryCount = tail.readUInt16LE(eocd + 10)
  const centralSize = tail.readUInt32LE(eocd + 12)
  const centralOffset = tail.readUInt32LE(eocd + 16)

  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported')
  }

  const central = Buffer.alloc(centralSize)
  await handle.read(central, 0, centralSize, centralOffset)

  const entries: CentralEntry[] = []
  let cursor = 0

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new Error(`ZIP central directory entry ${index} is malformed`)
    }

    const method = central.readUInt16LE(cursor + 10)
    const compressedSize = central.readUInt32LE(cursor + 20)
    const uncompressedSize = central.readUInt32LE(cursor + 24)
    const nameLength = central.readUInt16LE(cursor + 28)
    const extraLength = central.readUInt16LE(cursor + 30)
    const commentLength = central.readUInt16LE(cursor + 32)
    const localOffset = central.readUInt32LE(cursor + 42)

    const name = central.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength

    // Directory entries carry no data; the tree is made from the file paths.
    if (name.endsWith('/')) continue

    entries.push({ name, method, compressedSize, uncompressedSize, localOffset })
  }

  return entries
}

/** Streams one entry out of the archive and into place. */
async function writeEntry(
  handle: fsp.FileHandle,
  entry: CentralEntry,
  target: string
): Promise<number> {
  const header = Buffer.alloc(30)
  await handle.read(header, 0, 30, entry.localOffset)

  if (header.readUInt32LE(0) !== SIG_LOCAL) {
    throw new Error(`ZIP local header for "${entry.name}" is malformed`)
  }

  // The local header's lengths are authoritative for locating the payload;
  // they can legitimately differ from the central directory's.
  const nameLength = header.readUInt16LE(26)
  const extraLength = header.readUInt16LE(28)
  const dataStart = entry.localOffset + 30 + nameLength + extraLength

  if (entry.method !== METHOD_STORE && entry.method !== METHOD_DEFLATE) {
    throw new Error(`Archive entry "${entry.name}" uses unsupported compression method ${entry.method}`)
  }

  const source = handle.createReadStream({
    start: dataStart,
    end: dataStart + entry.compressedSize - 1,
    autoClose: false
  })

  const sink = createWriteStream(target)

  if (entry.method === METHOD_DEFLATE) {
    await pipeline(source, createInflateRaw(), sink)
  } else {
    await pipeline(source, sink)
  }

  return entry.uncompressedSize
}

/**
 * Removes leading path segments.
 *
 * Release archives wrap everything in a single top-level folder whose name
 * carries the version, which would otherwise end up in every install path.
 * Returns `null` for an entry that lives entirely within the stripped prefix.
 */
function strip(name: string, count: number): string | null {
  const normalized = normalizePath(name)
  if (count <= 0) return normalized

  const segments = normalized.split('/')
  if (segments.length <= count) return null
  return segments.slice(count).join('/')
}
