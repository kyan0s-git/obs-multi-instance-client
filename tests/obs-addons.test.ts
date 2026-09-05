import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseThemeMeta, readCurrentTheme } from '../src/main/services/obs-addons'

/**
 * The metadata blocks below are copied verbatim out of OBS's own themes
 * (`frontend/data/themes/`). They use single quotes, which is the detail this
 * parser originally got wrong: written for double quotes, it found no
 * metadata at all in any theme that ships with OBS.
 */

const YAMI = `@OBSThemeMeta {
    name: 'Yami';
    id: 'com.obsproject.Yami';
    author: 'Warchamp7';
    dark: 'true';
}

@OBSThemeVars {
    --blue1: #718CDC;
}`

const YAMI_LIGHT = `@OBSThemeMeta {
    name: 'Light';
    id: 'com.obsproject.Yami.Light';
    extends: 'com.obsproject.Yami';
    author: 'Warchamp7';
    dark: 'false';
}`

describe('theme metadata', () => {
  it('reads a base theme written with single quotes', () => {
    expect(parseThemeMeta(YAMI)).toMatchObject({
      name: 'Yami',
      id: 'com.obsproject.Yami',
      author: 'Warchamp7',
      dark: 'true'
    })
  })

  it('reads a variant, including what it extends', () => {
    expect(parseThemeMeta(YAMI_LIGHT)).toMatchObject({
      id: 'com.obsproject.Yami.Light',
      extends: 'com.obsproject.Yami',
      dark: 'false'
    })
  })

  it('also accepts double quotes, which the tokeniser allows', () => {
    const meta = parseThemeMeta(`@OBSThemeMeta {\n  id: "com.example.Test";\n  name: "Test";\n}`)
    expect(meta.id).toBe('com.example.Test')
    expect(meta.name).toBe('Test')
  })

  it('stops at the metadata block and does not read theme variables', () => {
    // `--blue1` is a property in the *next* block; picking it up would put
    // junk in the theme list.
    expect(parseThemeMeta(YAMI)['--blue1']).toBeUndefined()
  })

  it('returns nothing for a file with no metadata block', () => {
    expect(parseThemeMeta('/* just a comment */')).toEqual({})
    expect(parseThemeMeta('')).toEqual({})
  })
})

describe('current theme', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-addons-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('reads the Appearance key OBS writes', async () => {
    const userIni = path.join(dir, 'user.ini')
    await fs.writeFile(userIni, '[Appearance]\nTheme=com.obsproject.Yami.Light\n')

    expect(await readCurrentTheme(userIni)).toBe('com.obsproject.Yami.Light')
  })

  it('falls back to the pre-30.2 key so an older config still reports a theme', async () => {
    const userIni = path.join(dir, 'user.ini')
    await fs.writeFile(userIni, '[General]\nCurrentTheme3=Dark\n')

    expect(await readCurrentTheme(userIni)).toBe('Dark')
  })

  it('prefers the current key when both are present', async () => {
    const userIni = path.join(dir, 'user.ini')
    await fs.writeFile(userIni, '[General]\nCurrentTheme3=Dark\n\n[Appearance]\nTheme=com.obsproject.Yami\n')

    expect(await readCurrentTheme(userIni)).toBe('com.obsproject.Yami')
  })

  it('returns null when the instance has never been launched', async () => {
    expect(await readCurrentTheme(path.join(dir, 'missing.ini'))).toBeNull()
  })
})
