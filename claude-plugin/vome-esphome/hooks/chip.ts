// The dot-matrix stage over the ESPHome pane: a chip on the bench, and what
// is happening to it. Compiling, source files tumble into a spinning gear and
// bits stream out of it into the chip, whose flash fills as the build goes and
// whose pins run a rainbow chase; flashing, radio waves cross to its antenna;
// checking, a magnifier scans lines of code; reading logs, a heartbeat runs.
// A good build ends in fireworks and a green LED; a failed one in sparks and
// smoke. Pure: one frame per call, as braille Raster cells (2 x 4 dots a cell,
// one colour a cell), the last row a caption.

export const STRIP_ROWS = 6

export type ChipState = {
  outcome: 'running' | 'ok' | 'failed'
  /** What is happening, which picks the scene. */
  command: string
  /** Build or upload progress where known, else null. */
  percent: number | null
  words: string
  /** When the build ended, for the fireworks or smoke after it. */
  endedAt: number | null
}

const PANEL = 0x0b1020
const BODY = 0x3a4252
const EDGE = 0x8e96a3
const PIN = 0xc9a227
const PACKET = 0x64d2ff
const PAGE = 0xd8dee9
const AMBER = 0xffb43c
const GREEN = 0x30d158
const RED = 0xff453a
const SMOKE = 0x6b7280
const QUIET = 0x8e96a3

type Canvas = { w: number; h: number; px: Uint32Array }

export function chipFrame(now: number, state: ChipState, columns: number): string {
  const c: Canvas = { w: columns * 2, h: (STRIP_ROWS - 1) * 4, px: new Uint32Array(columns * 2 * (STRIP_ROWS - 1) * 4) }
  const t = now / 1000
  const isRunning = state.outcome === 'running'

  // The chip: right of centre, pins above and below.
  const cw = 26
  const ch = 10
  const left = Math.max(cw, Math.min(c.w - cw - 8, Math.floor(c.w * 0.6)))
  const top = 5
  const cy = top + Math.floor(ch / 2)
  // The source on the left: a gear, a radio mast, a page of code or a probe.
  const sx = Math.max(10, Math.floor(left * 0.35))

  if (isRunning) {
    if (state.command === 'upload') radio(c, t, sx, cy, left)
    else if (state.command === 'validate') scan(c, t, sx, cy)
    else if (state.command === 'logs') heartbeat(c, t, left, cy)
    else compiling(c, t, sx, cy, left, state.percent)
  }

  // The body, and the flash inside it filling with the build.
  for (let y = top; y < top + ch; y++) {
    for (let x = left; x < left + cw; x++) {
      const isEdge = y === top || y === top + ch - 1 || x === left || x === left + cw - 1
      // Round dots, not a block: the outline, and a sparse grid inside it.
      if (isEdge) set(c, x, y, EDGE)
      else if ((x - left) % 2 === 0 && (y - top) % 2 === 0) set(c, x, y, BODY)
    }
  }
  const fill = state.outcome === 'ok' ? 100 : state.percent
  if (fill !== null) {
    const filled = Math.round((fill / 100) * (cw - 4))
    for (let x = 0; x < filled; x++) {
      for (let y = top + 3; y < top + ch - 2; y++) set(c, left + 2 + x, y, x === filled - 1 && isRunning ? PAGE : state.outcome === 'failed' ? RED : PACKET)
    }
  }

  // Pins: a rainbow chase while it works, steady green or red at the end.
  const pinCount = Math.floor((cw - 2) / 3)
  for (let i = 0; i < pinCount; i++) {
    const x = left + 2 + i * 3
    const lit = isRunning ? (i + Math.floor(t * 12)) % 5 === 0 || (pinCount - i + Math.floor(t * 12)) % 7 === 0 : true
    const colour = !lit ? PIN : isRunning ? hue((i / pinCount + t * 0.4) % 1) : state.outcome === 'ok' ? GREEN : RED
    for (const y of [top - 1, top - 2, top + ch, top + ch + 1]) set(c, x, y, colour)
  }
  // Its antenna, top right, and the LED top left.
  for (let y = top - 4; y < top - 2; y++) set(c, left + cw - 3, y, EDGE)
  const led = state.outcome === 'ok' ? GREEN : state.outcome === 'failed' ? RED : Math.floor(t * 4) % 2 === 0 ? AMBER : BODY
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) set(c, left + 3 + dx, top + 1 + dy, led)

  const since = state.endedAt === null ? Infinity : (now - state.endedAt) / 1000
  if (state.outcome === 'ok' && since < 4) fireworks(c, since, left + cw / 2, cw)
  if (state.outcome === 'failed' && since < 5) smoke(c, t, since, left, cw, top)

  return encode(c, columns, state.words, state.outcome === 'ok' ? GREEN : state.outcome === 'failed' ? RED : QUIET)
}

