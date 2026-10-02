// The dot-matrix display, in the manner of an early-2000s car stereo.
//
// Interstitials act out what just happened: a device switched (a bulb lights,
// a fan spins up, a blind opens, a lock snaps shut), a save screws a bulb in,
// a run stopped by a condition flickers and stays dark, an error pops. The
// swim plays between them: the automation's own devices swim through dotted
// water and leap like the dolphins did, as an intro and while one is built.
// Pure: one frame per call, as Raster cells.
//
// Dots are braille cells (2 x 4 dots each, one colour per cell); the last
// row is a line of text.

import type { Interstitial, Lamp } from '../types'

/** How long one interstitial plays. */
export const SCENE_MS = 3200
/** Rows of cells: three of dots, then the caption. */
export const FX_ROWS = 4

const PANEL = 0x0b1020
const LIT = 0xffd75e
const HALO = 0xffb43c
const OUTLINE = 0x7c8594
const BASE = 0x9aa0a8
const SPARK = 0xff8a2b
const GREEN = 0x30d158
const AMBER = 0xffd60a
const RED = 0xff453a
const QUIET = 0x8e96a3
const CREST = 0x64d2ff
const STAR = 0x3b4a6b

// ---------------------------------------------------------------- devices
//
// Each sprite is 7 x 12 dots: rows 1-7 the body (two cell rows), 8-11 the
// base (a third), row 0 clear so body and base never share a cell's colour.
//   #  outline: grey when off, the device's colour when on
//   o  fill, shown dot by dot as it comes on
//   *  accent, shown only when on
//   =  base, always grey
// A device with several frames animates through them while on.

type Sprite = { colour: number; accent: number; frames: string[][]; rate: number }

const DEVICES: Record<string, Sprite> = {
  light: {
    colour: LIT,
    accent: LIT,
    rate: 0,
    frames: [['.......', '..###..', '.#ooo#.', '#ooooo#', '#ooooo#', '#ooooo#', '.#ooo#.', '..#o#..', '..===..', '...=...', '..===..', '...=...']],
  },
  switch: {
    colour: GREEN,
    accent: GREEN,
    rate: 0,
    frames: [['.......', '.#####.', '#.....#', '#.#.#.#', '#.#.#.#', '#.....#', '#..*..#', '.#####.', '...=...', '...=...', '...=...', '..===..']],
  },
  fan: {
    colour: CREST,
    accent: 0xffffff,
    rate: 12,
    frames: [
      ['.......', '...#...', '...#...', '...#...', '###*###', '...#...', '...#...', '...#...', '...=...', '...=...', '..===..', '.=====.'],
      ['.......', '#.....#', '.#...#.', '..#.#..', '...*...', '..#.#..', '.#...#.', '#.....#', '...=...', '...=...', '..===..', '.=====.'],
    ],
  },
  cover: {
    colour: AMBER,
    accent: LIT,
    rate: 0,
    // Off: the blind down. On: the blind up and the sun in.
    frames: [
      ['.......', '#######', '#=====#', '#.....#', '#=====#', '#.....#', '#=====#', '#######', '.......', '.......', '.......', '.......'],
      ['.......', '#######', '#=====#', '#=====#', '#..*..#', '#.***.#', '#..*..#', '#######', '.......', '.......', '.......', '.......'],
    ],
  },
  climate: {
    colour: 0xff6b3d,
    accent: 0xff6b3d,
    rate: 0,
    frames: [['.......', '...#...', '..#.#..', '..#o#..', '..#o#..', '..#o#..', '..#o#..', '..#o#..', '.#ooo#.', '.#ooo#.', '..###..', '.......']],
  },
  lock: {
    colour: GREEN,
    accent: GREEN,
    rate: 0,
    // Off: unlocked, the shackle up. On: locked.
    frames: [
      ['..###..', '.#...#.', '.#.....', '.#.....', '#######', '#..*..#', '#..*..#', '#######', '.......', '.......', '.......', '.......'],
      ['.......', '..###..', '.#...#.', '.#...#.', '#######', '#..*..#', '#..*..#', '#######', '.......', '.......', '.......', '.......'],
    ],
  },
  media_player: {
    colour: 0xff6bd5,
    accent: 0xff6bd5,
    rate: 6,
    frames: [
      ['.......', '.......', '..#....', '.##.*..', '###.*..', '.##.*..', '..#....', '.......', '.......', '.......', '.......', '.......'],
      ['.......', '......*', '..#...*', '.##.*.*', '###.*.*', '.##.*.*', '..#...*', '......*', '.......', '.......', '.......', '.......'],
    ],
  },
  sensor: {
    colour: CREST,
    accent: CREST,
    rate: 0,
    frames: [['.......', '.......', '..###..', '.#...#.', '#..o..#', '.#...#.', '..###..', '.......', '.......', '.......', '.......', '.......']],
  },
}

