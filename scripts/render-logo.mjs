/**
 * Generates build/logo.svg and build/icon.png from scripts/logo.mjs.
 *
 *   node scripts/render-logo.mjs
 *
 * The rasteriser is written out longhand rather than pulled from a library.
 * The mark is three rounded rectangles and two linear gradients, an image
 * toolchain is a large native dependency to carry for that, and a build step
 * that needs a display server (Chromium's `capturePage` does) is one that
 * fails on exactly the headless machines that build releases. Same reasoning
 * as util/zip.ts.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BACKGROUND, SIZE, TILES, toSvg } from './logo.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** electron-builder wants at least 512; 1024 also covers macOS retina icons. */
const RASTER = 1024
/** Sub-samples per axis. 4 is enough to keep the corner radii clean. */
const SAMPLES = 4

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

/** Signed-distance test for a rounded rectangle, in user units. */
function insideRoundedRect(px, py, shape) {
  const { x, y, width, height, radius } = shape
  if (px < x || py < y || px > x + width || py > y + height) return false

  const r = Math.min(radius, width / 2, height / 2)
  // Distance from the nearest corner centre, but only in the corner boxes.
  const dx = Math.max(x + r - px, 0, px - (x + width - r))
  const dy = Math.max(y + r - py, 0, py - (y + height - r))
  return dx * dx + dy * dy <= r * r
}

function parseHex(hex) {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

/** Position along the gradient axis, 0..1, for a point inside a shape. */
function gradientStop(px, py, shape) {
  const u = (px - shape.x) / shape.width
  const v = (py - shape.y) / shape.height
  return shape.direction === 'diagonal' ? Math.min(1, Math.max(0, (u + v) / 2)) : Math.min(1, Math.max(0, v))
}

function sample(shape, px, py) {
  const from = parseHex(shape.from)
  const to = parseHex(shape.to)
  if (shape.from === shape.to) return from
  const t = gradientStop(px, py, shape)
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t)
  ]
}

/* ------------------------------------------------------------------ */
/* Raster                                                              */
/* ------------------------------------------------------------------ */

function rasterise() {
  const layers = [BACKGROUND, ...TILES]
  const pixels = Buffer.alloc(RASTER * RASTER * 4)
  const scale = SIZE / RASTER
  const step = 1 / SAMPLES
  const perPixel = SAMPLES * SAMPLES

  for (let y = 0; y < RASTER; y += 1) {
    for (let x = 0; x < RASTER; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let covered = 0

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = (x + (sx + 0.5) * step) * scale
          const py = (y + (sy + 0.5) * step) * scale

          // Painter's order, last hit wins: every layer here is opaque.
          let hit = null
          for (const layer of layers) {
            if (insideRoundedRect(px, py, layer)) hit = layer
          }
          if (!hit) continue

          const [cr, cg, cb] = sample(hit, px, py)
          r += cr
          g += cg
          b += cb
          covered += 1
        }
      }

      const offset = (y * RASTER + x) * 4
      if (covered === 0) continue
      // Un-premultiplied: average the colour over the covered samples only,
      // or the edges pick up a dark fringe against light desktops.
      pixels[offset] = Math.round(r / covered)
      pixels[offset + 1] = Math.round(g / covered)
      pixels[offset + 2] = Math.round(b / covered)
      pixels[offset + 3] = Math.round((covered / perPixel) * 255)
    }
  }

  return pixels
}

/* ------------------------------------------------------------------ */
/* PNG container                                                       */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(pixels, size) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  // compression, filter and interlace methods are all "the only one there is"

  // Each scanline is prefixed with its filter type. 0 (none) keeps this
  // readable; deflate does the real work and the mark is mostly flat colour.
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ------------------------------------------------------------------ */

mkdirSync(path.join(root, 'build'), { recursive: true })

const svgPath = path.join(root, 'build/logo.svg')
writeFileSync(svgPath, toSvg())
console.log(`Wrote ${path.relative(root, svgPath)}`)

const png = encodePng(rasterise(), RASTER)
const pngPath = path.join(root, 'build/icon.png')
writeFileSync(pngPath, png)
console.log(`Wrote ${path.relative(root, pngPath)} (${RASTER}x${RASTER}, ${(png.length / 1024).toFixed(1)} KB)`)
