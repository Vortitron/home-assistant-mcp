// A side pane with a Home Assistant dashboard in it, working: live states, and
// controls that do what the dashboard's own do. Lights and switches toggle,
// sliders and thermostats step, scenes and scripts run, a card's buttons
// perform their actions (asking first where the card asks first).
//
// It shows the dashboard Claude reads or saves (ha_get_dashboard,
// ha_save_dashboard), with what a save changed lit for a few seconds, or one
// picked with /dash. States are read every few seconds for the view on show;
// Markdown cards are rendered by the home, templates and all; history graphs
// become sparklines. Cards only Home Assistant can draw keep a line naming
// them and their entities.

import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Dash, Live } from '../types'
import { changedCards, entitiesOf, iconFor, sparkline, stepFor, toggleFor, viewsOf } from './lovelace'
import type { Card, Row, ServiceCall, View } from './lovelace'

const PANE = 'vome-dash'
const STATE_MS = 3_000
const TEMPLATE_MS = 30_000
const HISTORY_MS = 60_000
const LIT_MS = 8_000
const CONFIRM_MS = 6_000
const MAX_ENTITIES = 80
const READS = ['ha_get_state', 'ha_render_template', 'ha_get_history', 'ha_get_dashboard', 'ha_list_dashboards']

const dash = { plugin: 'vome-dash', key: 'dash' } as const
const view = { plugin: 'vome-dash', key: 'view' } as const
const states = { plugin: 'vome-dash', key: 'states' } as const
const lit = { plugin: 'vome-dash', key: 'lit' } as const
const rendered = { plugin: 'vome-dash', key: 'rendered' } as const
const history = { plugin: 'vome-dash', key: 'history' } as const
const confirm = { plugin: 'vome-dash', key: 'confirm' } as const
const choices = { plugin: 'vome-dash', key: 'choices' } as const
const blocked = { plugin: 'vome-dash', key: 'blocked' } as const
const note = { plugin: 'vome-dash', key: 'note' } as const

