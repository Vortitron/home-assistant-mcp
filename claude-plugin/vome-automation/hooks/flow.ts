// The automation as rows the pane draws: one per trigger, condition and
// action, nested as Home Assistant nests them, each keyed by the path HA's
// traces use (trigger/0, action/1/choose/0/sequence/2), so a run's steps and
// a previous version line up with the same rows. Pure: no `$` here.

import type { AutomationConfig, Json, RunView } from '../types'

type Obj = { [key: string]: Json }

export type Tone = 'plain' | 'ran' | 'false' | 'error' | 'skipped' | 'disabled'
export type Change = '+' | '~' | '-' | null

export type Row = {
  path: string
  depth: number
  isSection: boolean
  text: string
  note: string
  tone: Tone
  change: Change
  /** What the diff compares: the node without its nested steps. */
  fingerprint: string
}

// ---------------------------------------------------------------- parsing

/** The JSON body of a vome MCP reply, which ends with a `[vome-instance]` line. */
export function parseReply(text: string): Obj | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as Json
    return isObj(value) ? value : null
  } catch {
    return null
  }
}

/** Which home answered: the vome MCP stamps every reply with it. */
export function parseStamp(text: string): { instance: string | null; home: string | null } {
  const match = /\[vome-instance\] target=(\S+)(?: home=("(?:[^"\\]|\\.)*"))?/.exec(text)
  if (!match) return { instance: null, home: null }
  let home: string | null = null
  try {
    home = match[2] ? (JSON.parse(match[2]) as string) : null
  } catch {
    home = null
  }
  return { instance: match[1] ?? null, home }
}

/** ha_get_trace's summary as the pane keeps it. */
export function parseRun(body: Obj): RunView | null {
  const runId = str(body.run_id)
  if (!runId) return null
  const trigger = isObj(body.trigger) ? str(body.trigger.description) : null
  const failed = isObj(body.failed_at) ? body.failed_at : null
  const steps = Array.isArray(body.steps) ? body.steps.filter(isObj) : []
  return {
    runId,
    started: str(body.started) ?? '',
    finished: str(body.finished),
    state: str(body.state),
    execution: str(body.script_execution),
    trigger,
    error: body.error == null ? null : compact(body.error, 160),
    failedAt: failed ? { path: str(failed.path) ?? '', reason: str(failed.reason) ?? '' } : null,
    steps: steps.map(step => ({
      path: str(step.path) ?? '',
      ...(step.result != null ? { result: typeof step.result === 'string' ? step.result : JSON.stringify(step.result) } : {}),
      ...(step.error != null ? { error: compact(step.error, 160) } : {}),
    })),
  }
}

// ---------------------------------------------------------------- rows

const CHILD_KEYS = new Set(['choose', 'default', 'sequence', 'then', 'else', 'if', 'conditions', 'parallel', 'and', 'or', 'not'])

/** Every row of `config`, with the run's tones and the changes since `prev`. */
export function buildRows(config: AutomationConfig, run: RunView | null, prev: AutomationConfig | null): Row[] {
  const rows = walk(config, run)
  if (!prev) return rows

  const before = new Map(walk(prev, null).map(row => [row.path, row]))
  const now = new Set(rows.map(row => row.path))
  const marked = rows.map(row => {
    if (row.isSection) return row
    const old = before.get(row.path)
    const change: Change = !old ? '+' : old.fingerprint !== row.fingerprint ? '~' : null
    return { ...row, change }
  })
  const removed = [...before.values()].filter(row => !row.isSection && !row.path.endsWith('/-') && !now.has(row.path))
  if (removed.length === 0) return marked
  return [
    ...marked,
    section('Removed', 'removed'),
    ...removed.map(row => ({ ...row, tone: 'plain' as Tone, change: '-' as Change })),
  ]
}

/** How many rows were added, changed and removed. */
export function countChanges(rows: Row[]): { added: number; changed: number; removed: number } {
  return {
    added: rows.filter(row => row.change === '+').length,
    changed: rows.filter(row => row.change === '~').length,
    removed: rows.filter(row => row.change === '-').length,
  }
}

/** A trace path as a reader would say it: "Then › step 1 › option 2 › step 1". */
export function describePath(path: string): string {
  const parts = path.split('/')
  const words: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? ''
    const next = parts[i + 1]
    const index = next !== undefined && /^\d+$/.test(next) ? Number(next) + 1 : null
    const name = PATH_WORDS[part] ?? part
    if (/^\d+$/.test(part)) continue
    words.push(index !== null ? `${name} ${index}` : name)
  }
  return words.join(' › ')
}

