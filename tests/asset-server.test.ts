import { describe, expect, it } from 'vitest'
import { kindFor, parseRange } from '../src/main/services/asset-server'

/**
 * Range support is what makes video and audio usable as OBS media sources
 * over HTTP: without it a scrub restarts the transfer from byte zero.
 */
describe('parseRange', () => {
  const size = 1000

  it('returns null when no Range header is present', () => {
    expect(parseRange(undefined, size)).toBeNull()
  })

  it('parses a closed range', () => {
    expect(parseRange('bytes=0-499', size)).toEqual({ start: 0, end: 499 })
  })

  it('parses an open-ended range', () => {
    expect(parseRange('bytes=500-', size)).toEqual({ start: 500, end: 999 })
  })

  it('parses a suffix range as the last N bytes', () => {
    expect(parseRange('bytes=-200', size)).toEqual({ start: 800, end: 999 })
  })

  it('clamps an end beyond the file to the last byte', () => {
    expect(parseRange('bytes=900-99999', size)).toEqual({ start: 900, end: 999 })
  })

  it('handles a suffix longer than the file', () => {
    expect(parseRange('bytes=-99999', size)).toEqual({ start: 0, end: 999 })
  })

  it('accepts a single-byte range', () => {
    expect(parseRange('bytes=0-0', size)).toEqual({ start: 0, end: 0 })
  })

  it('rejects a start past the end of the file', () => {
    expect(parseRange('bytes=1000-1200', size)).toBe('invalid')
  })

  it('rejects an inverted range', () => {
    expect(parseRange('bytes=500-100', size)).toBe('invalid')
  })

  it('rejects an empty range', () => {
    expect(parseRange('bytes=-', size)).toBe('invalid')
  })

  it('rejects a zero-length suffix', () => {
    expect(parseRange('bytes=-0', size)).toBe('invalid')
  })

  it('ignores unit types it does not understand', () => {
    // Treated as "no range", which legitimately answers with the whole file.
    expect(parseRange('items=0-10', size)).toBeNull()
  })

  it('ignores a multi-range request rather than mis-serving one part', () => {
    expect(parseRange('bytes=0-99,200-299', size)).toBeNull()
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseRange('  bytes=0-9  ', size)).toEqual({ start: 0, end: 9 })
  })
})

describe('kindFor', () => {
  it.each([
    ['overlay.html', 'html'],
    ['OVERLAY.HTM', 'html'],
    ['logo.png', 'image'],
    ['bumper.mp4', 'video'],
    ['sting.wav', 'audio'],
    ['ticker.js', 'script'],
    ['brand.woff2', 'font'],
    ['notes.dat', 'other'],
    ['no-extension', 'other']
  ])('classifies %s as %s', (name, expected) => {
    expect(kindFor(name)).toBe(expected)
  })
})
