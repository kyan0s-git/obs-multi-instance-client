import { describe, expect, it } from 'vitest'
import type { TileLayout } from '../src/shared/types'
import { computeTiling, distributeAcrossDisplays, type Rect } from '../src/shared/tiling'

const AREA: Rect = { x: 0, y: 0, width: 1920, height: 1080 }

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  )
}

describe('computeTiling', () => {
  it('returns nothing for an empty fleet', () => {
    expect(computeTiling({ layout: 'grid', count: 0, area: AREA, gap: 6, margin: 0 })).toEqual([])
  })

  it.each<TileLayout>(['grid', 'columns', 'rows', 'main-and-stack'])(
    'keeps %s windows inside the work area',
    (layout) => {
      const rects = computeTiling({ layout, count: 5, area: AREA, gap: 8, margin: 12 })

      for (const rect of rects) {
        expect(rect.x).toBeGreaterThanOrEqual(AREA.x)
        expect(rect.y).toBeGreaterThanOrEqual(AREA.y)
        expect(rect.x + rect.width).toBeLessThanOrEqual(AREA.x + AREA.width)
        expect(rect.y + rect.height).toBeLessThanOrEqual(AREA.y + AREA.height)
        expect(rect.width).toBeGreaterThan(0)
        expect(rect.height).toBeGreaterThan(0)
      }
    }
  )

  it.each<TileLayout>(['grid', 'columns', 'rows', 'main-and-stack'])(
    'never overlaps windows in the %s layout',
    (layout) => {
      const rects = computeTiling({ layout, count: 6, area: AREA, gap: 6, margin: 0 })

      for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
          expect(overlaps(rects[i], rects[j])).toBe(false)
        }
      }
    }
  )

  it('fills the work area exactly, with no sliver of desktop showing', () => {
    const rects = computeTiling({ layout: 'columns', count: 3, area: AREA, gap: 10, margin: 0 })
    const last = rects[rects.length - 1]
    expect(last.x + last.width).toBe(AREA.x + AREA.width)
  })

  it('honours the outer margin', () => {
    const [rect] = computeTiling({ layout: 'grid', count: 1, area: AREA, gap: 0, margin: 40 })
    expect(rect).toEqual({ x: 40, y: 40, width: 1840, height: 1000 })
  })

  it('picks a grid shape close to 16:9 cells rather than a single long row', () => {
    const rects = computeTiling({ layout: 'grid', count: 4, area: AREA, gap: 0, margin: 0 })
    // Four 16:9 tiles on a 16:9 screen should be a 2x2, not 4x1.
    const distinctX = new Set(rects.map((rect) => rect.x))
    const distinctY = new Set(rects.map((rect) => rect.y))
    expect(distinctX.size).toBe(2)
    expect(distinctY.size).toBe(2)
  })

  it('gives the nominated instance the large pane in main-and-stack', () => {
    const rects = computeTiling({
      layout: 'main-and-stack',
      count: 4,
      area: AREA,
      gap: 6,
      margin: 0,
      mainIndex: 2
    })

    const areas = rects.map((rect) => rect.width * rect.height)
    const largest = areas.indexOf(Math.max(...areas))
    expect(largest).toBe(2)
  })

  it('clamps an out-of-range main index instead of producing holes', () => {
    const rects = computeTiling({
      layout: 'main-and-stack',
      count: 3,
      area: AREA,
      gap: 6,
      margin: 0,
      mainIndex: 99
    })

    expect(rects).toHaveLength(3)
    expect(rects.every((rect) => rect !== undefined)).toBe(true)
  })

  it('gives every window the full area in stack layout', () => {
    const rects = computeTiling({ layout: 'stack', count: 3, area: AREA, gap: 6, margin: 20 })
    expect(new Set(rects.map((rect) => JSON.stringify(rect))).size).toBe(1)
  })

  it('keeps every cascaded window fully on screen', () => {
    const rects = computeTiling({ layout: 'cascade', count: 4, area: AREA, gap: 40, margin: 0 })

    for (const rect of rects) {
      expect(rect.x + rect.width).toBeLessThanOrEqual(AREA.width)
      expect(rect.y + rect.height).toBeLessThanOrEqual(AREA.height)
    }
  })

  it('handles a single instance by using the whole area', () => {
    for (const layout of ['grid', 'columns', 'rows', 'main-and-stack'] as TileLayout[]) {
      const [rect] = computeTiling({ layout, count: 1, area: AREA, gap: 8, margin: 0 })
      expect(rect.width).toBe(AREA.width)
      expect(rect.height).toBe(AREA.height)
    }
  })

  it('respects a non-zero display origin for a secondary monitor', () => {
    const secondary: Rect = { x: 1920, y: 0, width: 2560, height: 1440 }
    const rects = computeTiling({ layout: 'grid', count: 2, area: secondary, gap: 0, margin: 0 })

    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(1920)
      expect(rect.x + rect.width).toBeLessThanOrEqual(1920 + 2560)
    }
  })
})

