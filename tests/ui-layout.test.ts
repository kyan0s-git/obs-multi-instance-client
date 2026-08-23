import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  describeUiLayout,
  parseExtraBrowserDocks,
  readUiLayout,
  regenerateDockUuids,
  serializeExtraBrowserDocks,
  writeUiLayout
} from '../src/main/services/ui-layout'
import { iniGet, parseIni } from '../src/main/util/ini'

let workdir: string
let userIni: string

beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsfleet-ui-'))
  userIni = path.join(workdir, 'user.ini')
})

afterEach(async () => {
  await fs.rm(workdir, { recursive: true, force: true })
})

const SAMPLE_USER_INI = [
  '[General]',
  'FirstRun=true',
  'ConfirmOnExit=false',
  '',
  '[Basic]',
  'Profile=Show',
  'SceneCollection=Main',
  '',
  '[BasicWindow]',
  'geometry=AdnQywADAAAAAAAAAAAAFwAAB38AAAQ1',
  'DockState=AAAA/wAAAAD9AAAAAQAAAAIAAAAA',
  'DocksLocked=true',
  'ShowStatusBar=true',
  'ShowSourceIcons=false',
  'PreviewProgramMode=true',
  'ExtraBrowserDocks=[{"title":"Chat","url":"https://example.test/chat","uuid":"abc-123"}]',
  ''
].join('\n')

describe('readUiLayout', () => {
  it('returns null when there is no user.ini', async () => {
    expect(await readUiLayout(userIni)).toBeNull()
  })

  it('returns null when OBS has never saved a layout', async () => {
    await fs.writeFile(userIni, '[General]\nFirstRun=true\n')
    expect(await readUiLayout(userIni)).toBeNull()
  })

  it('extracts the layout keys', async () => {
    await fs.writeFile(userIni, SAMPLE_USER_INI)
    const layout = await readUiLayout(userIni)

    expect(layout?.values.DockState).toBe('AAAA/wAAAAD9AAAAAQAAAAIAAAAA')
    expect(layout?.values.DocksLocked).toBe('true')
    expect(layout?.values.PreviewProgramMode).toBe('true')
  })

  it('keeps geometry separate from the rest of the layout', async () => {
    await fs.writeFile(userIni, SAMPLE_USER_INI)
    const layout = await readUiLayout(userIni)

    expect(layout?.geometry).toBe('AdnQywADAAAAAAAAAAAAFwAAB38AAAQ1')
    expect(layout?.values.geometry).toBeUndefined()
  })

  it('ignores keys outside the layout set', async () => {
    await fs.writeFile(userIni, SAMPLE_USER_INI)
    const layout = await readUiLayout(userIni)
    // Active profile lives in [Basic] and must never travel with a layout.
    expect(Object.keys(layout?.values ?? {})).not.toContain('Profile')
  })
})

describe('writeUiLayout', () => {
  it('creates the section when the target has none', async () => {
    await fs.writeFile(userIni, '[General]\nFirstRun=true\n')
    const layout = { values: { DockState: 'STATE', DocksLocked: 'true' }, geometry: null }

    await writeUiLayout(userIni, layout, { includeGeometry: false })

    const doc = parseIni(await fs.readFile(userIni, 'utf8'))
    expect(iniGet(doc, 'BasicWindow', 'DockState')).toBe('STATE')
  })

  it('leaves the rest of the target user.ini untouched', async () => {
    await fs.writeFile(userIni, SAMPLE_USER_INI)
    await writeUiLayout(userIni, { values: { DockState: 'NEW' }, geometry: null }, {
      includeGeometry: false
    })

    const doc = parseIni(await fs.readFile(userIni, 'utf8'))
    // The active profile is per-instance; overwriting it would repoint the
    // instance at a profile it may not have.
    expect(iniGet(doc, 'Basic', 'Profile')).toBe('Show')
    expect(iniGet(doc, 'General', 'FirstRun')).toBe('true')
    expect(iniGet(doc, 'BasicWindow', 'DockState')).toBe('NEW')
  })

  it('omits geometry unless asked for it', async () => {
    await fs.writeFile(userIni, '[General]\nFirstRun=true\n')
    const layout = { values: { DockState: 'STATE' }, geometry: 'GEOM' }

    await writeUiLayout(userIni, layout, { includeGeometry: false })
    let doc = parseIni(await fs.readFile(userIni, 'utf8'))
    expect(iniGet(doc, 'BasicWindow', 'geometry')).toBeUndefined()

    await writeUiLayout(userIni, layout, { includeGeometry: true })
    doc = parseIni(await fs.readFile(userIni, 'utf8'))
    expect(iniGet(doc, 'BasicWindow', 'geometry')).toBe('GEOM')
  })

  it('round-trips through read', async () => {
    await fs.writeFile(userIni, SAMPLE_USER_INI)
    const source = await readUiLayout(userIni)

    const target = path.join(workdir, 'target.ini')
    await fs.writeFile(target, '[General]\nFirstRun=true\n')
    await writeUiLayout(target, source!, { includeGeometry: true })

    const copied = await readUiLayout(target)
    expect(copied?.values).toEqual(source?.values)
    expect(copied?.geometry).toBe(source?.geometry)
  })
})