const PATH_WORDS: Record<string, string> = {
  trigger: 'trigger',
  condition: 'condition',
  action: 'step',
  choose: 'option',
  conditions: 'condition',
  sequence: 'step',
  default: 'otherwise',
  if: 'if',
  then: 'then',
  else: 'else',
  repeat: 'repeat',
  while: 'while',
  until: 'until',
  parallel: 'branch',
}

function walk(config: AutomationConfig, run: RunView | null): Row[] {
  const trace = traceIndex(run)
  const rows: Row[] = []
  const triggers = list(config.triggers ?? config.trigger)
  const conditions = list(config.conditions ?? config.condition)
  const actions = list(config.actions ?? config.action)

  rows.push(section('When', 'trigger'))
  triggers.forEach((trigger, i) => rows.push(leaf(`trigger/${i}`, 1, trigger, describeTrigger(trigger), trace)))
  if (triggers.length === 0) rows.push(empty('trigger/-', 'no triggers'))

  if (conditions.length > 0) {
    rows.push(section('And if', 'condition'))
    conditions.forEach((condition, i) => pushCondition(rows, condition, `condition/${i}`, 1, trace))
  }

  rows.push(section('Then', 'action'))
  actions.forEach((action, i) => pushAction(rows, action, `action/${i}`, 1, trace))
  if (actions.length === 0) rows.push(empty('action/-', 'no actions'))
  return rows
}

type Trace = { steps: Map<string, { result?: string; error?: string }>; failedAt: RunView['failedAt'] } | null

function traceIndex(run: RunView | null): Trace {
  if (!run) return null
  return { steps: new Map(run.steps.map(step => [step.path, step])), failedAt: run.failedAt }
}

function toneAt(path: string, trace: Trace, node: Json): Tone {
  if (isObj(node) && node.enabled === false) return 'disabled'
  if (!trace) return 'plain'
  if (trace.failedAt?.path === path && /error/.test(trace.failedAt.reason)) return 'error'
  const step = trace.steps.get(path)
  if (!step) return 'skipped'
  if (step.error) return 'error'
  if (step.result && /"result"\s*:\s*false/.test(step.result)) return 'false'
  return 'ran'
}

/** A branch (then, else, otherwise, a parallel branch) ran when any step under it did. */
function branchTone(prefix: string, trace: Trace): Tone {
  if (!trace) return 'plain'
  for (const path of trace.steps.keys()) if (path.startsWith(`${prefix}/`)) return 'ran'
  return 'skipped'
}

function pushCondition(rows: Row[], condition: Json, path: string, depth: number, trace: Trace) {
  rows.push(leaf(path, depth, condition, describeCondition(condition), trace))
  if (!isObj(condition)) return
  const children = list(condition.conditions ?? condition.and ?? condition.or ?? condition.not)
  children.forEach((child, j) => pushCondition(rows, child, `${path}/conditions/${j}`, depth + 1, trace))
}

function pushSteps(rows: Row[], steps: Json | undefined, prefix: string, depth: number, trace: Trace) {
  list(steps).forEach((step, j) => pushAction(rows, step, `${prefix}/${j}`, depth, trace))
}

