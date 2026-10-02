// The dot-matrix stage over the ESPHome pane: a chip on the bench, and what is
// happening to it, scene by scene as the build goes rather than by command (a
// flash compiles first, then uploads).
//
// - compile: a forge. Two cogs turn and throw sparks, object files rain onto a
//   firmware block that grows with the build; the chip waits.
// - upload: from the finished block, big dots whoosh to the chip with
//   glittering tails, and the chip fills as it flashes.
// - validate: a magnifier scans lines of code. logs: a heartbeat.
// - idle: the chip with its things wired to it, from the device's map (a bulb
//   glowing, a thermometer creeping, a button blinking...), pulses running down
//   the wires. With no device known it sleeps, and dreams of devices.
// - the end: fireworks for a good build, sparks and smoke for a failed one.
//
// Pure: one frame per call, as braille Raster cells (2 x 4 dots a cell, one
// colour a cell), the last row a caption.

export const STRIP_ROWS = 6

export type Scene = 'compile' | 'upload' | 'validate' | 'logs' | 'idle'

/** Something on the device, drawn wired to the chip when it is idle. */
export type Thing = 'light' | 'thermometer' | 'droplet' | 'button' | 'battery' | 'toggle' | 'fan' | 'screen' | 'gadget'

export type ChipState = {
  outcome: 'running' | 'ok' | 'failed' | 'idle'
  scene: Scene
  /** Build or upload progress where known, else null. */
  percent: number | null
  words: string
  /** When the build ended, for the fireworks or smoke after it. */
  endedAt: number | null
  things: Thing[]
  hasWifi: boolean
}

const PANEL = 0x0b1020
const BODY = 0x3a4252
const EDGE = 0x8e96a3
const PIN = 0xc9a227
const PACKET = 0x64d2ff
const PAGE = 0xd8dee9
const AMBER = 0xffb43c
const YELLOW = 0xffe066
const GREEN = 0x30d158
const RED = 0xff453a
const SMOKE = 0x6b7280
const QUIET = 0x8e96a3
const WIRE = 0x4b5566
const NIGHT = 0x9d8cff

/** After this long, a finished build settles into the idle scene. */
const SETTLE_S = 4

type Canvas = { w: number; h: number; px: Uint32Array }
type Chip = { left: number; top: number; cw: number; ch: number; cy: number }

export function chipFrame(now: number, state: ChipState, columns: number): string {
  const c: Canvas = { w: columns * 2, h: (STRIP_ROWS - 1) * 4, px: new Uint32Array(columns * 2 * (STRIP_ROWS - 1) * 4) }
  const t = now / 1000
  const since = state.endedAt === null ? Infinity : (now - state.endedAt) / 1000
  const isSettled = state.outcome === 'idle' || (state.outcome !== 'running' && since > SETTLE_S)
  // Lined up with the braille cells (4 dots high): the body fills rows 1-3, the pins have rows of
  // their own above and below, so a pin's colour never bleeds into the body (one colour a cell).
  const cw = 26
  const ch = 12
  const top = 4
  const left = Math.max(cw, Math.min(c.w - cw - 6, Math.floor(c.w * (isSettled ? 0.5 : 0.56) - (isSettled ? cw / 2 : 0))))
  const chip: Chip = { left, top, cw, ch, cy: top + Math.floor(ch / 2) }

  if (isSettled) {
    idle(c, t, chip, state)
    return encode(c, columns, state.words, state.outcome === 'failed' ? RED : state.outcome === 'ok' ? GREEN : QUIET)
  }

  const isRunning = state.outcome === 'running'
  if (isRunning) {
    if (state.scene === 'upload') upload(c, t, chip)
    else if (state.scene === 'validate') scan(c, t, chip)
    else if (state.scene === 'logs') heartbeat(c, t, chip)
    else forge(c, t, chip, state.percent)
  }
  const fill = state.outcome === 'ok' ? 100 : state.scene === 'upload' || !isRunning ? state.percent : null
  drawChip(c, t, chip, {
    fill,
    fillColour: state.outcome === 'failed' ? RED : PACKET,
    pins: isRunning ? 'chase' : state.outcome === 'ok' ? GREEN : RED,
    led: state.outcome === 'ok' ? GREEN : state.outcome === 'failed' ? RED : Math.floor(t * (state.scene === 'upload' ? 8 : 2)) % 2 === 0 ? AMBER : BODY,
    isFilling: isRunning,
  })
  if (state.outcome === 'ok') fireworks(c, since, left + cw / 2, cw)
  if (state.outcome === 'failed') smoke(c, t, since, chip)

  return encode(c, columns, state.words, state.outcome === 'ok' ? GREEN : state.outcome === 'failed' ? RED : QUIET)
}

