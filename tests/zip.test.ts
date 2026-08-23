import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bundleDigest,
  crc32,
  createZip,
  isSafeBundlePath,
  normalizePath,
  readZip
} from '../src/main/util/zip'

const run = promisify(execFile)

/**
 * Bundles leave this machine and get opened by other tools, so a round trip
 * through our own reader is not sufficient evidence. Where the system `unzip`
 * is available these tests check against it too.
 */

let workdir: string

beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsfleet-zip-'))
})

afterEach(async () => {
  await fs.rm(workdir, { recursive: true, force: true })
})

async function hasUnzip(): Promise<boolean> {
  try {
    await run('unzip', ['-v'], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

describe('crc32', () => {
  it('matches the known check value for "123456789"', () => {
    // The standard CRC-32 check value, per the CRC catalogue.
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
  })

  it('is zero for empty input', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })
})

describe('createZip / readZip round trip', () => {
  it('preserves file contents and paths', async () => {
    const entries = [
      { path: 'manifest.json', data: Buffer.from('{"version":1}') },
      { path: 'profiles/Show/basic.ini', data: Buffer.from('[General]\nName=Show\n') },
      { path: 'scenes/Show.json', data: Buffer.from(JSON.stringify({ name: 'Show' })) }
    ]

    const archive = await createZip(entries)
    const read = await readZip(archive)

    expect(read.map((entry) => entry.path).sort()).toEqual(
      entries.map((entry) => entry.path).sort()
    )
    for (const original of entries) {
      const found = read.find((entry) => entry.path === original.path)
      expect(found?.data.toString()).toBe(original.data.toString())
    }
  })

  it('round-trips an empty file', async () => {
    const archive = await createZip([{ path: 'empty.txt', data: Buffer.alloc(0) }])
    const read = await readZip(archive)
    expect(read).toHaveLength(1)
    expect(read[0].data.length).toBe(0)
  })

  it('round-trips binary data with every byte value', async () => {
    const data = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    const archive = await createZip([{ path: 'bytes.bin', data }])
    const read = await readZip(archive)
    expect(read[0].data.equals(data)).toBe(true)
  })

  it('round-trips content large enough to be deflated', async () => {
    // Highly compressible, so this exercises the deflate path.
    const data = Buffer.from('the quick brown fox '.repeat(5000))
    const archive = await createZip([{ path: 'big.txt', data }])

    expect(archive.length).toBeLessThan(data.length / 2)
    const read = await readZip(archive)
    expect(read[0].data.equals(data)).toBe(true)
  })

  it('stores rather than inflates incompressible data', async () => {
    // Random bytes do not compress; the writer should fall back to store
    // instead of producing an archive larger than the input.
    const data = Buffer.from(
      Array.from({ length: 4096 }, () => Math.floor(Math.random() * 256))
    )
    const archive = await createZip([{ path: 'noise.bin', data }])
    const read = await readZip(archive)

    expect(read[0].data.equals(data)).toBe(true)
    expect(archive.length).toBeLessThan(data.length + 512)
  })

  it('round-trips non-ASCII paths', async () => {
    const archive = await createZip([
      { path: 'överlägg/lägre-tredjedel.html', data: Buffer.from('<p>hej</p>') }
    ])
    const read = await readZip(archive)
    expect(read[0].path).toBe('överlägg/lägre-tredjedel.html')
  })

  it('preserves modification times to DOS resolution', async () => {
    const mtime = new Date(2026, 4, 20, 13, 45, 30)
    const archive = await createZip([{ path: 'a.txt', data: Buffer.from('x'), mtime }])
    const read = await readZip(archive)

    // DOS timestamps have two-second granularity.
    expect(Math.abs(read[0].mtime.getTime() - mtime.getTime())).toBeLessThanOrEqual(2000)
  })

  it('handles an archive with many entries', async () => {
    const entries = Array.from({ length: 500 }, (_, i) => ({
      path: `dir${i % 10}/file-${i}.txt`,
      data: Buffer.from(`contents ${i}`)
    }))
    const read = await readZip(await createZip(entries))
    expect(read).toHaveLength(500)
  })
})

describe('corruption detection', () => {
  it('rejects a file that is not a ZIP', async () => {
    await expect(readZip(Buffer.from('definitely not a zip'))).rejects.toThrow(/not a zip/i)
  })

  it('rejects an entry whose bytes were altered', async () => {
    const data = Buffer.from('x'.repeat(64))
    const archive = await createZip([{ path: 'a.txt', data }])

    // Flip a byte inside the stored payload; the CRC must catch it.
    const localHeaderEnd = 30 + Buffer.byteLength('a.txt')
    archive[localHeaderEnd + 3] ^= 0xff

    await expect(readZip(archive)).rejects.toThrow(/checksum|length/i)
  })

  it('rejects a truncated archive', async () => {
    const archive = await createZip([{ path: 'a.txt', data: Buffer.from('hello world') }])
    await expect(readZip(archive.subarray(0, archive.length - 10))).rejects.toThrow()
  })
})

describe('path safety', () => {
  it('normalises separators and strips leading slashes', () => {
    expect(normalizePath('/a\\b/c.txt')).toBe('a/b/c.txt')
    expect(normalizePath('./a/./b.txt')).toBe('a/b.txt')
  })

  it('refuses to write a traversal path', () => {
    expect(() => normalizePath('../escape.txt')).toThrow(/\.\./)
    expect(() => normalizePath('a/../../escape.txt')).toThrow(/\.\./)
  })

  it('rejects unsafe paths on read', () => {
    expect(isSafeBundlePath('profiles/Show/basic.ini')).toBe(true)
    expect(isSafeBundlePath('../../etc/passwd')).toBe(false)
    expect(isSafeBundlePath('a/../../b')).toBe(false)
    expect(isSafeBundlePath('/etc/passwd')).toBe(false)
    expect(isSafeBundlePath('C:\\Windows\\system32')).toBe(false)
    expect(isSafeBundlePath('a\0b')).toBe(false)
  })
})

describe('bundleDigest', () => {
  it('is order independent', () => {
    const a = [
      { path: 'b.txt', data: Buffer.from('two') },
      { path: 'a.txt', data: Buffer.from('one') }
    ]
    const b = [
      { path: 'a.txt', data: Buffer.from('one') },
      { path: 'b.txt', data: Buffer.from('two') }
    ]
    expect(bundleDigest(a)).toBe(bundleDigest(b))
  })

  it('changes when content changes', () => {
    const before = bundleDigest([{ path: 'a.txt', data: Buffer.from('one') }])
    const after = bundleDigest([{ path: 'a.txt', data: Buffer.from('two') }])
    expect(before).not.toBe(after)
  })
})

describe('interoperability with system unzip', () => {
  it('produces an archive the system unzip accepts and extracts correctly', async () => {
    if (!(await hasUnzip())) {
      // Not available in this environment; the round-trip tests still cover
      // the format, so skip rather than fail.
      return
    }

    const entries = [
      { path: 'manifest.json', data: Buffer.from(JSON.stringify({ version: 1 }, null, 2)) },
      { path: 'profiles/Show/basic.ini', data: Buffer.from('[General]\nName=Show\n') },
      { path: 'big.txt', data: Buffer.from('compress me '.repeat(2000)) },
      { path: 'bytes.bin', data: Buffer.from(Array.from({ length: 256 }, (_, i) => i)) }
    ]

    const archivePath = path.join(workdir, 'bundle.zip')
    await fs.writeFile(archivePath, await createZip(entries))

    // -t verifies every CRC without extracting.
    const { stdout: testOutput } = await run('unzip', ['-t', archivePath], { timeout: 15_000 })
    expect(testOutput).toMatch(/No errors detected/i)

    const extractDir = path.join(workdir, 'out')
    await run('unzip', ['-q', archivePath, '-d', extractDir], { timeout: 15_000 })

    for (const entry of entries) {
      const extracted = await fs.readFile(path.join(extractDir, entry.path))
      expect(extracted.equals(entry.data)).toBe(true)
    }
  })

  it('reads an archive produced by the system zip', async () => {
    if (!(await hasUnzip())) return

    const sourceDir = path.join(workdir, 'src')
    await fs.mkdir(path.join(sourceDir, 'nested'), { recursive: true })
    await fs.writeFile(path.join(sourceDir, 'a.txt'), 'hello from zip')
    await fs.writeFile(path.join(sourceDir, 'nested', 'b.txt'), 'y'.repeat(5000))

    const archivePath = path.join(workdir, 'external.zip')
    try {
      await run('zip', ['-r', '-q', archivePath, '.'], { cwd: sourceDir, timeout: 15_000 })
    } catch {
      return // `zip` unavailable even though `unzip` is
    }

    const read = await readZip(await fs.readFile(archivePath))
    const byPath = new Map(read.map((entry) => [entry.path, entry.data.toString()]))

    expect(byPath.get('a.txt')).toBe('hello from zip')
    expect(byPath.get('nested/b.txt')).toBe('y'.repeat(5000))
  })
})