const DOMAIN_SPRITE: Record<string, string> = {
  light: 'light',
  switch: 'switch',
  input_boolean: 'switch',
  fan: 'fan',
  cover: 'cover',
  climate: 'climate',
  water_heater: 'climate',
  lock: 'lock',
  media_player: 'media_player',
  binary_sensor: 'sensor',
  sensor: 'sensor',
  person: 'sensor',
  device_tracker: 'sensor',
}

/** The sprite a domain is drawn as; anything unknown is a bulb. */
export function spriteFor(domain: string): string {
  return DOMAIN_SPRITE[domain] ?? 'light'
}

/** Which way a domain's on and off read in a caption. */
export function stateWords(domain: string, isOn: boolean): string {
  if (domain === 'cover') return isOn ? 'open' : 'closed'
  if (domain === 'lock') return isOn ? 'locked' : 'unlocked'
  return isOn ? 'on' : 'off'
}

// ---------------------------------------------------------------- frames

type Canvas = { w: number; h: number; px: Uint32Array; caption: { text: string; x: number; colour: number }[] }
type DeviceDraw = { kind: string; x: number; y: number; lit: number; halo: number; t: number; isBroken?: boolean; turn?: number; bodyOnly?: boolean; below?: (x: number) => number }

/** One frame of an interstitial, `elapsed` ms in, as the base64 `cells` a Raster takes. */
export function frame(elapsed: number, scene: Interstitial, columns: number): string {
  const c = canvas(columns)
  const t = elapsed / 1000

  if (scene.kind === 'switch') switchScene(c, t, scene.lamps)
  else if (scene.kind === 'saved') savedScene(c, t, scene.caption)
  else if (scene.kind === 'stopped') stoppedScene(c, t, scene.caption)
  else if (scene.kind === 'error') errorScene(c, t, scene.caption)
  else ranScene(c, t, scene.caption)

  return encode(c, columns)
}

/** Rows the swim takes: the whole six-line header, two pixels a row. */
export const SWIM_ROWS = 6

/**
 * One frame of the swim at `now` ms: three bulbs swimming through the water and
 * leaping like the dolphins did, trailing sparkles, beside a little graphic
 * equaliser. Each cell is two pixels, upper and lower, each drawn as a round
 * cluster of dots rather than a block.
 */
export function swim(now: number, columns: number): string {
  const p: Pixels = { w: columns, h: SWIM_ROWS * 2, px: new Uint32Array(columns * SWIM_ROWS * 2) }
  const t = now / 1000
  const eqWidth = columns >= 30 ? 12 : 0
  const width = columns - eqWidth

  for (let k = 0; k < Math.max(3, Math.floor(columns / 10)); k++) {
    const x = Math.floor(hash(k * 5.3) * width)
    if (Math.sin(t * 2 + k * 1.7) > 0.3) put(p, x, Math.floor(hash(k * 9.1) * 5), STAR)
  }
  const bulbs = swimmers(t, width, p.h)
  for (const bulb of bulbs) glowAround(p, bulb, width)
  for (const bulb of bulbs) sparkleTrail(p, bulb, t, width)
  for (const bulb of bulbs) swimmer(p, bulb)
  waves(p, t, width)
  if (eqWidth > 0) equaliser(p, t, width + 1, eqWidth - 1)

  return encodePixels(p)
}