// ---------------------------------------------------------------- the chip

function drawChip(
  c: Canvas,
  t: number,
  { left, top, cw, ch }: Chip,
  look: { fill: number | null; fillColour: number; pins: 'chase' | number; led: number; isFilling: boolean },
) {
  for (let y = top; y < top + ch; y++) {
    for (let x = left; x < left + cw; x++) {
      const isEdge = y === top || y === top + ch - 1 || x === left || x === left + cw - 1
      // Round dots, not a block: the outline, and a sparse grid inside it.
      if (isEdge) set(c, x, y, EDGE)
      else if ((x - left) % 2 === 0 && (y - top) % 2 === 0) set(c, x, y, BODY)
    }
  }
  if (look.fill !== null) {
    const filled = Math.round((look.fill / 100) * (cw - 4))
    for (let x = 0; x < filled; x++) {
      for (let y = top + 3; y < top + ch - 2; y++) set(c, left + 2 + x, y, x === filled - 1 && look.isFilling ? PAGE : look.fillColour)
    }
  }
  const pinCount = Math.floor((cw - 2) / 3)
  for (let i = 0; i < pinCount; i++) {
    const x = left + 2 + i * 3
    let colour = typeof look.pins === 'number' ? look.pins : PIN
    if (look.pins === 'chase') {
      const lit = (i + Math.floor(t * 12)) % 5 === 0 || (pinCount - i + Math.floor(t * 12)) % 7 === 0
      if (lit) colour = hue((i / pinCount + t * 0.4) % 1)
    }
    for (const y of [top - 1, top - 2, top + ch, top + ch + 1]) set(c, x, y, colour)
  }
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) set(c, left + 3 + dx, top + 2 + dy, look.led)
}

// ---------------------------------------------------------------- building

/** Where the forge stands: the firmware block, and the two cogs left of it. */
function forgeAt({ left, cy }: Chip) {
  const bw = 10
  const bx = Math.max(16, Math.floor(left * 0.42))
  return { bx, bw, base: cy + 7, gearA: { x: bx - 21, y: cy + 2, r: 4 }, gearB: { x: bx - 9, y: cy - 3, r: 3 } }
}

/** A cog: a rim, short teeth round it and spokes inside, all turning. */
function cog(c: Canvas, x: number, y: number, r: number, turn: number, teeth: number) {
  if (x < 4) return
  const at = (angle: number, d: number) => [Math.round(x + Math.cos(angle) * d * 1.5), Math.round(y + Math.sin(angle) * d)] as const
  for (let a = 0; a < 28; a++) {
    const [px, py] = at((a / 28) * Math.PI * 2, r)
    set(c, px, py, EDGE)
  }
  for (let k = 0; k < teeth; k++) {
    const [px, py] = at(turn + (k / teeth) * Math.PI * 2, r + 1.2)
    set(c, px, py, AMBER)
  }
  for (let k = 0; k < 3; k++) {
    for (let d = 1; d < r; d++) {
      const [px, py] = at(turn + (k / 3) * Math.PI * 2, d)
      set(c, px, py, scale(AMBER, 0.7))
    }
  }
  set(c, Math.round(x), Math.round(y), YELLOW)
}

