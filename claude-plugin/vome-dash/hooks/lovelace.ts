// A Lovelace dashboard as the pane draws it: views of cards, each card a title
// and rows, each row an entity (with the control that suits it), a button with
// its action, or text. Pure: the config in, a model out, and the service call
// a press makes. Cards the pane cannot draw keep their entities, so a custom
// card still shows the things it is about.

export type ServiceCall = {
  domain: string
  service: string
  target?: { entity_id: string | string[] }
  data?: Record<string, unknown>
  /** Asked before it runs: "Wipe everything this fly has learned?" */
  confirm?: string
}

export type Row =
  | { kind: 'entity'; entity: string; name: string | null; icon?: string | null }
  | { kind: 'button'; name: string; icon: string | null; call: ServiceCall | null; entity: string | null }
  | { kind: 'text'; text: string }

export type Card = {
  /** Where it is, `v0/c3/c1`: stable across a save that changes other cards. */
  key: string
  type: string
  title: string | null
  rows: Row[]
  /** Markdown cards: their content, templates and all. */
  markdown: string | null
  /** History graphs: hours shown, and the entities graphed. */
  hours: number | null
  children: Card[]
  /** A card only Home Assistant can draw (custom:*, maps). */
  isForeign: boolean
  /** A picture card's camera, drawn from its frames. */
  camera: string | null
  /** Entities cards: whether the header has a switch for all of them (Home Assistant's default). */
  headerToggle: boolean
}

export type View = { title: string; path: string | null; cards: Card[] }

type Obj = Record<string, unknown>

const isObj = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)

/**
 * A title or name without the pictographs terminals disagree about the width of: those that
 * default to text presentation (🌡, 🎛, ☀, ❄…), which one terminal draws in one cell and another
 * in two, so everything after them on the row shifts and leaves stray borders. Emoji that are
 * always emoji (💡, 🔥) are kept.
 */
export function steady(text: string): string {
  return text.replace(/(?![\p{Emoji_Presentation}])\p{Extended_Pictographic}\uFE0F?\s*/gu, '').replace(/\uFE0F/g, '').trim() || text
}
const label = (value: unknown): string | null => {
  const s = str(value)
  return s ? steady(s) : null
}

export function viewsOf(config: unknown): View[] {
  if (!isObj(config) || !Array.isArray(config.views)) return []
  return config.views.filter(isObj).map((view, v) => {
    const sections = Array.isArray(view.sections) ? view.sections.filter(isObj).flatMap(section => (Array.isArray(section.cards) ? section.cards : [])) : []
    const cards = [...(Array.isArray(view.cards) ? view.cards : []), ...sections]
    return {
      title: label(view.title) ?? str(view.path) ?? `View ${v + 1}`,
      path: str(view.path),
      cards: cards.filter(isObj).map((card, c) => cardOf(card, `v${v}/c${c}`)),
    }
  })
}

function cardOf(card: Obj, key: string): Card {
  const type = str(card.type) ?? 'unknown'
  const base: Card = {
    key,
    type,
    title: label(card.title) ?? label(card.name),
    rows: [],
    markdown: null,
    hours: null,
    children: [],
    isForeign: false,
    camera: null,
    headerToggle: card.show_header_toggle !== false,
  }
  switch (type) {
    case 'vertical-stack':
    case 'horizontal-stack':
    case 'grid':
      return { ...base, children: (Array.isArray(card.cards) ? card.cards : []).filter(isObj).map((child, i) => cardOf(child, `${key}/c${i}`)) }
    case 'markdown':
      return { ...base, markdown: str(card.content) ?? '' }
    case 'entities':
    case 'glance':
      return { ...base, rows: (Array.isArray(card.entities) ? card.entities : []).map(rowOf).filter((row): row is Row => row !== null) }
    case 'history-graph':
    case 'statistics-graph':
      return {
        ...base,
        hours: typeof card.hours_to_show === 'number' ? card.hours_to_show : 24,
        rows: (Array.isArray(card.entities) ? card.entities : []).map(rowOf).filter((row): row is Row => row !== null),
      }
    case 'picture-entity':
    case 'picture-glance':
    case 'picture-elements': {
      const camera = [str(card.camera_image), str(card.entity)].find(e => e?.startsWith('camera.')) ?? null
      const named = (Array.isArray(card.entities) ? card.entities : []).map(e => (isObj(e) ? str(e.entity) : str(e))).filter((e): e is string => !!e)
      return { ...base, camera, title: base.title ?? (camera ? null : base.title), rows: named.map(entity => ({ kind: 'entity' as const, entity, name: null })), isForeign: !camera }
    }
    case 'button': {
      const entity = str(card.entity)
      const call = actionOf(card.tap_action, entity)
      // Its name is the button's label: not a title over it as well.
      return { ...base, title: null, rows: [{ kind: 'button', name: label(card.name) ?? entity ?? 'Button', icon: str(card.icon), call, entity }] }
    }
    case 'tile':
    case 'light':
    case 'thermostat':
    case 'sensor':
    case 'gauge':
    case 'entity':
    case 'humidifier':
    case 'media-control':
    case 'alarm-panel':
    case 'weather-forecast': {
      const entity = str(card.entity)
      return { ...base, rows: entity ? [{ kind: 'entity', entity, name: str(card.name), icon: str(card.icon) }] : [] }
    }
    default: {
      // A card the pane cannot draw: keep whatever entities it names.
      const named = [str(card.entity), ...(Array.isArray(card.entities) ? card.entities.map(e => (isObj(e) ? str(e.entity) : str(e))) : [])].filter((e): e is string => !!e)
      return { ...base, isForeign: true, rows: named.map(entity => ({ kind: 'entity' as const, entity, name: null })) }
    }
  }
}