// ---------------------------------------------------------------- scenes

/** Pages fall into a turning gear; bits come out and run, wavy, to the chip. */
function compiling(c: Canvas, t: number, sx: number, cy: number, left: number, percent: number | null) {
  const r = 5
  for (let a = 0; a < 24; a++) {
    const angle = (a / 24) * Math.PI * 2
    set(c, Math.round(sx + Math.cos(angle) * r * 1.4), Math.round(cy + Math.sin(angle) * r * 0.8), EDGE)
  }
  for (let k = 0; k < 6; k++) {
    const angle = t * 3 + (k / 6) * Math.PI * 2
    for (let d = r; d <= r + 2; d++) set(c, Math.round(sx + Math.cos(angle) * d * 1.4), Math.round(cy + Math.sin(angle) * d * 0.8), AMBER)
  }
  set(c, sx, cy, AMBER)
  // Source files tumbling in from the left.
  for (let k = 0; k < 3; k++) {
    const p = (t * 0.6 + k / 3) % 1
    const x = Math.round(p * (sx - 9))
    const y = Math.round(cy - 6 + p * 5)
    for (let dx = 0; dx < 3; dx++) for (let dy = 0; dy < 4; dy++) set(c, x + dx, y + dy, dy === 0 && dx === 2 ? BODY : PAGE)
  }
  // Bits to the chip, faster as the build gets on.
  const speed = 24 + (percent ?? 0) * 0.4
  const run = Math.max(1, left - (sx + 10))
  for (let k = 0; k < 9; k++) {
    const d = (t * speed + k * (run / 9)) % run
    set(c, Math.round(sx + 10 + d), Math.round(cy + Math.sin(d / 5 + k) * 2), k % 3 === 0 ? PAGE : PACKET)
  }
}

/** A mast on the left sends rings of radio across to the chip. */
function radio(c: Canvas, t: number, sx: number, cy: number, left: number) {
  for (let y = cy - 6; y <= cy + 6; y++) set(c, sx, y, EDGE)
  for (let d = 1; d <= 4; d++) {
    set(c, sx - d, cy + 6 + Math.floor(d / 2), EDGE)
    set(c, sx + d, cy + 6 + Math.floor(d / 2), EDGE)
  }
  const span = Math.max(1, left - sx)
  for (let k = 0; k < 4; k++) {
    const r = ((t * 22 + k * (span / 4)) % span) + 2
    const fade = 1 - r / span
    if (fade <= 0.15) continue
    for (let a = -9; a <= 9; a++) {
      const angle = (a / 9) * 0.9
      set(c, Math.round(sx + Math.cos(angle) * r), Math.round(cy - 6 + Math.sin(angle) * r * 0.45), fade > 0.5 ? PACKET : EDGE)
    }
  }
}

/** Lines of code on the left, a magnifier sliding down them, ticked green behind it. */
function scan(c: Canvas, t: number, sx: number, cy: number) {
  const rows = 7
  const at = (t * 2.5) % rows
  for (let row = 0; row < rows; row++) {
    const y = cy - 7 + row * 2
    const indent = (row % 3) * 2
    const length = 8 + ((row * 7) % 9)
    for (let x = indent; x < indent + length; x++) set(c, x + sx - 8, y, row < at ? GREEN : PAGE)
  }
  const gy = cy - 7 + at * 2
  const gx = sx + 4
  for (let a = 0; a < 16; a++) {
    const angle = (a / 16) * Math.PI * 2
    set(c, Math.round(gx + Math.cos(angle) * 4), Math.round(gy + Math.sin(angle) * 2.5), AMBER)
  }
  for (let d = 0; d < 4; d++) set(c, gx + 3 + d, Math.round(gy + 2 + d * 0.7), AMBER)
}