/** The firmware block: rows of dots, as high as the build is far along. */
function block(c: Canvas, bx: number, bw: number, base: number, percent: number, t: number) {
  const tall = 13
  const rows = Math.round((percent / 100) * tall)
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < bw; x++) {
      if ((x + r) % 2 === 0) set(c, bx + x, base - r, r === rows - 1 ? (Math.floor(t * 6 + x) % 3 === 0 ? PAGE : PACKET) : PACKET)
    }
  }
  // Its outline, waiting to be filled.
  for (let r = 0; r <= tall; r += 2) {
    set(c, bx - 1, base - r, WIRE)
    set(c, bx + bw, base - r, WIRE)
  }
  return base - rows
}

/** Compiling: cogs turn and spark, object files rain onto the growing firmware. */
function forge(c: Canvas, t: number, chip: Chip, percent: number | null) {
  const { bx, bw, base, gearA, gearB } = forgeAt(chip)
  cog(c, gearA.x, gearA.y, gearA.r, t * 2.2, 8)
  cog(c, gearB.x, gearB.y, gearB.r, -t * 2.2 * (gearA.r / gearB.r), 6)
  const surface = block(c, bx, bw, base, percent ?? (t * 7) % 100, t)
  // Object files, little pages, falling onto the top of the block.
  for (let k = 0; k < 3; k++) {
    const drop = Math.max(2, surface - 3)
    const run = t * 9 + k * (drop / 3)
    const fall = run % drop
    const x = bx + 1 + ((k * 3 + Math.floor(run / drop) * 4) % (bw - 3))
    const colour = hue((k * 0.33 + Math.floor(run / drop) * 0.17) % 1)
    for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) set(c, x + dx, Math.round(fall) + dy, colour)
  }
  // Sparks where the cogs meet.
  const mx = (gearA.x + gearB.x) / 2 + 2
  const my = (gearA.y + gearB.y) / 2
  for (let k = 0; k < 5; k++) {
    const life = (t * 2.4 + k * 0.21) % 1
    const angle = -Math.PI / 2 + Math.sin(k * 12.9898 + Math.floor(t * 2.4 + k * 0.21) * 4.1) * 1.3
    if (life < 0.7) set(c, Math.round(mx + Math.cos(angle) * life * 10), Math.round(my + Math.sin(angle) * life * 7 + life * life * 6), life < 0.3 ? YELLOW : AMBER)
  }
}

/** Flashing: big dots leave the finished firmware and whoosh to the chip, glittering behind. */
function upload(c: Canvas, t: number, chip: Chip) {
  const { bx, bw, base, gearA, gearB } = forgeAt(chip)
  cog(c, gearA.x, gearA.y, gearA.r, t * 0.6, 8)
  cog(c, gearB.x, gearB.y, gearB.r, -t * 0.6 * (gearA.r / gearB.r), 6)
  block(c, bx, bw, base, 100, t)
  const x0 = bx + bw + 1
  const y0 = base - 6
  const x1 = chip.left + 3
  const y1 = chip.cy
  for (let k = 0; k < 3; k++) {
    const p = (t * 0.75 + k / 3) % 1
    const at = (q: number) => {
      const e = q * q * (3 - 2 * q)
      return { x: x0 + (x1 - x0) * e, y: y0 + (y1 - y0) * e - Math.sin(e * Math.PI) * 7 }
    }
    // The glittering tail: behind the head, twinkling, fading.
    for (let j = 1; j <= 14; j++) {
      const q = p - j * 0.022
      if (q <= 0) break
      const spot = at(q)
      const twinkle = hash(j, k, Math.floor(t * 18)) % 10
      if (twinkle < 6) set(c, Math.round(spot.x + (twinkle % 3) - 1), Math.round(spot.y + ((twinkle >> 1) % 3) - 1), scale(hue((j * 0.07 + t * 0.5 + k / 3) % 1), 1 - j / 16))
    }
    const head = at(p)
    for (const [dx, dy] of [[0, -1], [-1, 0], [0, 0], [1, 0], [0, 1], [1, -1], [1, 1], [-1, -1], [-1, 1]] as const) {
      const isCorner = dx !== 0 && dy !== 0
      set(c, Math.round(head.x) + dx, Math.round(head.y) + dy, isCorner ? PACKET : PAGE)
    }
  }
}