function rowOf(row: unknown): Row | null {
  if (typeof row === 'string') return { kind: 'entity', entity: row, name: null }
  if (!isObj(row)) return null
  const entity = str(row.entity)
  if (row.type === 'button' || (!entity && row.tap_action)) {
    return { kind: 'button', name: str(row.name) ?? str(row.action_name) ?? 'Run', icon: str(row.icon), call: actionOf(row.tap_action, entity), entity }
  }
  if (row.type === 'section' || row.type === 'divider') return str(row.label) ? { kind: 'text', text: str(row.label)! } : null
  if (row.type === 'text' || row.type === 'attribute') return str(row.name) ? { kind: 'text', text: str(row.name)! } : null
  return entity ? { kind: 'entity', entity, name: str(row.name), icon: str(row.icon) } : null
}

/** A tap_action as the service call it makes; navigation, more-info and URLs are Home Assistant's own. */
export function actionOf(action: unknown, entity: string | null): ServiceCall | null {
  if (!isObj(action)) return entity ? toggleFor(entity) : null
  const kind = str(action.action)
  const confirm = isObj(action.confirmation) ? (str(action.confirmation.text) ?? 'Are you sure?') : action.confirmation === true ? 'Are you sure?' : undefined
  if (kind === 'toggle' && entity) {
    const call = toggleFor(entity)
    return call ? { ...call, ...(confirm ? { confirm } : {}) } : null
  }
  if (kind === 'perform-action' || kind === 'call-service') {
    const name = str(action.perform_action) ?? str(action.service)
    const [domain, service] = (name ?? '').split('.')
    if (!domain || !service) return null
    const target = isObj(action.target) && (typeof action.target.entity_id === 'string' || Array.isArray(action.target.entity_id))
      ? { entity_id: action.target.entity_id as string | string[] }
      : undefined
    const data = isObj(action.data) ? action.data : isObj(action.service_data) ? action.service_data : undefined
    return { domain, service, ...(target ? { target } : {}), ...(data ? { data } : {}), ...(confirm ? { confirm } : {}) }
  }
  return null
}

const TOGGLE_DOMAINS = new Set(['light', 'switch', 'fan', 'input_boolean', 'automation', 'siren', 'humidifier'])
const RUN_DOMAINS: Record<string, string> = { scene: 'turn_on', script: 'turn_on', button: 'press', input_button: 'press' }

/** What pressing an entity does: toggle the toggleable, run scenes and scripts, press buttons. */
export function toggleFor(entity: string): ServiceCall | null {
  const domain = entity.split('.')[0] ?? ''
  if (TOGGLE_DOMAINS.has(domain)) return { domain, service: 'toggle', target: { entity_id: entity } }
  if (RUN_DOMAINS[domain]) return { domain, service: RUN_DOMAINS[domain]!, target: { entity_id: entity } }
  return null
}