let isPolling = false
let lastTemplates = 0
let lastHistory = 0
let settingsFile = '~/.claude/settings.json'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'dash', description: 'Show a Home Assistant dashboard, working, in a side pane', argumentHint: '[dashboard url_path]' })
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? '~'}/.claude`
    settingsFile = `${configDir.replace(/\/+$/, '')}/settings.json`
    $.clock.every(STATE_MS, () => void poll($))
    return next(e)
  })

  on('command.run', { command: 'dash' }, async ($, e) => {
    const wanted = e.args.trim()
    const current = (await $.state.get(dash)).value ?? null
    const server = current?.server ?? (await dashServers($))[0]
    if (!server) return { text: 'No connected MCP server has ha_get_dashboard yet: connect Home Assistant through Vome first (vome-connect).' }
    const opened = await $.ui.open({ id: PANE, title: 'Dashboard' })
    if (wanted) void loadDashboard($, server, wanted)
    else void listDashboards($, server)
    return { text: opened.isPlaced ? (wanted ? `Opening ${wanted} in the pane.` : "Listing the home's dashboards in the pane.") : `The dashboard pane is not drawn here: ${opened.reason}.` }
  })

  on('tool.call', async ($, e, next) => {
    const match = /^mcp__(.+)__(ha_get_dashboard|ha_save_dashboard|ha_list_dashboards)$/.exec(e.tool)
    if (!match?.[1] || !match[2]) return next(e)
    const server = match[1]
    const args = e as unknown as { url_path?: unknown; config?: unknown }
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran

    if (match[2] === 'ha_get_dashboard') {
      const body = parseJson(ran.text ?? '')
      if (body && body.config && typeof body.config === 'object') {
        await showDashboard($, server, String(body.url_path ?? args.url_path ?? 'lovelace'), body.config as Record<string, unknown>)
      }
    } else if (match[2] === 'ha_save_dashboard' && args.config && typeof args.config === 'object') {
      const before = (await $.state.get(dash)).value ?? null
      const urlPath = String(args.url_path ?? 'lovelace')
      const config = args.config as Record<string, unknown>
      if (before && before.urlPath === urlPath) await $.state.set(lit, { keys: [...changedCards(before.config, config)], at: Date.now() })
      await showDashboard($, server, urlPath, config)
    } else if (match[2] === 'ha_list_dashboards') {
      await setChoices($, ran.text ?? '')
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code, Markdown } = $.ui.resolve(e)
    const current = (await $.state.get(dash)).value ?? null
    const shownView = (await $.state.get(view)).value ?? 0
    const live = (await $.state.get(states)).value ?? {}
    const lighting = (await $.state.get(lit)).value ?? null
    const texts = (await $.state.get(rendered)).value ?? {}
    const series = (await $.state.get(history)).value ?? {}
    const asking = (await $.state.get(confirm)).value ?? null
    const picking = (await $.state.get(choices)).value ?? null
    const refusal = (await $.state.get(blocked)).value ?? null
    const message = (await $.state.get(note)).value ?? null
    const width = Math.max(30, e.props.bodyColumns)
    const isLit = (key: string) => lighting !== null && Date.now() - lighting.at < LIT_MS && lighting.keys.some(k => key === k || key.startsWith(`${k}/`))

    const help = refusal ? (
      <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1} marginTop={1}>
        {refusal.tool === 'ha_call_service' ? (
          <Text color="warning" wrap="wrap">
            Auto mode refused the press. Pressing a control here calls ha_call_service, and allowing that by name would
            let Claude change things without asking too. Switch auto mode off to use the controls, or allow it in
            {' '}{settingsFile} if you are happy with that:
          </Text>
        ) : (
          <Text color="warning" wrap="wrap">
            Auto mode refused the pane's read of live states. Add these to permissions.allow in {settingsFile}; they only read:
          </Text>
        )}
        <Code source={refusal.tool === 'ha_call_service' ? `"mcp__${refusal.server}__ha_call_service"` : READS.map(t => `"mcp__${refusal.server}__${t}"`).join(',\n')} />
        <Box flexDirection="row" gap={2}>
          <Button
            key="copy-rule"
            hotkey="c"
            onPress={press =>
              $.ui.copy({
                text: refusal.tool === 'ha_call_service' ? `"mcp__${refusal.server}__ha_call_service"` : READS.map(t => `"mcp__${refusal.server}__${t}"`).join(',\n'),
                surface: press.surface,
              })
            }
          >
            Copy
          </Button>
          <Button key="dismiss-rule" dimColor onPress={() => $.state.set(blocked, null)}>
            Dismiss
          </Button>
        </Box>
      </Box>
    ) : null

    const picker = picking ? (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Dashboards</Text>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {picking.map(choice => (
            <Button
              key={`pick-${choice.urlPath}`}
              onPress={async () => {
                await $.state.set(choices, null)
                const server = current?.server ?? (await dashServers($))[0]
                if (server) await loadDashboard($, server, choice.urlPath)
              }}
            >
              {choice.title}
            </Button>
          ))}
        </Box>
      </Box>
    ) : null

    if (!current) {
      return (
        <Box flexDirection="column">
          <Text dimColor wrap="wrap">
            No dashboard yet. It appears here, working, when Claude reads or saves one, or pick one with /dash.
          </Text>
          {picker}
          {message ? <Text color="warning" wrap="wrap">{message}</Text> : null}
          {help}
        </Box>
      )
    }

    const views = viewsOf(current.config)
    const index = Math.min(shownView, Math.max(0, views.length - 1))
    const shown: View | undefined = views[index]
    const columns = width >= 96 ? 2 : 1
    const cardWidth = columns === 2 ? Math.floor((width - 1) / 2) : width

    const press = async (key: string, call: ServiceCall) => {
      if (call.confirm && !(asking && asking.key === key && asking.until > Date.now())) {
        await $.state.set(confirm, { key, until: Date.now() + CONFIRM_MS })
        return
      }
      await $.state.set(confirm, null)
      await callService($, current.server, call)
    }

    const entityRow = (row: Extract<Row, { kind: 'entity' }>, key: string) => {
      const now: Live | undefined = live[row.entity]
      const state = now?.state ?? '…'
      const attributes = now?.attributes ?? {}
      const name = row.name ?? (typeof attributes.friendly_name === 'string' ? attributes.friendly_name : row.entity)
      const unit = typeof attributes.unit_of_measurement === 'string' ? ` ${attributes.unit_of_measurement}` : ''
      const toggle = toggleFor(row.entity)
      const down = now ? stepFor(row.entity, attributes, state, -1) : null
      const up = now ? stepFor(row.entity, attributes, state, 1) : null
      const isOn = state === 'on'
      const shownState = row.entity.startsWith('light.') && isOn && typeof attributes.brightness === 'number' ? `on ${Math.round((attributes.brightness / 255) * 100)}%` : `${formatState(state)}${unit}`
      return (
        <Box flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text color={isOn ? 'warning' : undefined}>{iconFor(row.entity, state)}</Text> {name}
          </Text>
          <Box flexDirection="row" gap={1}>
            <Text color={state === 'unavailable' ? 'error' : isOn ? 'warning' : undefined} dimColor={state === 'off'}>
              {shownState}
            </Text>
            {down ? (
              <Button key={`${key}/down`} dimColor onPress={() => press(`${key}/down`, down)}>
                −
              </Button>
            ) : null}
            {up ? (
              <Button key={`${key}/up`} dimColor onPress={() => press(`${key}/up`, up)}>
                +
              </Button>
            ) : null}
            {toggle && toggle.service === 'toggle' ? (
              <Button key={`${key}/toggle`} onPress={() => press(`${key}/toggle`, toggle)}>
                {isOn ? 'Off' : 'On'}
              </Button>
            ) : toggle ? (
              <Button key={`${key}/run`} onPress={() => press(`${key}/run`, toggle)}>
                Run
              </Button>
            ) : null}
          </Box>
        </Box>
      )
    }

    const drawCard = (card: Card, cardKey: string): RenderChildren => {
      const titleColour = isLit(card.key) ? 'suggestion' : undefined
      const body: RenderChildren[] = []
      if (card.markdown !== null) {
        const text = texts[card.key] ?? card.markdown.replace(/\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g, '…')
        body.push(<Markdown text={text} />)
      }
      if (card.hours !== null) {
        for (const row of card.rows) {
          if (row.kind !== 'entity') continue
          const points = series[card.key]?.[row.entity] ?? []
          const numbers = points.filter((p): p is number => typeof p === 'number')
          const name = row.name ?? row.entity
          body.push(
            <Text wrap="truncate-end">
              <Text dimColor>{name.padEnd(14).slice(0, 14)} </Text>
              {numbers.length > 1 ? (
                <Text color="suggestion">{sparkline(numbers, Math.max(8, cardWidth - 26))}</Text>
              ) : points.length > 0 ? (
                <Text>{[...new Set(points.map(String))].slice(-4).join(' → ')}</Text>
              ) : (
                <Text dimColor>…</Text>
              )}
              <Text dimColor> {formatState(live[row.entity]?.state ?? '')}</Text>
            </Text>,
          )
        }
      } else {
        card.rows.forEach((row, i) => {
          const key = `${cardKey}/r${i}`
          if (row.kind === 'entity') body.push(entityRow(row, key))
          else if (row.kind === 'text') body.push(<Text dimColor>{row.text}</Text>)
          else {
            const isAsking = asking !== null && asking.key === key && asking.until > Date.now()
            body.push(
              <Box flexDirection="row" justifyContent="space-between">
                <Text wrap="truncate-end">{isAsking ? <Text color="warning">{row.call?.confirm} Press again.</Text> : <Text>▸ {row.name}</Text>}</Text>
                {row.call ? (
                  <Button key={key} onPress={() => press(key, row.call!)}>
                    {isAsking ? 'Yes' : 'Run'}
                  </Button>
                ) : null}
              </Box>,
            )
          }
        })
      }
      if (card.isForeign) body.unshift(<Text dimColor>{card.type.replace(/^custom:/, '')} · drawn by Home Assistant</Text>)
      card.children.forEach((child, i) => body.push(drawCard(child, `${cardKey}/c${i}`)))
      if (card.isForeign && card.rows.length === 0 && card.children.length === 0 && !card.title) return null
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={titleColour ?? 'subtle'} paddingX={1} width={cardWidth}>
          {card.title ? (
            <Text bold color={titleColour} wrap="truncate-end">
              {card.title}
            </Text>
          ) : null}
          {body}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Text bold>{current.title}</Text>
          {views.map((v, i) => (
            <Button key={`view-${i}`} dimColor={i !== index} onPress={() => $.state.set(view, i)}>
              {v.title}
            </Button>
          ))}
        </Box>
        <Box flexDirection="row" flexWrap="wrap">
          {(shown?.cards ?? []).map(card => drawCard(card, card.key))}
        </Box>
        {message ? <Text color="warning" wrap="wrap">{message}</Text> : null}
        {help}
        {picker}
        <Box flexDirection="row" gap={2} marginTop={1}>
          <Button key="other" hotkey="o" dimColor onPress={() => listDashboards($, current.server)}>
            Other dashboard
          </Button>
          <Button key="reload" hotkey="r" dimColor onPress={() => loadDashboard($, current.server, current.urlPath)}>
            Reload
          </Button>
        </Box>
      </Box>
    )
  })
}

// ---------------------------------------------------------------- loading and live state

async function showDashboard($: EngineInterface, server: string, urlPath: string, config: Record<string, unknown>) {
  const before = (await $.state.get(dash)).value ?? null
  const title = typeof config.title === 'string' ? config.title : urlPath
  const next: Dash = { server, urlPath, title, config, at: Date.now() }
  if (!before || before.urlPath !== urlPath || before.server !== server) {
    await $.state.set(view, 0)
    await $.state.set(rendered, {})
    await $.state.set(history, {})
    lastTemplates = 0
    lastHistory = 0
  }
  await $.state.set(dash, next)
  await $.state.set(choices, null)
  await $.ui.open({ id: PANE, title: 'Dashboard' }).catch(() => undefined)
  void poll($, true)
}

async function loadDashboard($: EngineInterface, server: string, urlPath: string) {
  const text = await callMcp($, server, 'ha_get_dashboard', { url_path: urlPath })
  const body = text ? parseJson(text) : null
  if (body && body.config && typeof body.config === 'object') await showDashboard($, server, urlPath, body.config as Record<string, unknown>)
}

async function listDashboards($: EngineInterface, server: string) {
  const text = await callMcp($, server, 'ha_list_dashboards', {})
  if (text) await setChoices($, text)
}

async function setChoices($: EngineInterface, text: string) {
  const body = parseJson(text)
  const rows = body && Array.isArray(body.dashboards) ? (body.dashboards as Record<string, unknown>[]) : []
  const list = rows
    .filter(row => typeof row.url_path === 'string')
    .map(row => ({ urlPath: String(row.url_path), title: typeof row.title === 'string' ? row.title : String(row.url_path) }))
  if (list.length > 0) await $.state.set(choices, list)
}

/** A press: the call, then a quick read of what it changed, so the pane answers at once. */
async function callService($: EngineInterface, server: string, call: ServiceCall) {
  const { confirm: _asked, ...args } = call
  void _asked
  const text = await callMcp($, server, 'ha_call_service', args)
  if (text === null) return
  const target = call.target?.entity_id
  const ids = Array.isArray(target) ? target : target ? [target] : []
  if (ids.length > 0) await readStates($, server, ids)
}

/** States every few seconds for the view on show; templates and history less often. */
async function poll($: EngineInterface, isNow = false) {
  if (isPolling) return
  const current = (await $.state.get(dash)).value ?? null
  if (!current) return
  if ((await $.state.get(blocked)).value && !isNow) return
  isPolling = true
  try {
    const views = viewsOf(current.config)
    const index = Math.min((await $.state.get(view)).value ?? 0, Math.max(0, views.length - 1))
    const cards = views[index]?.cards ?? []
    const ids = entitiesOf(cards).slice(0, MAX_ENTITIES)
    if (ids.length > 0) await readStates($, current.server, ids)
    if (isNow || Date.now() - lastTemplates > TEMPLATE_MS) {
      lastTemplates = Date.now()
      await renderTemplates($, current.server, cards)
    }
    if (isNow || Date.now() - lastHistory > HISTORY_MS) {
      lastHistory = Date.now()
      await readHistory($, current.server, cards)
    }
  } finally {
    isPolling = false
  }
}

async function readStates($: EngineInterface, server: string, ids: string[]) {
  const text = await callMcp($, server, 'ha_get_state', { entity_ids: ids })
  const body = text ? parseJson(text) : null
  const rows = body && Array.isArray(body.entities) ? (body.entities as Record<string, unknown>[]) : []
  if (rows.length === 0) return
  const before = (await $.state.get(states)).value ?? {}
  const next = { ...before }
  let isChanged = false
  for (const row of rows) {
    if (typeof row.entity_id !== 'string') continue
    const state = row.state === null || row.state === undefined ? 'unknown' : String(row.state)
    const attributes = row.attributes && typeof row.attributes === 'object' ? (row.attributes as Record<string, unknown>) : {}
    const was = before[row.entity_id]
    if (!was || was.state !== state || JSON.stringify(was.attributes) !== JSON.stringify(attributes)) isChanged = true
    next[row.entity_id] = { state, attributes, at: Date.now() }
  }
  if (isChanged) await $.state.set(states, next)
}

/** Markdown cards with templates, rendered by the home: the dashboard's own words, not its source. */
async function renderTemplates($: EngineInterface, server: string, cards: Card[]) {
  const all: Card[] = []
  const walk = (card: Card) => {
    if (card.markdown !== null && /\{\{|\{%/.test(card.markdown)) all.push(card)
    card.children.forEach(walk)
  }
  cards.forEach(walk)
  if (all.length === 0) return
  const before = (await $.state.get(rendered)).value ?? {}
  const next = { ...before }
  for (const card of all.slice(0, 6)) {
    const text = await callMcp($, server, 'ha_render_template', { template: card.markdown })
    if (text !== null) next[card.key] = text.replace(/\n?\[vome-instance\][^\n]*/g, '')
  }
  await $.state.set(rendered, next)
}

async function readHistory($: EngineInterface, server: string, cards: Card[]) {
  const graphs: Card[] = []
  const walk = (card: Card) => {
    if (card.hours !== null) graphs.push(card)
    card.children.forEach(walk)
  }
  cards.forEach(walk)
  if (graphs.length === 0) return
  const before = (await $.state.get(history)).value ?? {}
  const next = { ...before }
  for (const card of graphs.slice(0, 6)) {
    const ids = card.rows.flatMap(row => (row.kind === 'entity' ? [row.entity] : []))
    if (ids.length === 0) continue
    const start = new Date(Date.now() - (card.hours ?? 24) * 3600_000).toISOString()
    const text = await callMcp($, server, 'ha_get_history', { entity_ids: ids, start_time: start, minimal: true })
    const body = text ? parseJson(text) : null
    const lists = body && Array.isArray(body.series) ? (body.series as Record<string, unknown>[][]) : []
    const byEntity: Record<string, Array<number | string>> = {}
    lists.forEach((list, i) => {
      const id = typeof list[0]?.entity_id === 'string' ? (list[0].entity_id as string) : ids[i]
      if (!id) return
      byEntity[id] = list.map(point => {
        const value = Number(point.state)
        return Number.isFinite(value) && String(point.state).trim() !== '' ? value : String(point.state)
      })
    })
    next[card.key] = byEntity
  }
  await $.state.set(history, next)
}

/** One call from the pane; a refusal shows what to allow, any other failure a note. */
async function callMcp($: EngineInterface, server: string, tool: string, args: Record<string, unknown>): Promise<string | null> {
  try {
    const result = await $.mcp.call(server, tool, args)
    const text = result.content.map(block => block.text ?? '').join('\n')
    if (result.isError) {
      await $.state.set(note, firstLine(text) ?? `${tool} failed.`)
      return null
    }
    if ((await $.state.get(note)).value) await $.state.set(note, null)
    return text
  } catch (error) {
    if (/auto mode|classifier|permission|denied|not allowed/i.test(String(error))) {
      await $.state.set(blocked, { server, tool })
    } else {
      await $.state.set(note, firstLine(String(error)))
    }
    return null
  }
}

// ---------------------------------------------------------------- small things

async function dashServers($: EngineInterface): Promise<string[]> {
  return (await $.tool.list())
    .map(tool => /^mcp__(.+)__ha_get_dashboard$/.exec(tool.name)?.[1])
    .filter((server): server is string => !!server)
}

function formatState(state: string): string {
  const number = Number(state)
  if (state.trim() !== '' && Number.isFinite(number) && !Number.isInteger(number)) return String(Math.round(number * 100) / 100)
  return state.replace(/_/g, ' ')
}

function firstLine(text: string | null): string | null {
  return text ? (text.split('\n').find(line => line.trim()) ?? null) : null
}

/** The JSON body of a vome MCP reply, which ends with a `[vome-instance]` line. */
function parseJson(raw: string): Record<string, unknown> | null {
  const text = raw.replace(/\[vome-instance\][^\n]*/g, '')
  const start = text.search(/[[{]/)
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}
