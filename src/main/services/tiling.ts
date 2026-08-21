import type { TileLayout } from '@shared/types'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface TilingOptions {
  layout: TileLayout
  count: number
  area: Rect
  gap: number
  margin: number
  /** Index within `count` that gets the large pane in `main-and-stack`. */
  mainIndex?: number
}

/**
 * Computes where each OBS window should go.
 *
 * Pure, so the geometry can be unit tested without a window server, and so
 * the same maths drives both the real tiling and the preview diagram in the
 * UI.
 */
export function computeTiling(options: TilingOptions): Rect[] {
  const { layout, count, gap, margin } = options
  if (count <= 0) return []

  const area: Rect = {
    x: options.area.x + margin,
    y: options.area.y + margin,
    width: Math.max(1, options.area.width - margin * 2),
    height: Math.max(1, options.area.height - margin * 2)
  }

  switch (layout) {
    case 'columns':
      return splitAxis(area, count, gap, 'horizontal')
    case 'rows':
      return splitAxis(area, count, gap, 'vertical')
    case 'stack':
      // Every window gets the full area; useful with an alt-tab workflow or
      // a hardware KVM where only one instance is looked at a time.
      return Array.from({ length: count }, () => ({ ...area }))
    case 'cascade':
      return cascade(area, count, gap)
    case 'main-and-stack':
      return mainAndStack(area, count, gap, options.mainIndex ?? 0)
    case 'grid':
    default:
      return grid(area, count, gap)
  }
}

function splitAxis(area: Rect, count: number, gap: number, axis: 'horizontal' | 'vertical'): Rect[] {
  const rects: Rect[] = []
  const total = axis === 'horizontal' ? area.width : area.height
  const size = Math.floor((total - gap * (count - 1)) / count)

  for (let i = 0; i < count; i += 1) {
    // The last pane absorbs the rounding remainder so the row always fills
    // the work area exactly, with no sliver of desktop showing through.
    const isLast = i === count - 1
    const offset = i * (size + gap)
    const extent = isLast ? total - offset : size

    rects.push(
      axis === 'horizontal'
        ? { x: area.x + offset, y: area.y, width: extent, height: area.height }
        : { x: area.x, y: area.y + offset, width: area.width, height: extent }
    )
  }

  return rects
}

/**
 * Balanced grid: columns are chosen so the cells stay as close to the work
 * area's aspect ratio as possible, which keeps 16:9 previews from being
 * letterboxed into tall thin boxes.
 */
function grid(area: Rect, count: number, gap: number): Rect[] {
  const columns = bestColumnCount(count, area.width / area.height)
  const rows = Math.ceil(count / columns)

  const cellWidth = Math.floor((area.width - gap * (columns - 1)) / columns)
  const cellHeight = Math.floor((area.height - gap * (rows - 1)) / rows)

  const rects: Rect[] = []
  for (let index = 0; index < count; index += 1) {
    const row = Math.floor(index / columns)
    const column = index % columns

    // Widen the last item on a short final row so the grid reads as complete.
    const itemsOnRow = Math.min(columns, count - row * columns)
    const isLastOnRow = column === itemsOnRow - 1
    const isLastRow = row === rows - 1

    const x = area.x + column * (cellWidth + gap)
    const y = area.y + row * (cellHeight + gap)

    rects.push({
      x,
      y,
      width: isLastOnRow ? area.x + area.width - x : cellWidth,
      height: isLastRow ? area.y + area.height - y : cellHeight
    })
  }

  return rects
}

/** Picks the column count whose cell aspect ratio is closest to 16:9. */
function bestColumnCount(count: number, areaAspect: number): number {
  let best = 1
  let bestScore = Number.POSITIVE_INFINITY

  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns)
    const cellAspect = (areaAspect * rows) / columns
    const score = Math.abs(Math.log(cellAspect / (16 / 9)))
    // Prefer fewer, larger cells when two options score the same.
    if (score < bestScore - 1e-9) {
      bestScore = score
      best = columns
    }
  }

  return best
}

/** One large pane on the left, the rest stacked down the right. */
function mainAndStack(area: Rect, count: number, gap: number, mainIndex: number): Rect[] {
  if (count === 1) return [{ ...area }]

  const mainWidth = Math.floor(area.width * 0.62)
  const stackX = area.x + mainWidth + gap
  const stackWidth = area.x + area.width - stackX
  const stackCount = count - 1
  const stackHeight = Math.floor((area.height - gap * (stackCount - 1)) / stackCount)

  const rects = new Array<Rect>(count)
  const clampedMain = Math.min(Math.max(mainIndex, 0), count - 1)
  rects[clampedMain] = { x: area.x, y: area.y, width: mainWidth, height: area.height }

  let slot = 0
  for (let index = 0; index < count; index += 1) {
    if (index === clampedMain) continue
    const y = area.y + slot * (stackHeight + gap)
    const isLast = slot === stackCount - 1
    rects[index] = {
      x: stackX,
      y,
      width: stackWidth,
      height: isLast ? area.y + area.height - y : stackHeight
    }
    slot += 1
  }

  return rects
}

/** Overlapping windows offset down-right, each still large enough to work in. */
function cascade(area: Rect, count: number, gap: number): Rect[] {
  const step = Math.max(gap, 32)
  // Reserve enough room that even the last window is fully on screen.
  const width = Math.max(480, area.width - step * (count - 1))
  const height = Math.max(320, area.height - step * (count - 1))

  return Array.from({ length: count }, (_, index) => ({
    x: area.x + index * step,
    y: area.y + index * step,
    width,
    height
  }))
}
