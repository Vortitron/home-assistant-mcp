// The dot-matrix strip over the ESPHome pane: a chip on the bench. While a
// build runs, packets of data stream into it and its LED blinks; a good flash
// lights it green with a few sparks, a failed one turns it red and lets a little
// smoke out. Pure: one frame per call, as braille Raster cells (2 x 4 dots a
// cell, one colour a cell), the last row a caption.

export const STRIP_ROWS = 4

export type ChipState = {
  outcome: 'running' | 'ok' | 'failed'
  /** Upload progress where known, else null. */
  percent: number | null
  words: string
  /** When the build ended, for the sparks or smoke after it. */
  endedAt: number | null
}

const PANEL = 0x0b1020
const BODY = 0x3a4252
const EDGE = 0x8e96a3
const PIN = 0xc9a227
const PACKET = 0x64d2ff
const AMBER = 0xffb43c
const GREEN = 0x30d158
const RED = 0xff453a
const SMOKE = 0x6b7280
const QUIET = 0x8e96a3

type Canvas = { w: number; h: number; px: Uint32Array }

export function chipFrame(now: number, state: ChipState, columns: number): string {
  const c: Canvas = { w: columns * 2, h: (STRIP_ROWS - 1) * 4, px: new Uint32Array(columns * 2 * (STRIP_ROWS - 1) * 4) }
  const t = now / 1000
  const cw = 18
  const cx = Math.max(cw + 4, Math.floor(c.w * 0.62))
  const left = cx - Math.floor(cw / 2)
  const top = 2

  // The trace the data runs along, and the packets on it while the build runs.
  const traceY = top + 4
  for (let x = 0; x < left; x += 3) set(c, x, traceY, BODY)
  if (state.outcome === 'running') {
    const speed = state.percent === null ? 18 : 30
    for (let k = 0; k < 6; k++) {
      const x = Math.floor((t * speed + k * (left / 6)) % Math.max(1, left))
      set(c, x, traceY, PACKET)
      set(c, x - 1, traceY, PACKET)
    }
  }

  // The chip: a body, pins along the top and bottom, its LED in the corner.
  for (let y = top; y < top + 8; y++) {
    for (let x = left; x < left + cw; x++) {
      const isEdge = y === top || y === top + 7 || x === left || x === left + cw - 1
      set(c, x, y, isEdge ? EDGE : BODY)
    }
  }
  for (let x = left + 2; x < left + cw - 2; x += 3) {
    set(c, x, top - 1, PIN)
    set(c, x, top - 2, PIN)
    set(c, x, top + 8, PIN)
    set(c, x, top + 9, PIN)
  }
  const ledColour =
    state.outcome === 'ok' ? GREEN : state.outcome === 'failed' ? RED : Math.floor(t * 4) % 2 === 0 ? AMBER : BODY
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) set(c, left + cw - 4 + dx, top + 2 + dy, ledColour)

  // Upload progress as a fill along the bottom edge of the chip.
  if (state.percent !== null && state.outcome === 'running') {
    const filled = Math.round((state.percent / 100) * (cw - 2))
    for (let x = 0; x < filled; x++) set(c, left + 1 + x, top + 6, PACKET)
  }

  const since = state.endedAt === null ? Infinity : (now - state.endedAt) / 1000
  if (state.outcome === 'ok' && since < 3) {
    for (let k = 0; k < 10; k++) {
      const angle = (k / 10) * Math.PI * 2
      const r = 4 + since * 6
      if (Math.sin(t * 20 + k) > 0) set(c, Math.round(left + cw - 3 + Math.cos(angle) * r * 1.5), Math.round(top + 2 + Math.sin(angle) * r), GREEN)
    }
  }
  if (state.outcome === 'failed' && since < 4) {
    // Smoke drifts up and away to the right: there is no room above the chip on the strip.
    for (let k = 0; k < 8; k++) {
      const rise = ((since * 3 + k * 0.7) % 3) * 3
      set(c, Math.round(left + cw + 1 + rise * 1.8 + Math.sin(t * 3 + k) * 1.2), Math.round(top + 5 - rise * 0.9), SMOKE)
    }
  }

  return encode(c, columns, state.words, state.outcome === 'ok' ? GREEN : state.outcome === 'failed' ? RED : QUIET)
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
          if (fg === PANEL || dot !== BODY) fg = dot
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
