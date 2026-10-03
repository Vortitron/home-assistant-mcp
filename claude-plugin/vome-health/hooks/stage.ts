// The dot-matrix strip over the health pane: the home's score in big round
// dots, a heart beating beside it and a pulse running underneath, coloured by
// how the home is doing. While a check runs a sweep crosses the strip; when a
// new score lands it rolls up (or down) to it, with fireworks for a better one.
// Pure: one frame per call, as braille Raster cells (2 x 4 dots a cell, one
// colour a cell), the last row a caption.

export const STRIP_ROWS = 6

export type StageState = {
  /** The score shown, out of 100; null before there is one. */
  score: number | null
  /** The score before the latest check, rolled from when it changed. */
  from: number | null
  changedAt: number | null
  isChecking: boolean
  words: string
}

const PANEL = 0x0b1020
const DIM = 0x3a4252
const PAGE = 0xd8dee9
const PACKET = 0x64d2ff
const GREEN = 0x30d158
const AMBER = 0xffb43c
const RED = 0xff453a
const QUIET = 0x8e96a3

const ROLL_MS = 2_400
const PARTY_MS = 3_200

/** 5 x 7 digits, a row a string. */
const FONT: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
}
const HEART = ['0110110', '1111111', '1111111', '0111110', '0011100', '0001000']

type Canvas = { w: number; h: number; px: Uint32Array }

export function colourFor(score: number | null): number {
  if (score === null) return QUIET
  return score >= 85 ? GREEN : score >= 65 ? AMBER : RED
}

export function stageFrame(now: number, state: StageState, columns: number): string {
  const c: Canvas = { w: columns * 2, h: (STRIP_ROWS - 1) * 4, px: new Uint32Array(columns * 2 * (STRIP_ROWS - 1) * 4) }
  const t = now / 1000
  const since = state.changedAt === null ? Infinity : now - state.changedAt
  const rolling = state.from !== null && state.score !== null && since < ROLL_MS
  const shown = rolling ? Math.round(state.from! + (state.score! - state.from!) * ease(since / ROLL_MS)) : state.score
  const colour = colourFor(shown)

  // The score, big, at two dots a font pixel; "/100" small beside it.
  const text = state.isChecking && state.score === null ? '??' : shown === null ? '?' : String(shown)
  const scale = 2
  const glyphW = 5 * scale + 2
  const left = Math.max(2, Math.floor(c.w / 2) - Math.floor((text.length * glyphW + 22) / 2))
  const top = 1
  for (const [i, ch] of [...text].entries()) {
    const shimmer = state.isChecking ? 0.45 + 0.35 * Math.sin(t * 4 + i) : 1
    glyph(c, FONT[ch] ?? FONT['?']!, left + i * glyphW, top, scale, scale_(colour, shimmer))
  }
  const after = left + text.length * glyphW + 1
  for (const [i, ch] of [...'/100'].entries()) glyph(c, FONT[ch] ?? FONT['?']!, after + i * 6, top + 7, 1, QUIET)

  // A heart beating to the left of it: two quick beats, then rest.
  const beat = t % 1.1
  const big = beat < 0.12 || (beat > 0.24 && beat < 0.34)
  const hx = left - 12
  if (hx > 2) glyph(c, HEART, hx, top + 4 - (big ? 1 : 0), 1, big ? colour : scale_(colour, 0.55))

  // The pulse under it, running right to left.
  const y0 = c.h - 3
  const shift = Math.floor(t * 28)
  for (let x = 0; x < c.w; x++) {
    const phase = (x + shift) % 48
    const y = phase === 20 ? y0 - 3 : phase === 21 ? y0 + 2 : phase === 22 ? y0 - 1 : y0
    const fade = 0.35 + 0.65 * (x / c.w)
    set(c, c.w - 1 - x, y, scale_(colour, fade))
  }

  // A check in progress: a sweep crossing the strip, leaving a fading trail.
  if (state.isChecking) {
    const at = ((t * 0.45) % 1) * (c.w + 20) - 10
    for (let k = 0; k < 10; k++) {
      const x = Math.round(at - k * 2)
      for (let y = 0; y < c.h - 4; y += 2) set(c, x, y + (k % 2), scale_(PACKET, 1 - k / 10))
    }
  }

  // A better score: fireworks once it has rolled up to it.
  if (state.from !== null && state.score !== null && state.score > state.from && since >= ROLL_MS && since < ROLL_MS + PARTY_MS) {
    fireworks(c, (since - ROLL_MS) / 1000, left + (text.length * glyphW) / 2, glyphW * 3)
  }

  return encode(c, columns, state.words, colour)
}

function ease(p: number): number {
  const q = Math.max(0, Math.min(1, p))
  return 1 - (1 - q) ** 3
}

function glyph(c: Canvas, rows: string[], x: number, y: number, scale: number, colour: number) {
  for (const [r, row] of rows.entries()) {
    for (const [k, bit] of [...row].entries()) {
      if (bit !== '1') continue
      for (let dx = 0; dx < scale; dx++) for (let dy = 0; dy < scale; dy++) set(c, x + k * scale + dx, y + r * scale + dy, colour)
    }
  }
}

function fireworks(c: Canvas, since: number, centre: number, spread: number) {
  for (let b = 0; b < 3; b++) {
    const age = since - b * 0.45
    if (age < 0 || age > 1.8) continue
    const bx = centre + (b - 1) * spread
    const by = 5 + (b % 2) * 4
    const r = age * 8
    for (let k = 0; k < 14; k++) {
      const angle = (k / 14) * Math.PI * 2 + b
      const bright = hue((b * 0.3 + k / 14) % 1)
      set(c, Math.round(bx + Math.cos(angle) * r * 1.6), Math.round(by + Math.sin(angle) * r + age * age * 2), age > 1.3 ? scale_(bright, 0.5) : bright)
    }
  }
}

function hue(h: number): number {
  const f = (n: number) => {
    const k = (n + h * 6) % 6
    return Math.round(255 * (1 - Math.max(0, Math.min(1, Math.min(k, 4 - k)))))
  }
  return (f(5) << 16) | (f(3) << 8) | f(1) || PAGE
}

function scale_(colour: number, by: number): number {
  const f = Math.max(0.15, Math.min(1, by))
  const r = Math.round(((colour >> 16) & 255) * f)
  const g = Math.round(((colour >> 8) & 255) * f)
  const b = Math.round((colour & 255) * f)
  return (r << 16) | (g << 8) | b || DIM
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
          if (fg === PANEL || dot !== QUIET) fg = dot
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
    put(base + col, isPrintable || code === 0x2026 || code === 0x2713 || code === 0x2192 || code === 0x2193 || code === 0x2191 ? code : 0xb7, colour)
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