/** A step up or down for things with a value: input_number and number, a light's brightness, a thermostat's target. */
export function stepFor(entity: string, attributes: Obj, state: string, direction: 1 | -1): ServiceCall | null {
  const domain = entity.split('.')[0] ?? ''
  if (domain === 'input_number' || domain === 'number') {
    const step = typeof attributes.step === 'number' ? attributes.step : 1
    const min = typeof attributes.min === 'number' ? attributes.min : -Infinity
    const max = typeof attributes.max === 'number' ? attributes.max : Infinity
    const value = Math.min(max, Math.max(min, Number(state) + direction * step * stepScale(attributes)))
    return Number.isFinite(value) ? { domain, service: 'set_value', target: { entity_id: entity }, data: { value: round(value, step) } } : null
  }
  if (domain === 'light' && state === 'on') return { domain, service: 'turn_on', target: { entity_id: entity }, data: { brightness_step_pct: direction * 20 } }
  if (domain === 'climate') {
    const target = typeof attributes.temperature === 'number' ? attributes.temperature : null
    const step = typeof attributes.target_temp_step === 'number' ? attributes.target_temp_step : 0.5
    return target === null ? null : { domain, service: 'set_temperature', target: { entity_id: entity }, data: { temperature: round(target + direction * step, step) } }
  }
  if (domain === 'cover') return { domain, service: direction > 0 ? 'open_cover' : 'close_cover', target: { entity_id: entity } }
  return null
}

/** A slider with a hundred steps moves a tenth of its range a press: nobody presses + fifty times. */
function stepScale(attributes: Obj): number {
  const step = typeof attributes.step === 'number' ? attributes.step : 1
  const span = typeof attributes.max === 'number' && typeof attributes.min === 'number' ? attributes.max - attributes.min : 0
  return span > 0 && span / step > 20 ? Math.round(span / step / 10) : 1
}

function round(value: number, step: number): number {
  const places = Math.max(0, (String(step).split('.')[1] ?? '').length)
  return Number(value.toFixed(places))
}

/** Every entity a view shows, for the state reads. */
export function entitiesOf(cards: Card[]): string[] {
  const out = new Set<string>()
  const walk = (card: Card) => {
    for (const row of card.rows) if (row.kind !== 'text' && row.entity) out.add(row.entity)
    card.children.forEach(walk)
  }
  cards.forEach(walk)
  return [...out]
}

/** Cards a save added or changed, by key and content. */
export function changedCards(before: unknown, after: unknown): Set<string> {
  const flat = (config: unknown) => {
    const out = new Map<string, string>()
    if (!isObj(config) || !Array.isArray(config.views)) return out
    config.views.forEach((view, v) => {
      const cards = isObj(view) && Array.isArray(view.cards) ? view.cards : []
      cards.forEach((card, c) => out.set(`v${v}/c${c}`, JSON.stringify(card)))
    })
    return out
  }
  const old = flat(before)
  const now = flat(after)
  return new Set([...now].filter(([key, json]) => old.get(key) !== json).map(([key]) => key))
}

/** "▁▂▄▇" from a series of numbers, `width` characters wide. */
export function sparkline(values: number[], width: number): string {
  if (values.length === 0) return ''
  const blocks = '▁▂▃▄▅▆▇█'
  const step = values.length / width
  const picked = Array.from({ length: Math.min(width, values.length) }, (_, i) => values[Math.floor(i * Math.max(1, step))] ?? 0)
  const min = Math.min(...picked)
  const max = Math.max(...picked)
  return picked.map(v => blocks[max === min ? 3 : Math.round(((v - min) / (max - min)) * 7)]).join('')
}

/** A domain's glyph, single-width. */
export function iconFor(entity: string, state: string): string {
  const domain = entity.split('.')[0] ?? ''
  const on = state === 'on' || state === 'open' || state === 'home' || state === 'playing'
  switch (domain) {
    case 'light':
      return on ? '●' : '○'
    case 'switch':
    case 'input_boolean':
    case 'fan':
    case 'automation':
      return on ? '■' : '□'
    case 'binary_sensor':
      return on ? '◉' : '◌'
    case 'sensor':
    case 'input_number':
    case 'number':
      return '≈'
    case 'climate':
      return '❄'
    case 'cover':
      return '▤'
    case 'scene':
    case 'script':
      return '▶'
    case 'person':
    case 'device_tracker':
      return '☺'
    default:
      return '·'
  }
}

const DOT = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

