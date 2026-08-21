import { describe, expect, it } from 'vitest'
import { iniGet, iniMerge, iniSet, parseIni, serializeIni } from '../src/main/util/ini'

/**
 * libobs writes values verbatim: no quoting, no escaping, no type coercion.
 * Round-tripping a real profile must not change a single byte of meaning,
 * because we edit `basic.ini` in place when syncing profiles.
 */
describe('parseIni', () => {
  it('reads sections and key/value pairs', () => {
    const doc = parseIni('[General]\nName=Show Profile\n\n[Video]\nBaseCX=1920\n')

    expect(iniGet(doc, 'General', 'Name')).toBe('Show Profile')
    expect(iniGet(doc, 'Video', 'BaseCX')).toBe('1920')
  })

  it('keeps values containing = and : intact', () => {
    const doc = parseIni('[AdvOut]\nRecFilePath=C:\\Media\\Take 1\nURL=rtmp://a.b/live?key=abc=def\n')

    expect(iniGet(doc, 'AdvOut', 'RecFilePath')).toBe('C:\\Media\\Take 1')
    expect(iniGet(doc, 'AdvOut', 'URL')).toBe('rtmp://a.b/live?key=abc=def')
  })

  it('preserves leading and trailing spaces inside values', () => {
    // OBS filename patterns legitimately contain spaces.
    const doc = parseIni('[Output]\nFilenameFormatting=Cam 1 %CCYY-%MM-%DD %hh-%mm-%ss\n')
    expect(iniGet(doc, 'Output', 'FilenameFormatting')).toBe('Cam 1 %CCYY-%MM-%DD %hh-%mm-%ss')
  })

  it('ignores comments and blank lines', () => {
    const doc = parseIni('# a comment\n; another\n\n[General]\nName=X\n')
    expect(doc.has('General')).toBe(true)
    expect(iniGet(doc, 'General', 'Name')).toBe('X')
  })

  it('merges duplicate section headers rather than dropping the first', () => {
    const doc = parseIni('[General]\nA=1\n[Video]\nB=2\n[General]\nC=3\n')
    expect(iniGet(doc, 'General', 'A')).toBe('1')
    expect(iniGet(doc, 'General', 'C')).toBe('3')
  })

  it('handles an empty document', () => {
    expect(parseIni('').size).toBe(0)
  })

  it('survives a round trip', () => {
    const source = '[General]\nName=Show\n\n[SimpleOutput]\nFilePath=/media/recordings\nRecFormat2=mkv\n'
    const doc = parseIni(source)
    const reparsed = parseIni(serializeIni(doc))

    expect(iniGet(reparsed, 'General', 'Name')).toBe('Show')
    expect(iniGet(reparsed, 'SimpleOutput', 'FilePath')).toBe('/media/recordings')
    expect(iniGet(reparsed, 'SimpleOutput', 'RecFormat2')).toBe('mkv')
  })
})

describe('iniSet and iniMerge', () => {
  it('creates a section that does not exist yet', () => {
    const doc = parseIni('')
    iniSet(doc, 'AdvOut', 'RecFilePath', '/new/path')
    expect(iniGet(doc, 'AdvOut', 'RecFilePath')).toBe('/new/path')
  })

  it('overwrites an existing key without disturbing its neighbours', () => {
    const doc = parseIni('[SimpleOutput]\nFilePath=/old\nRecFormat2=mkv\n')
    iniSet(doc, 'SimpleOutput', 'FilePath', '/new')

    expect(iniGet(doc, 'SimpleOutput', 'FilePath')).toBe('/new')
    expect(iniGet(doc, 'SimpleOutput', 'RecFormat2')).toBe('mkv')
  })

  it('applies a nested patch across several sections', () => {
    const doc = parseIni('[General]\nName=Old\n')
    iniMerge(doc, {
      General: { Name: 'New' },
      Video: { BaseCX: '1920', BaseCY: '1080' }
    })

    expect(iniGet(doc, 'General', 'Name')).toBe('New')
    expect(iniGet(doc, 'Video', 'BaseCY')).toBe('1080')
  })
})

describe('serializeIni', () => {
  it('omits empty sections', () => {
    const doc = parseIni('[General]\nName=X\n')
    doc.set('Empty', new Map())
    expect(serializeIni(doc)).not.toContain('[Empty]')
  })

  it('writes a section header before its keys', () => {
    const doc = parseIni('[General]\nName=X\n')
    const lines = serializeIni(doc).split('\n')
    expect(lines[0]).toBe('[General]')
    expect(lines[1]).toBe('Name=X')
  })
})