function pushAction(rows: Row[], action: Json, path: string, depth: number, trace: Trace) {
  if (!isObj(action)) {
    rows.push(leaf(path, depth, action, { text: compact(action, 80), note: '' }, trace))
    return
  }

  if (action.choose !== undefined) {
    rows.push(leaf(path, depth, action, { text: action.alias ? str(action.alias)! : 'Choose', note: '' }, trace))
    list(action.choose).forEach((option, k) => {
      const at = `${path}/choose/${k}`
      const alias = isObj(option) ? str(option.alias) : null
      rows.push(leaf(at, depth + 1, option, { text: alias ?? `Option ${k + 1}`, note: '' }, trace))
      if (!isObj(option)) return
      list(option.conditions).forEach((condition, j) =>
        pushCondition(rows, condition, `${at}/conditions/${j}`, depth + 2, trace),
      )
      pushSteps(rows, option.sequence, `${at}/sequence`, depth + 2, trace)
    })
    if (action.default !== undefined) {
      rows.push(branch(`${path}/default`, depth + 1, 'Otherwise', trace))
      pushSteps(rows, action.default, `${path}/default`, depth + 2, trace)
    }
    return
  }

  if (action.if !== undefined) {
    rows.push(leaf(path, depth, action, { text: action.alias ? str(action.alias)! : 'If', note: '' }, trace))
    list(action.if).forEach((condition, j) => pushCondition(rows, condition, `${path}/if/${j}`, depth + 1, trace))
    rows.push(branch(`${path}/then`, depth, 'Then', trace))
    pushSteps(rows, action.then, `${path}/then`, depth + 1, trace)
    if (action.else !== undefined) {
      rows.push(branch(`${path}/else`, depth, 'Else', trace))
      pushSteps(rows, action.else, `${path}/else`, depth + 1, trace)
    }
    return
  }

  if (isObj(action.repeat)) {
    const repeat = action.repeat
    rows.push(leaf(path, depth, action, describeRepeat(repeat, action), trace))
    list(repeat.while).forEach((condition, j) => pushCondition(rows, condition, `${path}/repeat/while/${j}`, depth + 1, trace))
    pushSteps(rows, repeat.sequence, `${path}/repeat/sequence`, depth + 1, trace)
    list(repeat.until).forEach((condition, j) => pushCondition(rows, condition, `${path}/repeat/until/${j}`, depth + 1, trace))
    return
  }

  if (action.parallel !== undefined) {
    rows.push(leaf(path, depth, action, { text: action.alias ? str(action.alias)! : 'In parallel', note: '' }, trace))
    list(action.parallel).forEach((item, j) => {
      const at = `${path}/parallel/${j}`
      if (isObj(item) && item.sequence !== undefined && !isAction(item)) {
        rows.push(branch(at, depth + 1, str(item.alias) ?? `Branch ${j + 1}`, trace))
        pushSteps(rows, item.sequence, `${at}/sequence`, depth + 2, trace)
      } else {
        pushAction(rows, item, at, depth + 1, trace)
      }
    })
    return
  }

  if (action.sequence !== undefined) {
    rows.push(leaf(path, depth, action, { text: action.alias ? str(action.alias)! : 'Sequence', note: '' }, trace))
    pushSteps(rows, action.sequence, `${path}/sequence`, depth + 1, trace)
    return
  }

  if (action.condition !== undefined) {
    pushCondition(rows, action, path, depth, trace)
    return
  }

  rows.push(leaf(path, depth, action, describeAction(action), trace))
}

function isAction(item: Obj): boolean {
  return ['action', 'service', 'delay', 'event', 'scene', 'choose', 'if', 'repeat', 'parallel', 'condition'].some(
    key => item[key] !== undefined,
  )
}

function section(title: string, path: string): Row {
  return { path: `#${path}`, depth: 0, isSection: true, text: title, note: '', tone: 'plain', change: null, fingerprint: '' }
}

function empty(path: string, text: string): Row {
  return { path, depth: 1, isSection: false, text, note: '', tone: 'skipped', change: null, fingerprint: text }
}

function branch(path: string, depth: number, text: string, trace: Trace): Row {
  return { path, depth, isSection: false, text, note: '', tone: branchTone(path, trace), change: null, fingerprint: text }
}

function leaf(path: string, depth: number, node: Json, words: Words, trace: Trace): Row {
  return {
    path,
    depth,
    isSection: false,
    text: words.text,
    note: words.note,
    tone: toneAt(path, trace, node),
    change: null,
    fingerprint: JSON.stringify(own(node)),
  }
}

/** The node without its nested steps, so a changed child does not mark its parent. */
function own(node: Json): Json {
  if (!isObj(node)) return node
  const out: Obj = {}
  for (const [key, value] of Object.entries(node)) {
    if (CHILD_KEYS.has(key) && (Array.isArray(value) || isObj(value))) continue
    if (key === 'repeat' && isObj(value)) {
      const { sequence: _s, while: _w, until: _u, ...rest } = value
      out[key] = rest
      continue
    }
    out[key] = value
  }
  return out
}

// ---------------------------------------------------------------- words

type Words = { text: string; note: string }

function describeTrigger(trigger: Json): Words {
  if (!isObj(trigger)) return { text: compact(trigger, 80), note: '' }
  const kind = str(trigger.trigger) ?? str(trigger.platform) ?? '?'
  const id = str(trigger.id)
  const detail = triggerDetail(kind, trigger)
  const alias = str(trigger.alias)
  if (alias) return { text: alias, note: [detail, id && `#${id}`].filter(Boolean).join('  ') }
  return { text: detail, note: id ? `#${id}` : '' }
}