/** Lines of code on the left, a magnifier sliding down them, ticked green behind it. */
function scan(c: Canvas, t: number, { left, cy }: Chip) {
  const sx = Math.max(10, Math.floor(left * 0.35))
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
function heartbeat(c: Canvas, t: number, { left, cy }: Chip) {
  const shift = Math.floor(t * 30)
  for (let x = 0; x < left - 1; x++) {
    const phase = (x + shift) % 40
    const y = phase === 20 ? cy - 6 : phase === 21 ? cy + 4 : phase === 22 ? cy - 2 : cy
    set(c, left - 2 - x, y, x < 20 ? GREEN : x < 50 ? PACKET : EDGE)
  }
}

// ---------------------------------------------------------------- endings

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
      set(c, Math.round(bx + Math.cos(angle) * r * 1.6), Math.round(by + Math.sin(angle) * r + age * age * 2), age > 1.3 ? scale(bright, 0.5) : bright)
    }
  }
}

/** Sparks off the chip at once, then smoke drifting up and away to the right. */
function smoke(c: Canvas, t: number, since: number, { left, cw, top }: Chip) {
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

// ---------------------------------------------------------------- idle

/** The chip at rest: its things wired to it and alive, or, with none known, its dreams. */
function idle(c: Canvas, t: number, chip: Chip, state: ChipState) {
  const { left, cw, cy, top } = chip
  const right = left + cw
  const led = state.outcome === 'failed' ? RED : state.things.length > 0 ? (Math.sin(t * 2) > 0.6 ? GREEN : scale(GREEN, 0.4)) : BODY
  drawChip(c, t, chip, { fill: null, fillColour: PACKET, pins: PIN, led, isFilling: false })
  if (state.hasWifi) {
    // On the network: a little signal in the chip's corner, breathing.
    const strength = Math.floor((t * 1.5) % 4)
    for (let k = 0; k < strength; k++) for (let d = 0; d <= k; d++) set(c, right - 5 + k, top + 3 - d, PACKET)
  }
  if (state.things.length === 0) {
    dreams(c, t, chip)
    return
  }

  // Slots: two a side close in (above and below the middle), then one a side further out.
  const slots = [
    { x: left - 12, y: cy - 4, side: -1 },
    { x: right + 11, y: cy - 4, side: 1 },
    { x: left - 12, y: cy + 5, side: -1 },
    { x: right + 11, y: cy + 5, side: 1 },
    { x: left - 28, y: cy, side: -1 },
    { x: right + 27, y: cy, side: 1 },
  ].filter(slot => slot.x > 3 && slot.x < c.w - 4)
  state.things.slice(0, slots.length).forEach((thing, i) => {
    const slot = slots[i]!
    const from = slot.side < 0 ? left - 1 : right
    const to = slot.x - slot.side * 4
    const span = Math.abs(to - from)
    for (let d = 0; d <= span; d += 2) set(c, from + slot.side * d, slot.y, WIRE)
    // A pulse now and then, out to the thing.
    const p = (t * 0.5 + i * 0.37) % 1
    if (p < 0.5) set(c, Math.round(from + slot.side * span * (p * 2)), slot.y, PACKET)
    sprite(c, t + i * 1.7, thing, slot.x, slot.y)
  })
}

function sprite(c: Canvas, t: number, thing: Thing, x: number, y: number) {
  switch (thing) {
    case 'light': {
      const glow = 0.55 + 0.45 * Math.sin(t * 1.6)
      ring(c, x, y - 1, 2.6, 1.4, scale(YELLOW, glow))
      set(c, x, y - 1, scale(YELLOW, glow))
      for (const dx of [-1, 0, 1]) set(c, x + dx, y + 2, EDGE)
      set(c, x, y + 3, EDGE)
      if (glow > 0.9) for (const [dx, dy] of [[-4, -1], [4, -1], [0, -4]] as const) set(c, x + dx, y + dy, YELLOW)
      return
    }
    case 'thermometer': {
      for (let dy = -3; dy <= 1; dy++) {
        set(c, x - 1, y + dy, EDGE)
        set(c, x + 1, y + dy, EDGE)
      }
      const level = Math.round(1 + (Math.sin(t * 0.9) + 1) * 1.5)
      for (let d = 0; d < level; d++) set(c, x, y + 1 - d, RED)
      ring(c, x, y + 3, 1.4, 1, RED)
      set(c, x, y + 3, RED)
      return
    }
    case 'droplet': {
      const sway = Math.round(Math.sin(t * 1.3) * 0.6)
      set(c, x + sway, y - 3, PACKET)
      for (const dx of [-1, 1]) set(c, x + dx + sway, y - 1, PACKET)
      ring(c, x + sway, y + 1, 1.8, 1.4, PACKET)
      return
    }
    case 'button': {
      for (let d = -2; d <= 2; d++) {
        set(c, x + d, y - 2, EDGE)
        set(c, x + d, y + 2, EDGE)
        set(c, x - 2, y + d, EDGE)
        set(c, x + 2, y + d, EDGE)
      }
      const isPressed = (t % 3) < 0.35
      set(c, x, y, isPressed ? GREEN : AMBER)
      if (isPressed) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) set(c, x + dx, y + dy, GREEN)
      return
    }
    case 'battery': {
      for (let d = -3; d <= 3; d++) {
        set(c, x + d, y - 2, EDGE)
        set(c, x + d, y + 2, EDGE)
      }
      for (let d = -2; d <= 2; d++) {
        set(c, x - 3, y + d, EDGE)
        set(c, x + 3, y + d, EDGE)
      }
      set(c, x + 4, y, EDGE)
      const level = Math.floor((t * 0.8) % 6)
      for (let d = 0; d < level; d++) for (const dy of [-1, 0, 1]) set(c, x - 2 + d, y + dy, level > 2 ? GREEN : AMBER)
      return
    }
    case 'toggle': {
      ring(c, x, y, 3.2, 1.6, EDGE)
      const isOn = Math.floor(t / 2.5) % 2 === 0
      for (const [dx, dy] of [[0, 0], [1, 0], [0, -1], [1, -1]] as const) set(c, x + (isOn ? 1 : -2) + dx, y + dy + 1 - 1, isOn ? GREEN : QUIET)
      return
    }
    case 'fan': {
      set(c, x, y, EDGE)
      for (let k = 0; k < 3; k++) {
        const angle = t * 6 + (k / 3) * Math.PI * 2
        for (let d = 1; d <= 3; d++) set(c, Math.round(x + Math.cos(angle) * d * 1.3), Math.round(y + Math.sin(angle) * d * 0.8), PACKET)
      }
      return
    }
    case 'screen': {
      for (let d = -3; d <= 3; d++) {
        set(c, x + d, y - 2, EDGE)
        set(c, x + d, y + 2, EDGE)
      }
      for (const dy of [-1, 0, 1]) {
        set(c, x - 3, y + dy, EDGE)
        set(c, x + 3, y + dy, EDGE)
      }
      const scroll = Math.floor(t * 4) % 5
      for (let d = 0; d < 3; d++) set(c, x - 2 + ((scroll + d) % 5), y - 1 + (d % 3), PACKET)
      return
    }
    default: {
      ring(c, x, y, 2, 1.5, EDGE)
      if (Math.floor(t * 2) % 2 === 0) set(c, x, y, PACKET)
    }
  }
}

