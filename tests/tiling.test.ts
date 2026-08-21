import { describe, expect, it } from 'vitest'
import type { TileLayout } from '../src/shared/types'
import { computeTiling, type Rect } from '../src/main/services/tiling'

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