type Pixels = { w: number; h: number; px: Uint32Array }
type Swimmer = { x: number; y: number; glass: number; isLeaping: boolean }

// The swimming bulb, 5 x 6 pixels: G glass, H highlight, S screw, D screw shadow.
const SWIMMER = ['.GGG.', 'GHGGG', 'GGGGG', '.GGG.', '.SSS.', '.DSD.']

function swimmers(t: number, width: number, height: number): Swimmer[] {
  const out: Swimmer[] = []
  for (let i = 0; i < 3; i++) {
    const span = width + 10
    const x = (((t * (7 + i * 1.5) + (i / 3) * span) % span) + span) % span - 5
    const cycle = (((t + i * 2.3) % 5.5) + 5.5) % 5.5
    const lift = cycle < 1.1 ? Math.sin((Math.PI * cycle) / 1.1) * (height - 7) : 0
    const y = height - 7 + Math.sin(t * 2.2 + i * 2) * 0.8 - lift
    out.push({ x, y, glass: mix(0xffb43c, 0xfff2a8, 0.5 + 0.5 * Math.sin(t * 3 + i)), isLeaping: lift > 0.5 })
  }
  return out
}

function glowAround(p: Pixels, bulb: Swimmer, width: number) {
  const cx = bulb.x + 2.5
  const cy = bulb.y + 2
  for (let y = Math.floor(cy - 4); y <= cy + 4; y++) {
    for (let x = Math.floor(cx - 6); x <= cx + 6; x++) {
      if (x < 0 || x >= width) continue
      const d = Math.hypot((x - cx) / 1.6, y - cy) / 4
      // Only the nearer glow is drawn: faint dots everywhere would be noise, not light.
      if (d < 0.45) blendPixel(p, x, y, 0xffb43c, (1 - d) * 0.45)
    }
  }
}

function sparkleTrail(p: Pixels, bulb: Swimmer, t: number, width: number) {
  if (!bulb.isLeaping) return
  for (let k = 1; k <= 6; k++) {
    const x = Math.round(bulb.x + 2.5 - k * 1.3)
    const y = Math.round(bulb.y + 3 + k * 0.6 + Math.sin(t * 20 + k) * 0.6)
    if (x >= 0 && x < width && hash(k + Math.floor(t * 12)) > 0.35) blendPixel(p, x, y, 0xfff0a0, 1 - k / 7)
  }
}

function swimmer(p: Pixels, bulb: Swimmer) {
  SWIMMER.forEach((line, sy) => {
    for (let sx = 0; sx < 5; sx++) {
      const ch = line[sx]
      const colour = ch === 'G' ? bulb.glass : ch === 'H' ? mix(bulb.glass, 0xffffff, 0.7) : ch === 'S' ? BASE : ch === 'D' ? 0x5a5f66 : -1
      if (colour >= 0) put(p, Math.round(bulb.x) + sx, Math.round(bulb.y) + sy, colour)
    }
  })
}

function waves(p: Pixels, t: number, width: number) {
  for (let x = 0; x < width; x++) {
    const level = p.h - 2.6 + Math.sin(x * 0.35 + t * 3) * 0.7 + Math.sin(x * 0.11 - t * 1.7) * 0.4
    for (let y = Math.max(0, Math.floor(level)); y < p.h; y++) {
      const isCrest = y === Math.floor(level)
      // Over whatever swam into it: the crest bright, the depth see-through.
      blendPixel(p, x, y, isCrest ? CREST : mix(0x0a3d7a, 0x041c3d, (y - level) / 3), isCrest ? 0.9 : 0.72)
    }
  }
}