/**
 * A line chart in braille, `width` characters by `rows` lines (2 x 4 dots a character): each
 * value a dot, joined to the next by a vertical run so a jump reads as a line, not a gap.
 */
export function brailleChart(values: number[], width: number, rows: number): string[] {
  const w = Math.max(2, width * 2)
  const h = Math.max(4, rows * 4)
  if (values.length === 0) return Array.from({ length: rows }, () => ' '.repeat(width))
  // One point per dot column: the average of the values that fall in it.
  const points = Array.from({ length: w }, (_, x) => {
    const from = Math.floor((x / w) * values.length)
    const to = Math.max(from + 1, Math.floor(((x + 1) / w) * values.length))
    const slice = values.slice(from, to)
    return slice.reduce((a, b) => a + b, 0) / slice.length
  })
  const min = Math.min(...points)
  const max = Math.max(...points)
  const yOf = (v: number) => (max === min ? Math.floor(h / 2) : Math.round((1 - (v - min) / (max - min)) * (h - 1)))
  const cells = Array.from({ length: rows }, () => new Array<number>(width).fill(0))
  const dot = (x: number, y: number) => {
    const row = Math.floor(y / 4)
    const col = Math.floor(x / 2)
    if (row >= 0 && row < rows && col >= 0 && col < width) cells[row]![col]! |= DOT[x % 2]![y % 4]!
  }
  let last: number | null = null
  points.forEach((v, x) => {
    const y = yOf(v)
    if (last !== null) for (let k = Math.min(last, y); k <= Math.max(last, y); k++) dot(x, k)
    dot(x, y)
    last = y
  })
  return cells.map(row => row.map(bits => String.fromCharCode(0x2800 + bits)).join(''))
}

/** Home Assistant's mdi icons as emoji that draw two cells wide everywhere (no variation selectors). */
const MDI: Array<[RegExp, string]> = [
  [/lightbulb|lamp|ceiling-light|light-recessed|led/, '💡'],
  [/power-socket|power-plug|outlet/, '🔌'],
  [/water|humidity|drop/, '💧'],
  [/motion|walk|run|human-male|account-arrow/, '🚶'],
  [/door/, '🚪'],
  [/window|blinds|curtain|shutter/, '🪟'],
  [/fan/, '🌀'],
  [/lock-open/, '🔓'],
  [/lock/, '🔒'],
  [/garage|car/, '🚗'],
  [/home|house/, '🏠'],
  [/account|person|human|face/, '👤'],
  [/battery/, '🔋'],
  [/fire|radiator|heat|flame/, '🔥'],
  [/snowflake|ice|freezer/, '🧊'],
  [/television|tv/, '📺'],
  [/speaker|music|play/, '🎵'],
  [/bell|alarm/, '🔔'],
  [/camera|cctv|cam/, '📷'],
  [/candy|food/, '🍬'],
  [/hand/, '✋'],
  [/delete|broom|sweep|trash/, '🧹'],
  [/butterfly|bug|fly/, '🪰'],
  [/brain/, '🧠'],
  [/radar|wifi|antenna|signal/, '📡'],
  [/chart|graph|trending/, '📈'],
  [/flash|lightning|power|energy|meter-electric/, '⚡'],
  [/weather-sunny|sun/, '🌞'],
  [/moon|night|sleep/, '🌙'],
  [/robot|auto/, '🤖'],
  // A thermometer emoji is text-presentation: terminals draw it one cell or two, and the row shifts.
  [/thermometer|temperature/, '🔥'],
]

