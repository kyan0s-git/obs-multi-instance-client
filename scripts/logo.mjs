/**
 * The OBS Fleet mark, described once.
 *
 * Both the SVG the UI uses and the PNG electron-builder turns into platform
 * icons are generated from this, so the icon on the taskbar and the mark in
 * the title bar cannot drift apart.
 *
 * The shape is the app's own `main-and-stack` layout: one large pane and a
 * stack of smaller ones — several instances, one being watched. It borrows
 * nothing from the OBS Project's branding, which this application is not
 * affiliated with. Three rectangles and nothing else, because the mark has to
 * survive being drawn 16 pixels wide in a taskbar.
 */

export const SIZE = 512

/** `null` gradient means a flat fill. Coordinates are absolute, in user units. */
export const BACKGROUND = {
  x: 0,
  y: 0,
  width: SIZE,
  height: SIZE,
  radius: 112,
  from: '#161d27',
  to: '#0b0f15',
  direction: 'vertical'
}

/**
 * Content spans 64..448 on both axes — a 75% content box, which is about
 * where an app icon stops looking lost inside its own plate. The stack tiles
 * step down in value so the eye reads depth rather than three equal panes.
 */
export const TILES = [
  // Program pane.
  { x: 64, y: 96, width: 228, height: 320, radius: 30, from: '#6cb0ff', to: '#3d84e6', direction: 'diagonal' },
  // The fleet behind it.
  { x: 320, y: 96, width: 128, height: 146, radius: 24, from: '#42566f', to: '#42566f', direction: 'vertical' },
  { x: 320, y: 270, width: 128, height: 146, radius: 24, from: '#2c3a4a', to: '#2c3a4a', direction: 'vertical' }
]

/**
 * @param {{ background?: boolean }} options
 *   `background: false` drops the app-tile plate, for use inside the UI where
 *   the mark sits on the application's own surface.
 */
export function toSvg({ background = true } = {}) {
  const defs = []
  const body = []

  const gradient = (id, shape) => {
    if (shape.from === shape.to) return null
    const [x2, y2] = shape.direction === 'diagonal' ? [1, 1] : [0, 1]
    defs.push(
      `    <linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">\n` +
        `      <stop offset="0" stop-color="${shape.from}" />\n` +
        `      <stop offset="1" stop-color="${shape.to}" />\n` +
        `    </linearGradient>`
    )
    return `url(#${id})`
  }

  const rect = (shape, fill) =>
    `  <rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" ` +
    `rx="${shape.radius}" fill="${fill}" />`

  if (background) {
    body.push(rect(BACKGROUND, gradient('fleet-plate', BACKGROUND) ?? BACKGROUND.from))
  }
  TILES.forEach((tile, index) => {
    body.push(rect(tile, gradient(`fleet-tile-${index}`, tile) ?? tile.from))
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" ` +
    `role="img" aria-label="OBS Fleet">\n` +
    (defs.length > 0 ? `  <defs>\n${defs.join('\n')}\n  </defs>\n` : '') +
    `${body.join('\n')}\n</svg>\n`
  )
}
