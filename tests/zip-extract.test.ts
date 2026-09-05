import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crc32, createZip } from '../src/main/util/zip'
import { extractZipFile } from '../src/main/util/zip-extract'

const run = promisify(execFile)

/**
 * The streaming extractor is what unpacks a downloaded OBS release, so it is
 * cross-checked against the system `zip` rather than only against this
 * project's own writer. An extractor that only understands archives we
 * produced would be no use for the one job it exists to do.
 */

let workspace: string

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-extract-'))
})

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true })
})

/** Builds a tree, zips it with the system tool, returns the archive path. */
async function systemZip(
  files: Record<string, string>,
  options: { root?: string } = {}
): Promise<string> {
  const source = path.join(workspace, 'source')
  const prefix = options.root ? path.join(source, options.root) : source

  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(prefix, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, contents)
  }

  const archive = path.join(workspace, 'archive.zip')
  await run('zip', ['-r', '-q', archive, '.'], { cwd: source })
  return archive
}

describe('extractZipFile', () => {
  it('extracts an archive written by the system zip tool', async () => {
    const archive = await systemZip({
      'bin/obs64.exe': 'binary',
      'data/obs-studio/locale/en-US.ini': '[General]\nName=OBS',
      'obs-plugins/64bit/obs-browser.dll': 'plugin'
    })

    const out = path.join(workspace, 'out')
    const result = await extractZipFile(archive, out)

    expect(result.files).toBe(3)
    expect(await fs.readFile(path.join(out, 'bin/obs64.exe'), 'utf8')).toBe('binary')
    expect(await fs.readFile(path.join(out, 'obs-plugins/64bit/obs-browser.dll'), 'utf8')).toBe('plugin')
  })

  it('strips the wrapping folder a release archive carries', async () => {
    const archive = await systemZip(
      { 'bin/obs64.exe': 'binary', 'data/readme.txt': 'hello' },
      { root: 'OBS-Studio-31.0.2' }
    )

    const out = path.join(workspace, 'out')
    await extractZipFile(archive, out, { stripComponents: 1 })

    expect(await fs.readFile(path.join(out, 'bin/obs64.exe'), 'utf8')).toBe('binary')
    // Nothing may keep the version-named prefix.
    await expect(fs.stat(path.join(out, 'OBS-Studio-31.0.2'))).rejects.toThrow()
  })

  it('round-trips an archive written by this project', async () => {
    const archive = path.join(workspace, 'own.zip')
    // Long enough to be deflated rather than stored, so both paths are covered.
    const long = 'obs '.repeat(4096)
    await fs.writeFile(
      archive,
      await createZip([
        { path: 'small.txt', data: Buffer.from('tiny') },
        { path: 'nested/large.txt', data: Buffer.from(long) }
      ])
    )

    const out = path.join(workspace, 'out')
    const result = await extractZipFile(archive, out)

    expect(result.files).toBe(2)
    expect(await fs.readFile(path.join(out, 'small.txt'), 'utf8')).toBe('tiny')
    expect(await fs.readFile(path.join(out, 'nested/large.txt'), 'utf8')).toBe(long)
  })

  it('reports progress as entries land', async () => {
    const archive = await systemZip({ a: '1', b: '2', c: '3' })
    const seen: number[] = []

    await extractZipFile(archive, path.join(workspace, 'out'), {
      onProgress: (progress) => seen.push(progress.entriesDone)
    })

    expect(seen).toEqual([1, 2, 3])
  })

  it('refuses an entry that would escape the destination', () => {
    // Built byte by byte: this project's own writer refuses to *create* a
    // traversing path, so an archive carrying one can only come from outside —
    // which is exactly the case the extractor has to defend against on its own.
    const archive = path.join(workspace, 'evil.zip')

    return (async () => {
      await fs.writeFile(archive, rawStoredZip('../escaped.txt', 'nope'))
      await expect(extractZipFile(archive, path.join(workspace, 'out'))).rejects.toThrow(
        /\.\.|unsafe/i
      )
    })()
  })

  it('neutralises an absolute entry path instead of honouring it', async () => {
    const archive = path.join(workspace, 'absolute.zip')
    await fs.writeFile(archive, rawStoredZip('/etc/passwd', 'nope'))

    const out = path.join(workspace, 'out')
    const result = await extractZipFile(archive, out)

    // The leading slash is dropped and the entry lands inside the destination.
    // Refusing would be defensible too, but silently writing to the real
    // /etc/passwd would not be, and that is what this pins.
    expect(result.files).toBe(1)
    expect(await fs.readFile(path.join(out, 'etc/passwd'), 'utf8')).toBe('nope')
  })

  it('rejects a file that is not a ZIP at all', async () => {
    const archive = path.join(workspace, 'not.zip')
    await fs.writeFile(archive, 'this is not an archive')

    await expect(extractZipFile(archive, path.join(workspace, 'out'))).rejects.toThrow(
      /no end-of-central-directory/i
    )
  })
})

/**
 * A one-entry, stored (uncompressed) ZIP with an arbitrary entry name.
 *
 * Hand-rolled so the name can be hostile; `createZip` validates paths and so
 * cannot produce these.
 */
function rawStoredZip(name: string, contents: string): Buffer {
  const nameBytes = Buffer.from(name, 'utf8')
  const data = Buffer.from(contents, 'utf8')
  const crc = crc32(data)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4) // version needed
  local.writeUInt16LE(0, 6) // flags
  local.writeUInt16LE(0, 8) // method: store
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 10) // method: store
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(nameBytes.length, 28)
  central.writeUInt32LE(0, 42) // local header offset

  const localBlock = Buffer.concat([local, nameBytes, data])
  const centralBlock = Buffer.concat([central, nameBytes])

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8) // entries on this disk
  end.writeUInt16LE(1, 10) // entries total
  end.writeUInt32LE(centralBlock.length, 12)
  end.writeUInt32LE(localBlock.length, 16)

  return Buffer.concat([localBlock, centralBlock, end])
}