function equaliser(p: Pixels, t: number, left: number, width: number) {
  for (let y = 0; y < p.h; y++) put(p, left - 1, y, 0x1b2a44)
  for (let b = 0; b < Math.floor(width / 2); b++) {
    const level = Math.abs(Math.sin(t * (3.1 + b * 0.7) + b * 1.9) * 0.6 + Math.sin(t * 7.3 + b) * 0.4)
    const height = Math.round(level * (p.h - 1))
    for (let k = 0; k < height; k++) put(p, left + b * 2, p.h - 1 - k, k / p.h > 0.75 ? RED : k / p.h > 0.5 ? AMBER : GREEN)
    const peak = p.h - 1 - Math.round(Math.max(level, Math.abs(Math.sin(t * 1.3 + b))) * (p.h - 1))
    put(p, left + b * 2, Math.max(0, peak), 0xdfe8ff)
  }
}

function put(p: Pixels, x: number, y: number, colour: number) {
  if (x < 0 || y < 0 || x >= p.w || y >= p.h) return
  p.px[y * p.w + x] = colour
}

/** Blends over the pixel; an empty one counts as the panel, so glow fades into it. */
function blendPixel(p: Pixels, x: number, y: number, colour: number, alpha: number) {
  if (x < 0 || y < 0 || x >= p.w || y >= p.h) return
  const i = y * p.w + x
  p.px[i] = mix(p.px[i] || PANEL, colour, Math.min(1, Math.max(0, alpha)))
}

/** Each cell's upper pixel as the top 2 x 2 dots, its lower as the bottom 2 x 2; the brighter one colours it. */
function encodePixels(p: Pixels): string {
  const rows = p.h / 2
  const bytes = new Uint8Array(p.w * rows * 12)
  const view = new DataView(bytes.buffer)
  for (let row = 0; row < rows; row++) {
    for (let x = 0; x < p.w; x++) {
      const upper = p.px[2 * row * p.w + x] ?? 0
      const lower = p.px[(2 * row + 1) * p.w + x] ?? 0
      const bits = (upper ? 0x1b : 0) | (lower ? 0xe4 : 0)
      const colour = upper && lower ? (luminance(upper) >= luminance(lower) ? upper : lower) : upper || lower || PANEL
      const o = (row * p.w + x) * 12
      view.setUint32(o, bits ? 0x2800 + bits : 0x20, true)
      view.setUint32(o + 4, colour, true)
      view.setUint32(o + 8, PANEL, true)
    }
  }
  return base64(bytes)
}