/** Asleep: Zs drift up to a thought cloud, where the devices it could be come and go under the stars. */
function dreams(c: Canvas, t: number, { left, cw, top, cy }: Chip) {
  const right = left + cw
  // Eyes closed: two little smiles in the body.
  for (const ex of [left + 8, left + cw - 10]) for (const [dx, dy] of [[0, 0], [1, 1], [2, 1], [3, 0]] as const) set(c, ex + dx, cy + dy - 1, PAGE)
  const cx = Math.min(c.w - 14, right + 20)
  const cyCloud = 9
  // The cloud: a few overlapping puffs.
  // Puffs, of which only the outline is drawn: a dot inside one, beside a dot in none.
  const puffs = [[-8, 1, 6.5, 4], [0, -3, 7.5, 4.5], [8, 1, 6.5, 4], [0, 4, 11, 3]] as const
  const isIn = (x: number, y: number) => puffs.some(([dx, dy, rx, ry]) => ((x - cx - dx) / rx) ** 2 + ((y - cyCloud - dy) / ry) ** 2 <= 1)
  for (let y = 0; y < c.h; y++) {
    for (let x = cx - 20; x <= cx + 20; x++) {
      if (isIn(x, y) && (!isIn(x - 1, y) || !isIn(x + 1, y) || !isIn(x, y - 1) || !isIn(x, y + 1))) set(c, x, y, scale(NIGHT, 0.6))
    }
  }
  // What it dreams of, one after another.
  const dreamt: Thing[] = ['light', 'thermometer', 'fan', 'button', 'droplet', 'screen']
  sprite(c, t, dreamt[Math.floor(t / 2.5) % dreamt.length]!, cx, cyCloud)
  // Stars twinkling round it.
  for (let k = 0; k < 6; k++) {
    if (hash(k, 3, Math.floor(t * 3)) % 3 === 0) continue
    set(c, Math.round(cx - 14 + ((k * 11) % 30)), (k * 5) % 3 === 0 ? 0 : (k * 7) % 4, k % 2 ? YELLOW : PAGE)
  }
  // Zs rising from the chip towards the cloud, small to large.
  for (let k = 0; k < 3; k++) {
    const p = (t * 0.3 + k / 3) % 1
    const zx = Math.round(right + 1 + (cx - 16 - (right + 1)) * p)
    const zy = Math.round(top + 5 - p * 4)
    const size = p < 0.35 ? 3 : 4
    const colour = scale(NIGHT, 1 - p * 0.5)
    for (let d = 0; d < size; d++) {
      set(c, zx + d, zy - size + 1, colour)
      set(c, zx + d, zy, colour)
      set(c, zx + size - 1 - d, zy - size + 1 + d, colour)
    }
  }
}