/* ------------------------------------------------------------------ */

describe('distributeAcrossDisplays', () => {
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `i${i + 1}`)

  it('falls back to the primary display when none is chosen', () => {
    const shares = distributeAcrossDisplays({
      instanceIds: ids(3),
      displayIds: [],
      distribution: 'balanced',
      maxPerDisplay: 0
    })

    expect(shares).toEqual([{ displayId: null, instanceIds: ['i1', 'i2', 'i3'] }])
  })

  it('splits evenly when the count divides', () => {
    const shares = distributeAcrossDisplays({
      instanceIds: ids(6),
      displayIds: [1, 2, 3],
      distribution: 'balanced',
      maxPerDisplay: 0
    })

    expect(shares.map((share) => share.instanceIds.length)).toEqual([2, 2, 2])
    expect(shares[0].displayId).toBe(1)
  })

  it('keeps each display’s share contiguous, so numbering still locates a window', () => {
    const shares = distributeAcrossDisplays({
      instanceIds: ids(8),
      displayIds: [1, 2],
      distribution: 'balanced',
      maxPerDisplay: 0
    })

    expect(shares[0].instanceIds).toEqual(['i1', 'i2', 'i3', 'i4'])
    expect(shares[1].instanceIds).toEqual(['i5', 'i6', 'i7', 'i8'])
  })

  it('spreads the remainder over the leading displays, never off by more than one', () => {
    const shares = distributeAcrossDisplays({
      instanceIds: ids(7),
      displayIds: [1, 2, 3],
      distribution: 'balanced',
      maxPerDisplay: 0
    })

    expect(shares.map((share) => share.instanceIds.length)).toEqual([3, 2, 2])
  })

  it('drops displays that would receive nothing', () => {
    const shares = distributeAcrossDisplays({
      instanceIds: ids(2),
      displayIds: [1, 2, 3, 4],
      distribution: 'balanced',
      maxPerDisplay: 0
    })

    expect(shares).toHaveLength(2)
  })

  it('fills to the cap before moving on when sequential', () => {
    const shares = distributeAcrossDisplays({
      instanceIds: ids(5),
      displayIds: [1, 2, 3],
      distribution: 'sequential',
      maxPerDisplay: 2
    })

    expect(shares.map((share) => share.instanceIds)).toEqual([
      ['i1', 'i2'],
      ['i3', 'i4'],
      ['i5']
    ])
  })

  it('crowds the last display rather than leaving a window unplaced', () => {
    const shares = distributeAcrossDisplays({
      instanceIds: ids(7),
      displayIds: [1, 2],
      distribution: 'sequential',
      maxPerDisplay: 2
    })

    expect(shares).toHaveLength(2)
    expect(shares[1].instanceIds).toEqual(['i3', 'i4', 'i5', 'i6', 'i7'])
  })

  it('treats an uncapped sequential request as balanced', () => {
    const options = { instanceIds: ids(6), displayIds: [1, 2], maxPerDisplay: 0 }
    expect(distributeAcrossDisplays({ ...options, distribution: 'sequential' })).toEqual(
      distributeAcrossDisplays({ ...options, distribution: 'balanced' })
    )
  })

  it('returns nothing to do for an empty selection', () => {
    expect(
      distributeAcrossDisplays({
        instanceIds: [],
        displayIds: [1, 2],
        distribution: 'balanced',
        maxPerDisplay: 0
      })
    ).toEqual([])
  })
})