function mix(a: number, b: number, u: number): number {
  const ch = (shift: number) => Math.round(((a >> shift) & 255) + (((b >> shift) & 255) - ((a >> shift) & 255)) * u)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

// ---------------------------------------------------------------- scenes

/** Each device glides in to its own slot and then goes the way the run (or call) sent it. */
function switchScene(c: Canvas, t: number, lamps: Lamp[]) {
  const shown = lamps.slice(0, 3)
  const slot = Math.floor(c.w / Math.max(1, shown.length))
  shown.forEach((lamp, i) => {
    const target = slot * i + Math.floor(slot / 2) - 3
    const x = glide(t - i * 0.15, target)
    const at = 0.9 + i * 0.35
    let lit = lamp.isOn ? 0 : 1
    if (t >= at && t < at + 0.35) lit = flicker(t, i) ? 1 : 0
    else if (t >= at + 0.35) lit = lamp.isOn ? 1 : Math.max(0, 1 - (t - at - 0.35) * 3)
    const isLit = lit >= 1 && (lamp.isOn ? t >= at + 0.35 : t < at)
    const kind = spriteFor(lamp.domain)
    drawDevice(c, { kind, x, y: 0, lit, halo: isLit && kind === 'light' ? 0.6 + 0.4 * Math.sin(t * 6 + i) : 0, t })

    const isDone = t >= at + 0.35
    const words = isDone ? `${lamp.label} ${stateWords(lamp.domain, lamp.isOn)}` : lamp.label
    caption(c, words, Math.floor((slot * i) / 2), Math.floor(slot / 2), isDone ? (lamp.isOn ? GREEN : QUIET) : QUIET)
  })
}

/** A bulb lowered into its socket, screwed in, and lit for a moment. */
function savedScene(c: Canvas, t: number, words: string) {
  const x = Math.floor(c.w / 2) - 3
  const y = t < 0.7 ? Math.round(-12 * (1 - easeOut(t / 0.7))) : 0
  const turn = t >= 0.7 && t < 1.5 ? Math.floor(t * 10) : 0
  const lit = t < 1.5 ? 0 : t < 2.3 ? 1 : Math.max(0.3, 1 - (t - 2.3) * 1.5)
  drawDevice(c, { kind: 'light', x, y, lit, halo: t >= 1.5 && t < 2.3 ? 0.8 : 0, t, turn })
  if (t >= 0.7) caption(c, words, 0, c.w / 2, AMBER)
}

/** A bulb that comes in, tries, and stays dark: a condition said no. */
function stoppedScene(c: Canvas, t: number, words: string) {
  const x = glide(t, Math.floor(c.w / 2) - 3)
  const lit = t >= 0.9 && t < 1.6 ? (flicker(t, 7) ? 0.35 : 0) : 0
  drawDevice(c, { kind: 'light', x, y: 0, lit, halo: 0, t })
  if (t >= 1.0) caption(c, words, 0, c.w / 2, AMBER)
}

/** A bulb that lights too bright and pops. */
function errorScene(c: Canvas, t: number, words: string) {
  const x = glide(t, Math.floor(c.w / 2) - 3)
  const isPopped = t >= 1.3
  const isLit = t >= 0.9 && !isPopped
  drawDevice(c, { kind: 'light', x, y: 0, lit: isLit ? 1 : 0, halo: isLit ? 1 : 0, t, isBroken: isPopped })
  if (isPopped) sparks(c, t - 1.3, x + 3, 4)
  if (t >= 1.0) caption(c, words, 0, c.w / 2, RED)
}

/** A run that touched no device: one bulb blinks twice to say it happened. */
function ranScene(c: Canvas, t: number, words: string) {
  const x = glide(t, Math.floor(c.w / 2) - 3)
  const isOn = (t >= 1.0 && t < 1.3) || (t >= 1.5 && t < 1.8)
  drawDevice(c, { kind: 'light', x, y: 0, lit: isOn ? 1 : 0, halo: isOn ? 0.7 : 0, t })
  if (t >= 1.0) caption(c, words, 0, c.w / 2, GREEN)
}

// ---------------------------------------------------------------- drawing

function drawDevice(c: Canvas, d: DeviceDraw) {
  const sprite = DEVICES[d.kind] ?? DEVICES.light!
  const isOn = d.lit > 0.5
  // Off shows the first frame; on animates through them (or shows the second, its "on" pose).
  const index = !isOn ? 0 : sprite.rate > 0 ? Math.floor(d.t * sprite.rate) % sprite.frames.length : sprite.frames.length - 1
  const rows = sprite.frames[index] ?? sprite.frames[0]!
  const ox = Math.round(d.x)
  const oy = Math.round(d.y)
  const lastRow = d.bodyOnly ? 7 : 11

  rows.forEach((line, row) => {
    if (row > lastRow) return
    for (let col = 0; col < 7; col++) {
      const ch = line[col]
      const x = ox + col
      const y = oy + row
      if (d.below && y > d.below(x)) continue // under the water
      if (ch === '#' && !d.isBroken) set(c, x, y, isOn ? sprite.colour : OUTLINE)
      else if (ch === 'o' && !d.isBroken && d.lit > 0 && hash(col * 13 + row * 7) < d.lit) set(c, x, y, sprite.colour)
      else if (ch === '*' && isOn) set(c, x, y, sprite.accent)
      else if (ch === '=') {
        // Screwing in: the thread's dots trade places as it turns.
        const isThread = (d.turn ?? 0) % 2 === 1 ? row % 2 === 1 : row % 2 === 0
        if (d.kind !== 'light' || isThread || row === 11) set(c, x, y, BASE)
      }
    }
  })

  if (d.halo > 0) {
    const cx = ox + 3
    const cy = oy + 4
    for (let ray = 0; ray < 8; ray++) {
      const angle = (ray / 8) * Math.PI * 2 + Math.PI / 8
      const reach = 1 + Math.round(d.halo * 2)
      for (let k = 0; k < reach; k++) {
        const r = 5.5 + k
        set(c, Math.round(cx + Math.cos(angle) * r * 1.3), Math.round(cy + Math.sin(angle) * r * 0.8), HALO)
      }
    }
  }
}

function sparks(c: Canvas, s: number, cx: number, cy: number) {
  for (let k = 0; k < 16; k++) {
    const angle = (k / 16) * Math.PI * 2 + hash(k) * 0.4
    const speed = 6 + hash(k * 3.1) * 8
    const x = Math.round(cx + Math.cos(angle) * speed * s * 1.8)
    const y = Math.round(cy + Math.sin(angle) * speed * s + 10 * s * s)
    if (s < 1.6) set(c, x, y, hash(k * 7) > 0.5 ? SPARK : RED)
  }
}

/** Text in the caption row, centred in a span of cells and cut to fit. */
function caption(c: Canvas, words: string, left: number, span: number, colour: number) {
  const width = Math.max(1, Math.floor(span))
  const text = words.length > width ? `${words.slice(0, width - 1)}…` : words
  c.caption.push({ text, x: left + Math.floor((width - text.length) / 2), colour })
}

function canvas(columns: number): Canvas {
  const w = columns * 2
  const h = (FX_ROWS - 1) * 4
  return { w, h, px: new Uint32Array(w * h), caption: [] }
}

function set(c: Canvas, x: number, y: number, colour: number) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return
  c.px[y * c.w + x] = colour
}

