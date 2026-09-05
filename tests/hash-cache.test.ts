import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HashCache } from '../src/main/util/hash-cache'
import { measureDir } from '../src/main/util/fsx'

let workdir: string

beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsfleet-hash-'))
})

afterEach(async () => {
  await fs.rm(workdir, { recursive: true, force: true })
})

/** Writes a file with an explicit mtime so cache identity is controllable. */
async function write(rel: string, contents: string, mtime?: Date): Promise<string> {
  const file = path.join(workdir, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, contents)
  if (mtime) await fs.utimes(file, mtime, mtime)
  return file
}

describe('HashCache.file', () => {
  it('returns a stable digest for unchanged content', async () => {
    const cache = new HashCache()
    const file = await write('a.txt', 'hello')

    expect(await cache.file(file)).toBe(await cache.file(file))
  })

  it('serves the second read from cache', async () => {
    const cache = new HashCache()
    const file = await write('a.txt', 'hello')

    await cache.file(file)
    await cache.file(file)

    const stats = cache.stats()
    expect(stats.misses).toBe(1)
    expect(stats.hits).toBe(1)
  })

  it('notices a changed file', async () => {
    const cache = new HashCache()
    const file = await write('a.txt', 'before', new Date(2020, 0, 1))
    const before = await cache.file(file)

    await write('a.txt', 'after', new Date(2021, 0, 1))
    expect(await cache.file(file)).not.toBe(before)
  })

  it('notices a same-length change with a different mtime', async () => {
    const cache = new HashCache()
    const file = await write('a.txt', 'aaaa', new Date(2020, 0, 1))
    const before = await cache.file(file)

    await write('a.txt', 'bbbb', new Date(2021, 0, 1))
    expect(await cache.file(file)).not.toBe(before)
  })

  it('returns a sentinel for a missing file rather than throwing', async () => {
    const cache = new HashCache()
    expect(await cache.file(path.join(workdir, 'nope.txt'))).toBe('missing')
  })

  it('keys transformed digests separately from raw ones', async () => {
    const cache = new HashCache()
    const file = await write('a.txt', 'PAYLOAD')

    const raw = await cache.file(file)
    const upper = await cache.file(file, {
      key: 'lower',
      apply: (buffer) => buffer.toString('utf8').toLowerCase()
    })

    expect(raw).not.toBe(upper)
    // Both must still be individually stable.
    expect(await cache.file(file)).toBe(raw)
  })

  it('applies the transform, so cosmetic differences can be ignored', async () => {
    const cache = new HashCache()
    const spaced = await write('a.txt', 'a  b   c')
    const tight = await write('b.txt', 'a b c')

    const collapse = {
      key: 'collapse',
      apply: (buffer: Buffer) => buffer.toString('utf8').replace(/\s+/g, ' ')
    }

    expect(await cache.file(spaced, collapse)).toBe(await cache.file(tight, collapse))
  })

  it('drops entries under an invalidated prefix', async () => {
    const cache = new HashCache()
    const file = await write('nested/a.txt', 'hello')

    await cache.file(file)
    cache.invalidate(path.join(workdir, 'nested'))

    const before = cache.stats().misses
    await cache.file(file)
    expect(cache.stats().misses).toBe(before + 1)
  })
})

describe('HashCache.tree', () => {
  it('reports digest, size and file count in one walk', async () => {
    const cache = new HashCache()
    await write('tree/a.txt', 'aaa')
    await write('tree/sub/b.txt', 'bbbb')

    const result = await cache.tree(path.join(workdir, 'tree'))

    expect(result.fileCount).toBe(2)
    expect(result.totalBytes).toBe(7)
    expect(result.digest).toMatch(/^[0-9a-f]{40}$/)
  })

  it('is stable across repeated walks', async () => {
    const cache = new HashCache()
    await write('tree/a.txt', 'aaa')
    await write('tree/sub/b.txt', 'bbbb')

    const first = await cache.tree(path.join(workdir, 'tree'))
    const second = await cache.tree(path.join(workdir, 'tree'))
    expect(first.digest).toBe(second.digest)
  })

  it('changes when any file in the tree changes', async () => {
    const cache = new HashCache()
    await write('tree/a.txt', 'aaa', new Date(2020, 0, 1))
    const before = await cache.tree(path.join(workdir, 'tree'))

    await write('tree/a.txt', 'zzz', new Date(2021, 0, 1))
    expect((await cache.tree(path.join(workdir, 'tree'))).digest).not.toBe(before.digest)
  })

  it('changes when a file is added', async () => {
    const cache = new HashCache()
    await write('tree/a.txt', 'aaa')
    const before = await cache.tree(path.join(workdir, 'tree'))

    await write('tree/b.txt', 'bbb')
    expect((await cache.tree(path.join(workdir, 'tree'))).digest).not.toBe(before.digest)
  })

  it('is independent of directory enumeration order', async () => {
    const cacheA = new HashCache()
    const cacheB = new HashCache()

    // Same contents, created in a different order.
    await write('one/b.txt', 'bbb')
    await write('one/a.txt', 'aaa')
    await write('two/a.txt', 'aaa')
    await write('two/b.txt', 'bbb')

    const first = await cacheA.tree(path.join(workdir, 'one'))
    const second = await cacheB.tree(path.join(workdir, 'two'))
    expect(first.digest).toBe(second.digest)
  })

  it('avoids re-reading unchanged files on a second walk', async () => {
    const cache = new HashCache()
    for (let i = 0; i < 40; i += 1) await write(`tree/file-${i}.txt`, `contents ${i}`)

    await cache.tree(path.join(workdir, 'tree'))
    const afterFirst = cache.stats()
    expect(afterFirst.misses).toBe(40)

    await cache.tree(path.join(workdir, 'tree'))
    const afterSecond = cache.stats()

    // Every file served from cache the second time.
    expect(afterSecond.misses).toBe(40)
    expect(afterSecond.hits).toBe(40)
  })

  it('returns an empty digest for a missing directory rather than throwing', async () => {
    const cache = new HashCache()
    const result = await cache.tree(path.join(workdir, 'nope'))
    expect(result.fileCount).toBe(0)
    expect(result.totalBytes).toBe(0)
  })
})

describe('measureDir', () => {
  it('stops at its deadline and says the figure is partial', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-measure-'))
    try {
      // Enough entries that a zero-millisecond budget is certain to expire
      // part-way through rather than by luck.
      for (let index = 0; index < 50; index += 1) {
        await fs.writeFile(path.join(root, `file-${index}`), 'x'.repeat(512))
      }

      const bounded = await measureDir(root, 0)
      expect(bounded.partial).toBe(true)

      const complete = await measureDir(root, 10_000)
      expect(complete.partial).toBe(false)
      expect(complete.bytes).toBe(50 * 512)
      // A partial walk never over-reports.
      expect(bounded.bytes).toBeLessThanOrEqual(complete.bytes)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