/** The picture an entity is drawn with: its own mdi icon, else what kind of thing it is. */
export function glyphFor(entity: string, attributes: Record<string, unknown>, icon?: string | null): string {
  const mdi = (icon ?? (typeof attributes.icon === 'string' ? attributes.icon : '')).replace(/^mdi:/, '')
  if (mdi) for (const [pattern, glyph] of MDI) if (pattern.test(mdi)) return glyph
  const domain = entity.split('.')[0] ?? ''
  const kind = typeof attributes.device_class === 'string' ? attributes.device_class : ''
  switch (domain) {
    case 'light':
      return '💡'
    case 'switch':
      return '🔌'
    case 'fan':
      return '🌀'
    case 'lock':
      return '🔒'
    case 'cover':
      return '🪟'
    case 'climate':
    case 'water_heater':
      return '🔥'
    case 'person':
    case 'device_tracker':
      return '👤'
    case 'media_player':
      return '🎵'
    case 'camera':
      return '📷'
    case 'automation':
      return '🤖'
    case 'scene':
      return '🎬'
    case 'script':
      return '📜'
    case 'input_boolean':
    case 'button':
    case 'input_button':
      return '🔘'
    case 'input_number':
    case 'number':
      return '🔢'
    case 'binary_sensor':
      return /occupancy|motion|presence/.test(kind) ? '🚶' : /door|garage/.test(kind) ? '🚪' : /window/.test(kind) ? '🪟' : /smoke|heat/.test(kind) ? '🔥' : /moisture/.test(kind) ? '💧' : '🔵'
    case 'sensor':
      return /temperature/.test(kind) ? '🔥' : /humidity|moisture/.test(kind) ? '💧' : /battery/.test(kind) ? '🔋' : /power|energy|current|voltage/.test(kind) ? '⚡' : /illuminance/.test(kind) ? '🌞' : /distance/.test(kind) ? '📏' : '📊'
    default:
      return '🔵'
  }
}

/**
 * A lit light's glow, as a background for its row: the light's own colour (or warm white), mixed
 * into the dark panel by how bright it is. Null for anything that is not a light that is on.
 */
export function glowFor(entity: string, state: string, attributes: Record<string, unknown>): string | null {
  if (!entity.startsWith('light.') || state !== 'on') return null
  const rgb = Array.isArray(attributes.rgb_color) && attributes.rgb_color.length === 3 ? (attributes.rgb_color as number[]) : [255, 196, 96]
  const level = typeof attributes.brightness === 'number' ? attributes.brightness / 255 : 1
  const mix = 0.18 + 0.4 * level
  const base = [24, 26, 32]
  const hex = rgb.map((c, i) => Math.round(base[i]! + (c - base[i]!) * mix).toString(16).padStart(2, '0')).join('')
  return `#${hex}`
}

/** A lit light's colour for its state text: its own, or warm white. */
export function lightColour(attributes: Record<string, unknown>): string {
  const rgb = Array.isArray(attributes.rgb_color) && attributes.rgb_color.length === 3 ? (attributes.rgb_color as number[]) : [255, 204, 102]
  return `#${rgb.map(c => Math.round(c).toString(16).padStart(2, '0')).join('')}`
}


/**
 * A picture in half blocks for a Raster: two pixels a cell, the upper one the
 * foreground of an upper half block and the lower one its background. `rgb` is
 * 3 bytes a pixel, `width` x `height`; the cells are 12 bytes each (code point,
 * foreground, background), base64, as a Raster takes them.
 */
export function halfBlocks(rgb: Uint8Array, width: number, height: number): { cells: string; columns: number; rows: number } {
  const rows = Math.ceil(height / 2)
  const bytes = new Uint8Array(width * rows * 12)
  const view = new DataView(bytes.buffer)
  const at = (x: number, y: number) => {
    if (y >= height) return 0x000000
    const i = (y * width + x) * 3
    return ((rgb[i] ?? 0) << 16) | ((rgb[i + 1] ?? 0) << 8) | (rgb[i + 2] ?? 0)
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < width; c++) {
      const cell = (r * width + c) * 12
      view.setUint32(cell, 0x2580, true)
      view.setUint32(cell + 4, at(c, r * 2), true)
      view.setUint32(cell + 8, at(c, r * 2 + 1), true)
    }
  }
  let out = ''
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += A[(n >> 18) & 63]! + A[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? A[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? A[n & 63]! : '='
  }
  return { cells: out, columns: width, rows }
}

/** base64 to bytes, without a Buffer. */
export function fromBase64(text: string): Uint8Array {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n = (A.indexOf(clean[i]!) << 18) | (A.indexOf(clean[i + 1] ?? 'A') << 12) | (A.indexOf(clean[i + 2] ?? 'A') << 6) | A.indexOf(clean[i + 3] ?? 'A')
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}

/**
 * Every read the pane makes in the background, all of them read-only: what auto mode needs
 * allowed by name. Kept beside the calls; a tool the pane starts using must be added here, or the
 * box asking for permission names the wrong lines (it missed the snapshot, watch and camera reads).
 */
export const READS = [
  'ha_view_snapshot',
  'ha_watch_states',
  'ha_camera_frame',
  'ha_get_state',
  'ha_render_template',
  'ha_get_history',
  'ha_get_dashboard',
  'ha_list_dashboards',
]