describe('extra browser docks', () => {
  it('parses the JSON array OBS stores', () => {
    const docks = parseExtraBrowserDocks(
      '[{"title":"Chat","url":"https://example.test/chat","uuid":"abc"}]'
    )
    expect(docks).toEqual([{ title: 'Chat', url: 'https://example.test/chat', uuid: 'abc' }])
  })

  it('treats malformed content as no docks rather than failing the copy', () => {
    expect(parseExtraBrowserDocks('not json')).toEqual([])
    expect(parseExtraBrowserDocks('{"not":"an array"}')).toEqual([])
    expect(parseExtraBrowserDocks(undefined)).toEqual([])
  })

  it('drops entries missing a title or url', () => {
    expect(parseExtraBrowserDocks('[{"title":"only"},{"url":"only"}]')).toEqual([])
  })

  it('round-trips through serialize', () => {
    const docks = [{ title: 'Chat', url: 'https://example.test/chat', uuid: 'abc' }]
    expect(parseExtraBrowserDocks(serializeExtraBrowserDocks(docks))).toEqual(docks)
  })

  it('assigns a uuid to a dock that lacks one', () => {
    const serialized = serializeExtraBrowserDocks([{ title: 'A', url: 'https://a.test' }])
    expect(parseExtraBrowserDocks(serialized)[0].uuid).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('regenerateDockUuids', () => {
  it('gives every copied dock a fresh uuid', () => {
    const layout = {
      values: {
        ExtraBrowserDocks: JSON.stringify([
          { title: 'A', url: 'https://a.test', uuid: 'original-a' },
          { title: 'B', url: 'https://b.test', uuid: 'original-b' }
        ])
      },
      geometry: null
    }

    const docks = parseExtraBrowserDocks(regenerateDockUuids(layout).values.ExtraBrowserDocks)

    expect(docks.map((dock) => dock.uuid)).not.toContain('original-a')
    expect(docks.map((dock) => dock.uuid)).not.toContain('original-b')
    // Titles and URLs are the content; only identity changes.
    expect(docks.map((dock) => dock.title)).toEqual(['A', 'B'])
    expect(new Set(docks.map((dock) => dock.uuid)).size).toBe(2)
  })

  it('is a no-op when there are no docks', () => {
    const layout = { values: { DockState: 'x' }, geometry: null }
    expect(regenerateDockUuids(layout)).toBe(layout)
  })
})

describe('describeUiLayout', () => {
  it('says when a dock arrangement is present', () => {
    const description = describeUiLayout({ values: { DockState: 'x' }, geometry: null })
    expect(description).toContain('saved dock arrangement')
  })

  it('counts custom browser docks', () => {
    const description = describeUiLayout({
      values: {
        DockState: 'x',
        ExtraBrowserDocks: JSON.stringify([
          { title: 'A', url: 'https://a.test' },
          { title: 'B', url: 'https://b.test' }
        ])
      },
      geometry: null
    })
    expect(description).toContain('2 custom browser docks')
  })

  it('mentions geometry only when it is included', () => {
    expect(describeUiLayout({ values: { DockState: 'x' }, geometry: 'g' })).toContain('geometry')
    expect(describeUiLayout({ values: { DockState: 'x' }, geometry: null })).not.toContain(
      'geometry'
    )
  })
})