function triggerDetail(kind: string, t: Obj): string {
  const forText = t.for !== undefined ? ` for ${duration(t.for)}` : ''
  const attribute = t.attribute !== undefined ? `.${str(t.attribute)}` : ''
  switch (kind) {
    case 'state': {
      const from = t.from !== undefined ? ` from ${value(t.from)}` : ''
      const to = t.to !== undefined ? ` → ${value(t.to)}` : ' changes'
      return `${entities(t.entity_id)}${attribute}${from}${to}${forText}`
    }
    case 'numeric_state':
      return `${entities(t.entity_id)}${attribute}${bounds(t)}${forText}`
    case 'time':
      return `at ${list(t.at).map(item => value(item)).join(', ')}${weekdays(t.weekday)}`
    case 'time_pattern':
      return `every ${['hours', 'minutes', 'seconds'].filter(key => t[key] !== undefined).map(key => `${key} ${value(t[key])}`).join(' ')}`
    case 'sun':
      return `${str(t.event) ?? 'sun'}${t.offset !== undefined ? ` ${value(t.offset)}` : ''}`
    case 'template':
      return `${template(t.value_template)}${forText}`
    case 'event':
      return `event ${value(t.event_type)}${t.event_data !== undefined ? ` ${compact(t.event_data, 40)}` : ''}`
    case 'homeassistant':
      return `Home Assistant ${str(t.event) ?? ''}`
    case 'mqtt':
      return `MQTT ${value(t.topic)}${t.payload !== undefined ? ` = ${value(t.payload)}` : ''}`
    case 'webhook':
      return `webhook ${value(t.webhook_id)}`
    case 'zone':
      return `${entities(t.entity_id)} ${str(t.event) ?? ''} ${value(t.zone)}`
    case 'device':
      return `device ${str(t.domain) ?? ''} ${str(t.type) ?? ''}${t.entity_id !== undefined ? ` ${entities(t.entity_id)}` : ''}${forText}`
    case 'tag':
      return `tag ${value(t.tag_id)}`
    case 'conversation':
      return `says ${list(t.command).map(item => `"${str(item)}"`).join(' / ')}`
    case 'calendar':
      return `calendar ${entities(t.entity_id)} ${str(t.event) ?? ''}${t.offset !== undefined ? ` ${value(t.offset)}` : ''}`
    default:
      return `${kind} ${compact(rest(t, ['trigger', 'platform', 'id', 'alias']), 60)}`
  }
}

function describeCondition(condition: Json): Words {
  if (typeof condition === 'string') return { text: template(condition), note: '' }
  if (!isObj(condition)) return { text: compact(condition, 80), note: '' }
  const alias = str(condition.alias)
  const detail = conditionDetail(condition)
  return alias ? { text: alias, note: detail } : { text: detail, note: '' }
}

function conditionDetail(c: Obj): string {
  const kind = str(c.condition) ?? (c.and ? 'and' : c.or ? 'or' : c.not ? 'not' : '?')
  const forText = c.for !== undefined ? ` for ${duration(c.for)}` : ''
  const attribute = c.attribute !== undefined ? `.${str(c.attribute)}` : ''
  switch (kind) {
    case 'and':
      return 'all of'
    case 'or':
      return 'any of'
    case 'not':
      return 'none of'
    case 'state':
      return `if ${entities(c.entity_id)}${attribute} is ${list(c.state).map(item => value(item)).join(' or ')}${forText}`
    case 'numeric_state':
      return `if ${entities(c.entity_id)}${attribute}${bounds(c)}`
    case 'template':
      return `if ${template(c.value_template)}`
    case 'trigger':
      return `if triggered by ${list(c.id).map(item => `#${value(item)}`).join(' or ')}`
    case 'time': {
      const parts = [c.after !== undefined && `after ${value(c.after)}`, c.before !== undefined && `before ${value(c.before)}`]
      return `if ${parts.filter(Boolean).join(' and ') || 'time'}${weekdays(c.weekday)}`
    }
    case 'sun': {
      const parts = [c.after !== undefined && `after ${value(c.after)}`, c.before !== undefined && `before ${value(c.before)}`]
      return `if ${parts.filter(Boolean).join(' and ') || 'sun'}`
    }
    case 'zone':
      return `if ${entities(c.entity_id)} in ${value(c.zone)}`
    case 'device':
      return `if device ${str(c.domain) ?? ''} ${str(c.type) ?? ''}${c.entity_id !== undefined ? ` ${entities(c.entity_id)}` : ''}`
    default:
      return `if ${kind} ${compact(rest(c, ['condition', 'alias']), 60)}`
  }
}

function describeAction(a: Obj): Words {
  const alias = str(a.alias)
  const detail = actionDetail(a)
  return alias ? { text: alias, note: detail } : { text: detail, note: '' }
}