// ---------------------------------------------------------------- cells

// Braille dot bits by [x][y] within a cell.
const DOT_BITS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

/** Braille cells for the dots, then the caption row; u32 little-endian triplets, base64. */
function encode(c: Canvas, columns: number): string {
  const bytes = new Uint8Array(columns * FX_ROWS * 12)
  const view = new DataView(bytes.buffer)
  const put = (cell: number, code: number, fg: number) => {
    view.setUint32(cell * 12, code, true)
    view.setUint32(cell * 12 + 4, fg, true)
    view.setUint32(cell * 12 + 8, PANEL, true)
  }

  for (let row = 0; row < FX_ROWS - 1; row++) {
    for (let col = 0; col < columns; col++) {
      let bits = 0
      let colour = PANEL
      let brightest = -1
      for (let dx = 0; dx < 2; dx++) {
        for (let dy = 0; dy < 4; dy++) {
          const dot = c.px[(row * 4 + dy) * c.w + col * 2 + dx] ?? 0
          if (dot === 0) continue
          bits |= DOT_BITS[dx]![dy]!
          const light = luminance(dot)
          if (light > brightest) {
            brightest = light
            colour = dot
          }
        }
      }
      put(row * columns + col, bits ? 0x2800 + bits : 0x20, colour)
    }
  }

  const base = (FX_ROWS - 1) * columns
  for (let col = 0; col < columns; col++) put(base + col, 0x20, PANEL)
  for (const line of c.caption) {
    for (let i = 0; i < line.text.length; i++) {
      const col = line.x + i
      if (col < 0 || col >= columns) continue
      const code = line.text.charCodeAt(i)
      // Printable, width-1 BMP characters only; anything else is a dot.
      const isPrintable = code >= 0x20 && code !== 0x7f && !(code >= 0xd800 && code <= 0xdfff) && code < 0x1100
      put(base + col, isPrintable || code === 0x2026 || code === 0x203a ? code : 0xb7, line.colour)
    }
  }
  return base64(bytes)
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? ALPHABET[n & 63]! : '='
  }
  return out
}

// ---------------------------------------------------------------- small things

/** From off the left edge to `target`, easing out, over 0.8 s. */
function glide(t: number, target: number): number {
  return -9 + (target + 9) * easeOut(Math.min(1, Math.max(0, t / 0.8)))
}

function easeOut(u: number): number {
  return 1 - (1 - u) ** 3
}

function flicker(t: number, seed: number): boolean {
  return hash(Math.floor(t * 25) + seed * 17) > 0.45
}

function luminance(colour: number): number {
  return ((colour >> 16) & 255) * 0.3 + ((colour >> 8) & 255) * 0.59 + (colour & 255) * 0.11
}

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}
