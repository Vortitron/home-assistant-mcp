// A map of an ESPHome device, read from its YAML: the board, how it connects,
// its buses, every entity with its pins, and what reacts to what. The pane
// shows it whenever Claude reads or writes a config, and marks what a save
// changed, as the automation pane does for automations.
//
// ESPHome YAML is a small, regular subset (keys, lists of maps, block scalars
// for lambdas, a few tags), so a forgiving indentation parser reads it; it
// never needs to be right about anything the map does not show. Passwords and
// keys written into the YAML are never shown.

export type YNode = {
  key: string | null
  value: string | null
  /** A `!secret`, `!lambda`, `!include`... tag on the value. */
  tag: string | null
  isItem: boolean
  children: YNode[]
}

import type { MapRow, RowChange } from '../types'

export type { MapRow, RowChange }

export type DeviceMap = {
  name: string
  chip: string
  rows: MapRow[]
}


// ---------------------------------------------------------------- parsing

export function parseYaml(text: string): YNode {
  const root: YNode = { key: null, value: null, tag: null, isItem: false, children: [] }
  const stack: { indent: number; node: YNode }[] = [{ indent: -1, node: root }]
  const lines = text.replace(/\t/g, '  ').split('\n')

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    const body = stripComment(raw).trimEnd()
    if (!body.trim() || body.trim() === '---') continue
    const indent = body.length - body.trimStart().length
    let rest = body.trimStart()
    let at = indent

    if (rest.startsWith('- ') || rest === '-') {
      while (stack.length > 1 && (stack.at(-1)!.indent > indent || (stack.at(-1)!.indent === indent && stack.at(-1)!.node.isItem))) stack.pop()
      const item: YNode = { key: null, value: null, tag: null, isItem: true, children: [] }
      stack.at(-1)!.node.children.push(item)
      stack.push({ indent, node: item })
      const after = rest.slice(1)
      at = indent + 1 + (after.length - after.trimStart().length)
      rest = after.trim()
      if (!rest) continue
      if (!keyOf(rest)) {
        const { value, tag } = scalar(rest)
        item.value = value
        item.tag = tag
        continue
      }
    } else {
      while (stack.length > 1 && stack.at(-1)!.indent >= indent) stack.pop()
    }

    const pair = keyOf(rest)
    if (!pair) continue
    const node: YNode = { key: pair.key, value: null, tag: null, isItem: false, children: [] }
    stack.at(-1)!.node.children.push(node)
    const { value, tag } = scalar(pair.value)
    node.tag = tag
    if (value !== null && /^[|>][-+]?\d*$/.test(value)) {
      // A block scalar (a lambda, usually): the more-indented lines after it.
      const block: string[] = []
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? ''
        if (next.trim() && next.length - next.trimStart().length <= at) break
        block.push(next.trim())
        i++
      }
      node.value = block.filter(Boolean).join('\n')
      continue
    }
    node.value = value
    if (value === null) stack.push({ indent: at, node })
  }
  return root
}

function stripComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) {
      return line.slice(0, i)
    }
  }
  return line
}

