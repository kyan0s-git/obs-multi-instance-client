import { createHash } from 'node:crypto'
import { deflateRaw, inflateRaw } from 'node:zlib'
import { promisify } from 'node:util'

const deflate = promisify(deflateRaw)
const inflate = promisify(inflateRaw)

/**
 * A minimal ZIP reader and writer.
 *
 * Bundles are how a fleet configuration leaves this machine — handed to a
 * colleague, checked into a show repo, restored after a rebuild — so the
 * format has to be one anything can open. ZIP is that format, and the subset
 * needed here (store and deflate, no encryption, no spanning) is small enough
 * to implement directly rather than take a dependency for.
 *
 * Deliberate limits: no ZIP64, so a bundle is capped at 4 GB and 65535
 * entries. Configuration bundles are kilobytes; the cap is checked and
 * reported rather than silently producing a corrupt archive.
 */

export interface ZipEntry {
  /** Forward-slash path inside the archive. */
  path: string
  data: Buffer
  /** Modification time, defaulting to now. */
  mtime?: Date
}

export interface ZipReadEntry {
  path: string
  data: Buffer
  mtime: Date
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_END = 0x06054b50

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

const MAX_ENTRIES = 0xffff
const MAX_SIZE = 0xffffffff

/** Files below this rarely compress enough to be worth the CPU. */
const MIN_DEFLATE_BYTES = 256

/* ------------------------------------------------------------------ */
/* CRC-32                                                              */
/* ------------------------------------------------------------------ */

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/* ------------------------------------------------------------------ */
/* MS-DOS date/time                                                    */
/* ------------------------------------------------------------------ */

function toDosTime(date: Date): { time: number; date: number } {
  // DOS timestamps have two-second resolution and a 1980 epoch.
  const year = Math.max(1980, date.getFullYear())
  return {
    time:
      (Math.floor(date.getSeconds() / 2) & 0x1f) |
      ((date.getMinutes() & 0x3f) << 5) |
      ((date.getHours() & 0x1f) << 11),
    date:
      (date.getDate() & 0x1f) |
      (((date.getMonth() + 1) & 0x0f) << 5) |
      (((year - 1980) & 0x7f) << 9)
  }
}

function fromDosTime(time: number, date: number): Date {
  return new Date(
    1980 + ((date >> 9) & 0x7f),
    ((date >> 5) & 0x0f) - 1,
    date & 0x1f,
    (time >> 11) & 0x1f,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2
  )
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Builds a ZIP archive in memory.
 *
 * Each entry is deflated unless it is tiny or deflate fails to shrink it, in
 * which case it is stored — the same decision every ZIP writer makes, and it
 * keeps already-compressed media from growing.
 */
export async function createZip(entries: ZipEntry[]): Promise<Buffer> {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`A bundle can hold at most ${MAX_ENTRIES} files (got ${entries.length})`)
  }

  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuffer = Buffer.from(normalizePath(entry.path), 'utf8')
    if (nameBuffer.length > 0xffff) {
      throw new Error(`Path too long for a ZIP entry: ${entry.path}`)
    }

    const raw = entry.data
    if (raw.length > MAX_SIZE) {
      throw new Error(`File too large for a non-ZIP64 bundle: ${entry.path}`)
    }

    let method = METHOD_STORE
    let payload = raw

    if (raw.length >= MIN_DEFLATE_BYTES) {
      const compressed = await deflate(raw, { level: 6 })
      // Only pay the decompression cost if it actually saved space.
      if (compressed.length < raw.length) {
        method = METHOD_DEFLATE
        payload = compressed
      }
    }

    const crc = crc32(raw)
    const { time, date } = toDosTime(entry.mtime ?? new Date())

    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4) // version needed
    // Bit 11 marks the name as UTF-8, which matters for non-ASCII filenames.
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28) // extra field length

    localParts.push(local, nameBuffer, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(SIG_CENTRAL, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk number
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)

    centralParts.push(central, nameBuffer)
    offset += local.length + nameBuffer.length + payload.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(SIG_END, 0)
  end.writeUInt16LE(0, 4) // disk number
  end.writeUInt16LE(0, 6) // central directory start disk
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...localParts, centralDirectory, end])
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/**
 * Reads a ZIP archive from memory.
 *
 * Entries are read through the central directory rather than by scanning for
 * local headers, which is what the spec says to do and what makes the result
 * trustworthy when an archive has been appended to.
 */