/** A heartbeat trace running out of the chip to the left. */
function heartbeat(c: Canvas, t: number, left: number, cy: number) {
  const shift = Math.floor(t * 30)
  for (let x = 0; x < left - 1; x++) {
    const phase = (x + shift) % 40
    const y = phase === 20 ? cy - 6 : phase === 21 ? cy + 4 : phase === 22 ? cy - 2 : cy
    set(c, left - 2 - x, y, x < 20 ? GREEN : x < 50 ? PACKET : EDGE)
  }
}

/** Three bursts, coloured, falling a little as they open. */
function fireworks(c: Canvas, since: number, centre: number, cw: number) {
  for (let b = 0; b < 3; b++) {
    const age = since - b * 0.5
    if (age < 0 || age > 1.8) continue
    const bx = centre + (b - 1) * cw * 0.9
    const by = 6 + (b % 2) * 4
    const r = age * 9
    for (let k = 0; k < 14; k++) {
      const angle = (k / 14) * Math.PI * 2 + b
      const bright = hue((b * 0.3 + k / 14) % 1)
      set(c, Math.round(bx + Math.cos(angle) * r * 1.6), Math.round(by + Math.sin(angle) * r + age * age * 2), age > 1.3 ? (bright >> 1) & 0x7f7f7f : bright)
    }
  }
}

/** Sparks off the chip at once, then smoke drifting up and away to the right. */
function smoke(c: Canvas, t: number, since: number, left: number, cw: number, top: number) {
  if (since < 0.8) {
    for (let k = 0; k < 8; k++) {
      const angle = (k / 8) * Math.PI * 2 + t * 9
      const r = 3 + since * 10
      if (Math.sin(t * 40 + k) > 0) set(c, Math.round(left + cw / 2 + Math.cos(angle) * r * 1.5), Math.round(top + 4 + Math.sin(angle) * r * 0.6), k % 2 ? AMBER : RED)
    }
  }
  for (let k = 0; k < 14; k++) {
    const rise = ((since * 2.5 + k * 0.45) % 5) * 1.6
    set(c, Math.round(left + cw - 4 + rise * 2.2 + Math.sin(t * 2 + k) * 1.5), Math.round(top + 8 - rise * 0.8), SMOKE)
  }
}

// ---------------------------------------------------------------- drawing

/** A bright colour round the wheel, h from 0 to 1. */
function hue(h: number): number {
  const f = (n: number) => {
    const k = (n + h * 6) % 6
    return Math.round(255 * (1 - Math.max(0, Math.min(1, Math.min(k, 4 - k)))))
  }
  return (f(5) << 16) | (f(3) << 8) | f(1) || PAGE
}

function set(c: Canvas, x: number, y: number, colour: number) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return
  c.px[y * c.w + x] = colour
}

const DOT_BITS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

function encode(c: Canvas, columns: number, words: string, colour: number): string {
  const bytes = new Uint8Array(columns * STRIP_ROWS * 12)
  const view = new DataView(bytes.buffer)
  const put = (cell: number, code: number, fg: number) => {
    view.setUint32(cell * 12, code, true)
    view.setUint32(cell * 12 + 4, fg, true)
    view.setUint32(cell * 12 + 8, PANEL, true)
  }
  for (let row = 0; row < STRIP_ROWS - 1; row++) {
    for (let col = 0; col < columns; col++) {
      let bits = 0
      let fg = PANEL
      for (let dx = 0; dx < 2; dx++) {
        for (let dy = 0; dy < 4; dy++) {
          const dot = c.px[(row * 4 + dy) * c.w + col * 2 + dx] ?? 0
          if (!dot) continue
          bits |= DOT_BITS[dx]![dy]!
          // A cell has one colour: the liveliest dot in it wins over the chip's grey.
          if (fg === PANEL || (dot !== BODY && dot !== EDGE)) fg = dot
        }
      }
      put(row * columns + col, bits ? 0x2800 + bits : 0x20, fg)
    }
  }
  const base = (STRIP_ROWS - 1) * columns
  const text = words.length > columns ? `${words.slice(0, columns - 1)}…` : words
  const start = Math.max(0, Math.floor((columns - text.length) / 2))
  for (let col = 0; col < columns; col++) {
    const i = col - start
    const code = i >= 0 && i < text.length ? text.charCodeAt(i) : 0x20
    const isPrintable = code >= 0x20 && code !== 0x7f && code < 0x1100
    put(base + col, isPrintable || code === 0x2026 || code === 0x2713 || code === 0x2717 ? code : 0xb7, colour)
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