function keyOf(text: string): { key: string; value: string } | null {
  const match = /^("[^"]*"|'[^']*'|[^\s"'{[!][^:]*?):(?:\s+(.*)|$)/.exec(text)
  if (!match?.[1]) return null
  return { key: match[1].replace(/^["']|["']$/g, ''), value: (match[2] ?? '').trim() }
}

function scalar(text: string): { value: string | null; tag: string | null } {
  let value = text.trim()
  let tag: string | null = null
  const tagged = /^(![a-z_]+)(?:\s+(.*))?$/i.exec(value)
  if (tagged?.[1]) {
    tag = tagged[1]
    value = (tagged[2] ?? '').trim()
  }
  if (!value) return { value: tag ? '' : null, tag }
  return { value: value.replace(/^"(.*)"$|^'(.*)'$/, '$1$2'), tag }
}

// ---------------------------------------------------------------- the map

const PLATFORMS = ['esp32', 'esp8266', 'rp2040', 'bk72xx', 'rtl87xx', 'ln882x', 'libretiny', 'nrf52', 'host']
const NETWORK = ['wifi', 'ethernet', 'api', 'ota', 'mqtt', 'web_server', 'captive_portal', 'improv_serial', 'esp32_improv', 'bluetooth_proxy', 'esp32_ble_tracker', 'time', 'logger', 'safe_mode']
const BUSES = ['i2c', 'spi', 'uart', 'one_wire', 'i2s_audio', 'canbus', 'modbus']
const DOMAINS: [string, string, string][] = [
  ['binary_sensor', 'Binary sensors', '◐'],
  ['sensor', 'Sensors', '≈'],
  ['text_sensor', 'Text sensors', '¶'],
  ['switch', 'Switches', '⏻'],
  ['light', 'Lights', '✺'],
  ['fan', 'Fans', '✣'],
  ['cover', 'Covers', '▤'],
  ['climate', 'Climate', '❄'],
  ['button', 'Buttons', '▣'],
  ['number', 'Numbers', '#'],
  ['select', 'Selects', '☰'],
  ['text', 'Text', '¶'],
  ['lock', 'Locks', '⊡'],
  ['valve', 'Valves', '⊗'],
  ['event', 'Events', '⚑'],
  ['output', 'Outputs', '⇥'],
  ['status_led', 'Outputs', '•'],
  ['display', 'Displays', '▭'],
  ['media_player', 'Media', '♫'],
  ['speaker', 'Media', '♫'],
  ['microphone', 'Media', '♪'],
  ['voice_assistant', 'Media', '◎'],
  ['remote_transmitter', 'Infrared and RF', '⇢'],
  ['remote_receiver', 'Infrared and RF', '⇠'],
  ['deep_sleep', 'Power', '☾'],
  ['globals', 'Logic', '='],
  ['script', 'Logic', '▶'],
  ['interval', 'Logic', '↻'],
]
/** A section lists this many, then says how many more. */
const MAX_PER_DOMAIN = 8
const QUIET_KEYS = new Set(['esphome', 'substitutions', 'packages', 'dashboard_import', 'preferences', 'external_components', 'font', 'image', 'color', 'animation', 'psram', 'debug'])
const HIDDEN = /password|(^|_)key$|^key$|psk|token|secret/i
const PIN_KEY = /^(pin|.*_pin|sda|scl|tx|rx|clk|mosi|miso|cs|dc|reset|data)$/

export function mapDevice(yaml: string): DeviceMap {
  const root = parseYaml(yaml)
  const subs = new Map<string, string>()
  for (const s of child(root, 'substitutions')?.children ?? []) if (s.key && s.value) subs.set(s.key, s.value)
  const sub = (text: string) => text.replace(/\$\{?([a-z_][a-z0-9_]*)\}?/gi, (all, name: string) => subs.get(name) ?? all)
  const val = (node: YNode | undefined, key: string) => {
    const found = node ? child(node, key) : undefined
    return found?.value ? sub(found.value) : null
  }

  const core = child(root, 'esphome')
  const name = val(core, 'friendly_name') ?? val(core, 'name') ?? 'device'
  const platformNode = PLATFORMS.map(p => child(root, p)).find(Boolean)
  const variant = val(platformNode, 'variant') ?? val(platformNode, 'board') ?? ''
  const framework = val(child(platformNode ?? root, 'framework'), 'type')
  const chip = [platformNode?.key?.toUpperCase().replace('ESP32', 'ESP32'), variant && variant !== platformNode?.key ? variant : null, framework]
    .filter(Boolean)
    .join(' · ')

  const rows: MapRow[] = []
  const add = (section: string, depth: number, icon: string, label: string, detail: string) => rows.push({ section, depth, icon, label: sub(label), detail: sub(detail) })
  const pins: { pin: string; owner: string }[] = []

  // How it connects.
  for (const key of NETWORK) {
    const node = child(root, key)
    if (!node) continue
    add('Network', 0, networkIcon(key), key.replace(/_/g, ' '), networkDetail(key, node, sub))
  }
  for (const key of BUSES) {
    for (const item of itemsOf(child(root, key))) {
      const label = val(item, 'id') ?? key
      const wires = item.children.filter(c => c.key && PIN_KEY.test(c.key)).map(c => `${c.key} ${pinOf(c, sub) ?? '?'}`)
      for (const c of item.children) if (c.key && PIN_KEY.test(c.key) && pinOf(c, sub)) pins.push({ pin: pinOf(c, sub)!, owner: `${key} ${c.key}` })
      add('Buses', 0, '═', `${key}${label !== key ? ` ${label}` : ''}`, [...wires, val(item, 'baud_rate') ? `${val(item, 'baud_rate')} baud` : null, val(item, 'frequency')].filter(Boolean).join(' · '))
    }
  }

  // Everything it does.
  const seen = new Set<string>()
  const labels = new Map<string, number>()
  for (const [domain, section, icon] of DOMAINS) {
    const node = child(root, domain)
    if (!node) continue
    seen.add(domain)
    const items = itemsOf(node)
    // Values the device only reads from Home Assistant, and its own variables, are one row each:
    // a real device has dozens of them, and they are not what the map is for.
    const imported = items.filter(item => val(item, 'platform') === 'homeassistant')
    if (imported.length > 0) add(section, 0, '⌂', `${imported.length} from Home Assistant`, imported.slice(0, 4).map(item => val(item, 'name') ?? val(item, 'id') ?? '').filter(Boolean).join(', ') + (imported.length > 4 ? ', …' : ''))
    if (domain === 'globals') {
      add(section, 0, icon, `${items.length} variable${items.length === 1 ? '' : 's'}`, items.slice(0, 5).map(item => val(item, 'id') ?? '').filter(Boolean).join(', ') + (items.length > 5 ? ', …' : ''))
      continue
    }
    const shown = items.filter(item => !imported.includes(item))
    for (const item of shown.slice(0, MAX_PER_DOMAIN)) {
      const named = val(item, 'name') ?? val(item, 'id') ?? (domain === 'interval' && val(item, 'interval') ? `every ${val(item, 'interval')}` : null)
      const base = named ?? val(item, 'platform') ?? (item.value ? sub(item.value) : domain)
      // Two rows with one label (two `every 1s` intervals) would share a key in the diff.
      const repeats = labels.get(`${section}|${base}`) ?? 0
      labels.set(`${section}|${base}`, repeats + 1)
      const label = repeats > 0 ? `${base} (${repeats + 1})` : base
      const detail = [
        named ? val(item, 'platform') : null,
        val(item, 'address'),
        ...pinsIn(item, sub).map(p => p.pin),

        val(item, 'update_interval') ? `every ${val(item, 'update_interval')}` : null,
        item.children.some(c => c.tag === '!lambda') ? 'λ' : null,
      ]
        .filter(Boolean)
        .join(' · ')
      add(section, 0, icon, label, detail)
      for (const p of pinsIn(item, sub)) pins.push({ pin: p.pin, owner: label })
      // A platform that makes several entities (a BME280's temperature, humidity...).
      for (const sub of item.children) {
        if (sub.key && !sub.isItem && val(sub, 'name') && sub.key !== 'then') add(section, 1, '↳', val(sub, 'name')!, sub.key.replace(/_/g, ' '))
      }
      for (const trigger of item.children.filter(c => c.key?.startsWith('on_') || (domain === 'interval' && c.key === 'then') || (domain === 'script' && c.key === 'then'))) {
        add(section, 1, '⚡', trigger.key === 'then' ? 'runs' : trigger.key!.replace(/^on_/, 'on ').replace(/_/g, ' '), actionsOf(trigger).join(', ') || '…')
      }
    }
    if (shown.length > MAX_PER_DOMAIN) {
      const rest = shown.slice(MAX_PER_DOMAIN)
      add(section, 0, '…', `${rest.length} more`, rest.slice(0, 4).map(item => val(item, 'name') ?? val(item, 'id') ?? '').filter(Boolean).join(', ') + (rest.length > 4 ? ', …' : ''))
    }
  }
  for (const trigger of (core?.children ?? []).filter(c => c.key?.startsWith('on_'))) {
    add('Logic', 0, '⚡', trigger.key!.replace(/^on_/, 'on ').replace(/_/g, ' '), actionsOf(trigger).join(', ') || '…')
  }

  const other = root.children
    .map(c => c.key)
    .filter((k): k is string => !!k && !seen.has(k) && !QUIET_KEYS.has(k) && !PLATFORMS.includes(k) && !NETWORK.includes(k) && !BUSES.includes(k))
  if (other.length > 0) add('Other', 0, '·', other.join(', '), '')
  const packages = child(root, 'packages')
  if (packages) add('Other', 0, '⧉', 'packages', packages.children.map(p => p.key ?? p.value).filter(Boolean).join(', ') || (packages.value ?? ''))

  // Which pin does what: the wiring at a glance, with the pins the chip boots from called out.
  const strapping = strappingPins(platformNode?.key ?? '', `${variant} ${val(platformNode, 'board') ?? ''}`)
  const byPin = new Map<string, string[]>()
  for (const p of pins) byPin.set(p.pin, [...(byPin.get(p.pin) ?? []), p.owner])
  for (const [pin, owners] of [...byPin].sort((a, b) => pinNumber(a[0]) - pinNumber(b[0]))) {
    const isStrapping = /^GPIO\d+$/.test(pin) && strapping.includes(pinNumber(pin))
    const notes = [owners.length > 1 ? 'shared' : null, isStrapping ? 'strapping pin' : null].filter(Boolean)
    add('Pins', 0, owners.length > 1 ? '!' : isStrapping ? '◇' : '○', pin, owners.join(', ') + (notes.length ? `  (${notes.join(', ')})` : ''))
  }

  return { name: sub(name), chip, rows }
}

function child(node: YNode, key: string): YNode | undefined {
  return node.children.find(c => c.key === key)
}

/** A domain's entries: a list of maps, or a single map (`status_led:` with a pin). */
function itemsOf(node: YNode | undefined): YNode[] {
  if (!node) return []
  const items = node.children.filter(c => c.isItem)
  return items.length > 0 ? items : node.children.length > 0 ? [node] : []
}

function pinOf(node: YNode, sub: (text: string) => string = text => text): string | null {
  const found = node.value ?? child(node, 'number')?.value ?? null
  const raw = found === null ? null : sub(found)
  if (!raw) return null
  const flow = /number:\s*([A-Za-z0-9_]+)/.exec(raw)
  const pin = (flow?.[1] ?? raw).trim()
  if (/^\d+$/.test(pin)) return `GPIO${pin}`
  return /^(GPIO|D|A|P|PA|PB)\d+|^GPIO/i.test(pin) ? pin.toUpperCase() : null
}

function pinsIn(item: YNode, sub: (text: string) => string): { pin: string }[] {
  return item.children.filter(c => c.key && PIN_KEY.test(c.key)).map(c => pinOf(c, sub)).filter((p): p is string => !!p).map(pin => ({ pin }))
}

/** Pins the chip reads at boot, which ESPHome warns about: fine with care, a trap with a pull resistor. */
function strappingPins(platform: string, variant: string): number[] {
  const v = variant.toLowerCase().replace(/[-_]/g, '')
  if (platform === 'esp8266') return [0, 2, 15]
  if (platform !== 'esp32') return []
  if (/c3/.test(v)) return [2, 8, 9]
  if (/c6|h2/.test(v)) return [8, 9, 15]
  if (/s3/.test(v)) return [0, 3, 45, 46]
  if (/s2/.test(v)) return [0, 45, 46]
  return [0, 2, 5, 12, 15]
}

function pinNumber(pin: string): number {
  return Number(/\d+/.exec(pin)?.[0] ?? 999)
}

/** What a trigger does, as its action names: `light.toggle, delay`. */
function actionsOf(trigger: YNode): string[] {
  const steps = trigger.children.find(c => c.key === 'then') ?? trigger
  // A trigger written as a list of `- priority: ... then: ...` entries: their actions, not their settings.
  if (steps === trigger && trigger.children.some(c => c.isItem && c.children.some(k => k.key === 'then'))) {
    return [...new Set(trigger.children.filter(c => c.isItem).flatMap(actionsOf))].slice(0, 4)
  }
  const names = steps.children.flatMap(c => (c.isItem ? c.children.slice(0, 1).map(a => a.key ?? '') : c.key && !['then', 'priority', 'mode'].includes(c.key) ? [c.key] : []))
  if (trigger.tag === '!lambda' || steps.children.some(c => c.key === 'lambda')) names.push('λ')
  return [...new Set(names.filter(Boolean).map(n => (n === 'lambda' ? 'λ' : n)))].slice(0, 4)
}

function networkIcon(key: string): string {
  return ({ wifi: '◠', ethernet: '⇄', api: '⌂', ota: '⇪', mqtt: '⇋', web_server: '◫', bluetooth_proxy: 'ᛒ', esp32_ble_tracker: 'ᛒ', time: '◷', logger: '≡' } as Record<string, string>)[key] ?? '·'
}

function networkDetail(key: string, node: YNode, sub: (text: string) => string): string {
  const v = (k: string, from: YNode = node) => {
    const found = child(from, k)
    if (!found) return null
    if (found.tag === '!secret') return 'from secrets'
    if (HIDDEN.test(k)) return '•••'
    return found.value ? sub(found.value) : null
  }
  switch (key) {
    case 'wifi': {
      const networks = itemsOf(child(node, 'networks')).length
      return [
        v('ssid') ? `ssid ${v('ssid')}` : networks ? `${networks} networks` : null,
        child(node, 'ap') ? 'fallback hotspot' : null,
        child(node, 'manual_ip') ? `static ${v('static_ip', child(node, 'manual_ip')) ?? ''}`.trim() : null,
      ].filter(Boolean).join(' · ')
    }
    case 'api':
      return [child(node, 'encryption') ? 'encrypted' : 'not encrypted', child(node, 'actions') || child(node, 'services') ? 'with actions' : null].filter(Boolean).join(' · ')
    case 'ota':
      return itemsOf(node).map(item => v('platform', item) ?? 'esphome').join(', ')
    case 'mqtt':
      return v('broker') ? `broker ${v('broker')}` : ''
    case 'web_server':
      return v('port') ? `port ${v('port')}` : ''
    case 'time':
      return itemsOf(node).map(item => v('platform', item)).filter(Boolean).join(', ')
    case 'logger':
      return v('level') ? `level ${v('level')}` : ''
    case 'ethernet':
      return v('type') ?? ''
    default:
      return ''
  }
}

// ---------------------------------------------------------------- what a save changed

export function rowKey(row: MapRow): string {
  return `${row.section}|${row.depth}|${row.label}`
}

/** Rows a new map adds or changes against the old one, and the old rows it drops. */
export function diffMaps(before: MapRow[], after: MapRow[]): { changes: Record<string, RowChange>; removed: MapRow[] } {
  const old = new Map(before.map(row => [rowKey(row), row]))
  const fresh = new Set(after.map(rowKey))
  const changes: Record<string, RowChange> = {}
  for (const row of after) {
    const was = old.get(rowKey(row))
    if (!was) changes[rowKey(row)] = 'added'
    else if (was.detail !== row.detail || was.icon !== row.icon) changes[rowKey(row)] = 'changed'
  }
  const removed = before.filter(row => !fresh.has(rowKey(row)))
  for (const row of removed) changes[rowKey(row)] = 'removed'
  return { changes, removed }
}