export async function readZip(buffer: Buffer): Promise<ZipReadEntry[]> {
  const end = findEndOfCentralDirectory(buffer)
  if (end === -1) throw new Error('Not a ZIP archive (no end-of-central-directory record)')

  const entryCount = buffer.readUInt16LE(end + 10)
  const centralSize = buffer.readUInt32LE(end + 12)
  const centralOffset = buffer.readUInt32LE(end + 16)

  if (centralOffset + centralSize > buffer.length) {
    throw new Error('ZIP central directory is truncated')
  }

  const entries: ZipReadEntry[] = []
  let cursor = centralOffset

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new Error(`ZIP central directory entry ${index} is malformed`)
    }

    const method = buffer.readUInt16LE(cursor + 10)
    const time = buffer.readUInt16LE(cursor + 12)
    const date = buffer.readUInt16LE(cursor + 14)
    const expectedCrc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)

    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength

    // Directory entries carry no data.
    if (name.endsWith('/')) continue

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`ZIP local header for "${name}" is malformed`)
    }

    // The local header's name and extra lengths are authoritative for locating
    // the payload; they can legitimately differ from the central directory's.
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize

    if (dataEnd > buffer.length) throw new Error(`ZIP entry "${name}" is truncated`)

    const payload = buffer.subarray(dataStart, dataEnd)
    let data: Buffer

    if (method === METHOD_STORE) {
      data = Buffer.from(payload)
    } else if (method === METHOD_DEFLATE) {
      data = await inflate(payload)
    } else {
      throw new Error(`ZIP entry "${name}" uses unsupported compression method ${method}`)
    }

    if (data.length !== uncompressedSize) {
      throw new Error(`ZIP entry "${name}" has the wrong length after decompression`)
    }
    // A bundle that has been corrupted in transit should fail loudly rather
    // than importing subtly wrong configuration into a live fleet.
    if (crc32(data) !== expectedCrc) {
      throw new Error(`ZIP entry "${name}" failed its checksum`)
    }

    entries.push({ path: name, data, mtime: fromDosTime(time, date) })
  }

  return entries
}

/**
 * Locates the end-of-central-directory record.
 *
 * It sits at the end of the file but may be followed by a variable-length
 * comment, so the tail is scanned backwards.
 */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = 22
  if (buffer.length < minimum) return -1

  const searchStart = Math.max(0, buffer.length - (minimum + 0xffff))
  for (let index = buffer.length - minimum; index >= searchStart; index -= 1) {
    if (buffer.readUInt32LE(index) === SIG_END) return index
  }
  return -1
}

/**
 * Normalises a path for storage: forward slashes, no leading slash, no `..`.
 *
 * Refusing traversal at write time is belt-and-braces; the import path checks
 * again, because a bundle can come from anywhere.
 */
export function normalizePath(input: string): string {
  const normalized = input.replace(/\\/g, '/').replace(/^\/+/, '')
  const segments = normalized.split('/').filter((part) => part !== '' && part !== '.')
  if (segments.includes('..')) {
    throw new Error(`Refusing a bundle path containing "..": ${input}`)
  }
  return segments.join('/')
}

/** Rejects an archive path that would escape the extraction root. */
export function isSafeBundlePath(input: string): boolean {
  if (input.includes('\0')) return false
  const segments = input.replace(/\\/g, '/').split('/')
  if (segments.some((part) => part === '..')) return false
  // An absolute path or a Windows drive letter must never be honoured.
  if (input.startsWith('/') || /^[A-Za-z]:/.test(input)) return false
  return true
}

/** Stable digest of a bundle's contents, for the manifest. */
export function bundleDigest(entries: ZipEntry[]): string {
  const hash = createHash('sha1')
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path)
    hash.update(entry.data)
  }
  return hash.digest('hex')
}