function actionDetail(a: Obj): string {
  const service = str(a.action) ?? str(a.service)
  if (service) {
    const target = targets(a)
    const data = isObj(a.data) ? a.data : isObj(a.data_template) ? a.data_template : null
    const dataText = data && Object.keys(data).length > 0 ? `  ${Object.entries(data).map(([key, v]) => `${key} ${value(v)}`).join(', ')}` : ''
    return `${service}${target ? ` → ${target}` : ''}${dataText}`
  }
  if (a.delay !== undefined) return `wait ${duration(a.delay)}`
  if (a.wait_template !== undefined)
    return `wait until ${template(a.wait_template)}${a.timeout !== undefined ? ` (timeout ${duration(a.timeout)})` : ''}`
  if (a.wait_for_trigger !== undefined) {
    const count = list(a.wait_for_trigger).length
    return `wait for ${count === 1 ? describeTrigger(list(a.wait_for_trigger)[0] ?? null).text : `${count} triggers`}${a.timeout !== undefined ? ` (timeout ${duration(a.timeout)})` : ''}`
  }
  if (a.event !== undefined) return `fire event ${value(a.event)}`
  if (a.scene !== undefined) return `scene ${value(a.scene)}`
  if (isObj(a.variables)) return `set ${Object.keys(a.variables).join(', ')}`
  if (a.stop !== undefined) return `stop: ${value(a.stop)}${a.error === true ? ' (as error)' : ''}`
  if (a.device_id !== undefined) return `device ${str(a.domain) ?? ''} ${str(a.type) ?? ''}`
  return compact(rest(a, ['alias', 'enabled']), 80)
}

function describeRepeat(repeat: Obj, action: Obj): Words {
  const alias = str(action.alias)
  const how =
    repeat.count !== undefined
      ? `repeat ${value(repeat.count)} times`
      : repeat.for_each !== undefined
        ? `for each of ${compact(repeat.for_each, 40)}`
        : repeat.while !== undefined
          ? 'repeat while'
          : repeat.until !== undefined
            ? 'repeat until'
            : 'repeat'
  return alias ? { text: alias, note: how } : { text: how, note: '' }
}

function targets(a: Obj): string {
  const target = isObj(a.target) ? a.target : {}
  const parts = [
    target.entity_id ?? a.entity_id,
    target.area_id !== undefined ? list(target.area_id).map(area => `area ${value(area)}`) : undefined,
    target.device_id !== undefined ? `${list(target.device_id).length} device(s)` : undefined,
    target.label_id !== undefined ? list(target.label_id).map(label => `label ${value(label)}`) : undefined,
  ].filter(part => part !== undefined && part !== null)
  return parts.map(part => (typeof part === 'string' && part.endsWith('device(s)') ? part : entities(part as Json))).join(', ')
}

function bounds(t: Obj): string {
  return [t.above !== undefined && ` above ${value(t.above)}`, t.below !== undefined && ` below ${value(t.below)}`]
    .filter(Boolean)
    .join(' and')
}

function weekdays(weekday: Json | undefined): string {
  return weekday === undefined ? '' : ` on ${list(weekday).map(day => value(day)).join(', ')}`
}

function entities(ids: Json | undefined): string {
  const all = list(ids ?? null).map(id => value(id))
  if (all.length === 0) return '(no entity)'
  return all.length <= 2 ? all.join(', ') : `${all.slice(0, 2).join(', ')} +${all.length - 2}`
}

function duration(d: Json): string {
  if (typeof d === 'number') return `${d}s`
  if (typeof d === 'string') return d
  if (isObj(d)) {
    const units: [string, string][] = [['days', 'd'], ['hours', 'h'], ['minutes', 'm'], ['seconds', 's'], ['milliseconds', 'ms']]
    const text = units.filter(([key]) => d[key] !== undefined).map(([key, unit]) => `${value(d[key])}${unit}`).join(' ')
    return text || compact(d, 30)
  }
  return compact(d, 30)
}

function template(t: Json | undefined): string {
  return typeof t === 'string' ? t.replace(/\s+/g, ' ').trim() : compact(t ?? null, 60)
}

function value(v: Json | undefined): string {
  if (typeof v === 'string') return v
  if (v === undefined) return '?'
  return compact(v, 40)
}

function rest(node: Obj, drop: string[]): Obj {
  return Object.fromEntries(Object.entries(node).filter(([key]) => !drop.includes(key)))
}

export function compact(v: Json | unknown, max: number): string {
  const text = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function list(v: Json | undefined): Json[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

function str(v: Json | undefined): string | null {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null
}

export function isObj(v: Json | undefined): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