// ---------------------------------------------------------------- drawing

function ring(c: Canvas, x: number, y: number, rx: number, ry: number, colour: number) {
  const steps = Math.max(10, Math.round((rx + ry) * 4))
  for (let a = 0; a < steps; a++) {
    const angle = (a / steps) * Math.PI * 2
    set(c, Math.round(x + Math.cos(angle) * rx), Math.round(y + Math.sin(angle) * ry), colour)
  }
}

/** A bright colour round the wheel, h from 0 to 1. */
function hue(h: number): number {
  const f = (n: number) => {
    const k = (n + h * 6) % 6
    return Math.round(255 * (1 - Math.max(0, Math.min(1, Math.min(k, 4 - k)))))
  }
  return (f(5) << 16) | (f(3) << 8) | f(1) || PAGE
}

function scale(colour: number, by: number): number {
  const f = Math.max(0.15, Math.min(1, by))
  const r = Math.round(((colour >> 16) & 255) * f)
  const g = Math.round(((colour >> 8) & 255) * f)
  const b = Math.round((colour & 255) * f)
  return (r << 16) | (g << 8) | b || BODY
}

function hash(a: number, b: number, c: number): number {
  return (Math.imul(a + 1, 73856093) ^ Math.imul(b + 1, 19349663) ^ Math.imul(c + 1, 83492791)) >>> 0
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
          // A cell has one colour: the liveliest dot in it wins over the chip's greys.
          if (fg === PANEL || (dot !== BODY && dot !== EDGE && dot !== WIRE)) fg = dot
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
