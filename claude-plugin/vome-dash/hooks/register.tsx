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

import type { Dash, Live, Pending } from '../types'
import { brailleChart, changedCards, entitiesOf, glowFor, glyphFor, lightColour, stepFor, toggleFor, viewsOf } from './lovelace'
import type { Card, Row, ServiceCall, View } from './lovelace'

const PANE = 'vome-dash'
/**
 * Vome rate-limits each Home Assistant endpoint per key (500 an hour), and Claude's own reads share
 * it. So states are read every 10 s, and only while the pane is on show: at most 360 an hour.
 */
const STATE_MS = 10_000
/** A refused read (the hourly limit) pauses the pane's reads this long. */
const BACKOFF_MS = 5 * 60_000
const TEMPLATE_MS = 60_000
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
const pending = { plugin: 'vome-dash', key: 'pending' } as const
const sidebarOpen = { plugin: 'vome-dash', key: 'sidebarOpen' } as const
/** How long a press waits to see its device change, how often it looks, how long the outcome stays. */
const WATCH_MS = 8_000
/** After a press, the device is looked at this long after it, then no more. */
const WATCH_AT_MS = [1_000, 2_500, 5_000, 8_000]
const WATCH_EVERY_MS = 500
const OUTCOME_MS = 3_000
const SIDEBAR = 20
const blocked = { plugin: 'vome-dash', key: 'blocked' } as const
const note = { plugin: 'vome-dash', key: 'note' } as const

let isPolling = false
/** Reads paused until then: the hourly limit was hit. */
let pausedUntil = 0
let lastTemplates = 0
let lastHistory = 0
let settingsFile = '~/.claude/settings.json'
/** The last press, so Retry can make it again once it is allowed. */
let lastCall: { server: string; call: ServiceCall } | null = null

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'dash', description: 'Show a Home Assistant dashboard, working, in a side pane', argumentHint: '[dashboard url_path]' })
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? '~'}/.claude`
    settingsFile = `${configDir.replace(/\/+$/, '')}/settings.json`
    $.clock.every(STATE_MS, () => void poll($))
    $.clock.every(WATCH_EVERY_MS, () => void watchPresses($))
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
    const settingsLink = <Markdown text={`[${settingsFile}](file://${settingsFile})`} />
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
    const presses = (await $.state.get(pending)).value ?? {}
    const isMenuOpen = (await $.state.get(sidebarOpen)).value ?? false
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
        {settingsLink}
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
          <Button
            key="retry"
            hotkey="t"
            onPress={async () => {
              await $.state.set(blocked, null)
              if (refusal.tool === 'ha_call_service' && lastCall) await callService($, lastCall.server, lastCall.call)
              else void poll($, true)
            }}
          >
            {refusal.tool === 'ha_call_service' ? 'Retry the press' : 'Retry'}
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
    // The home's dashboards down the left, as Home Assistant's sidebar has them, until one is picked.
    const hasMenu = (picking?.length ?? 0) > 1
    const isSidebar = isMenuOpen && hasMenu && width >= 70
    const mainWidth = isSidebar ? width - SIDEBAR - 1 : width
    // Columns as Home Assistant's desktop layout has them: as many as fit, cards stacked in each.
    const columns = mainWidth >= 120 ? 3 : mainWidth >= 72 ? 2 : 1
    const cardWidth = columns > 1 ? Math.floor((mainWidth - (columns - 1)) / columns) : mainWidth
    /** What a control's press is doing, for the row it is on. */
    const pressOf = (prefix: string): Pending | undefined =>
      Object.entries(presses)
        .filter(([key]) => key === prefix || key.startsWith(`${prefix}/`))
        .map(([, p]) => p)
        .sort((a, b) => b.at - a.at)[0]
    const spinner = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[Math.floor(Date.now() / 120) % 10]
    const pressNote = (p: Pending | undefined) =>
      !p ? null : p.phase === 'sending' ? (
        <Text color="warning">{spinner} sending</Text>
      ) : p.phase === 'sent' ? (
        <Text color="suggestion">{spinner} sent, waiting</Text>
      ) : p.phase === 'done' ? (
        <Text color="success">✓</Text>
      ) : p.phase === 'quiet' ? (
        <Text color="warning">no change seen</Text>
      ) : (
        <Text color="error">✗ failed</Text>
      )

    const press = async (key: string, call: ServiceCall) => {
      if (call.confirm && !(asking && asking.key === key && asking.until > Date.now())) {
        await $.state.set(confirm, { key, until: Date.now() + CONFIRM_MS })
        return
      }
      await $.state.set(confirm, null)
      await pressAndWatch($, current.server, key, call)
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
      const going = pressOf(key)
      const isFresh = going?.phase === 'done'
      // A light that is on glows in its own colour, as brightly as it is lit.
      const glow = glowFor(row.entity, state, attributes)
      const isLight = row.entity.startsWith('light.') && isOn
      return (
        <Box flexDirection="row" justifyContent="space-between" backgroundColor={glow ?? undefined}>
          <Text wrap="truncate-end" backgroundColor={glow ?? undefined}>
            {glyphFor(row.entity, attributes, row.icon)} <Text bold={isLight}>{name}</Text>
          </Text>
          <Box flexDirection="row" gap={1}>
            {pressNote(going)}
            <Text
              color={isFresh ? 'success' : state === 'unavailable' ? 'error' : isLight ? lightColour(attributes) : isOn ? 'warning' : undefined}
              backgroundColor={glow ?? undefined}
              bold={isFresh || isLight}
              dimColor={state === 'off' && !isFresh}
            >
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
          const unit = typeof live[row.entity]?.attributes.unit_of_measurement === 'string' ? ` ${live[row.entity]!.attributes.unit_of_measurement}` : ''
          body.push(
            <Text wrap="truncate-end">
              {name}
              <Text dimColor>
                {'  '}
                {formatState(live[row.entity]?.state ?? '')}
                {unit}
                {numbers.length > 1 ? `  (${formatState(String(Math.min(...numbers)))}–${formatState(String(Math.max(...numbers)))})` : ''}
              </Text>
            </Text>,
          )
          if (numbers.length > 1) {
            for (const line of brailleChart(numbers, Math.max(10, cardWidth - 4), 3)) {
              body.push(<Text color="suggestion">{line}</Text>)
            }
          } else {
            body.push(<Text dimColor>{points.length > 0 ? [...new Set(points.map(String))].slice(-4).join(' → ') : '…'}</Text>)
          }
        }
      } else if (card.type === 'glance') {
        // A glance card as Home Assistant draws it: a row of icons, each with its name and state under it.
        body.push(
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {card.rows.map((row, i) => {
              if (row.kind !== 'entity') return null
              const now = live[row.entity]
              const attributes = now?.attributes ?? {}
              const state = now?.state ?? '…'
              const name = row.name ?? (typeof attributes.friendly_name === 'string' ? attributes.friendly_name : row.entity)
              const toggle = toggleFor(row.entity)
              const key = `${cardKey}/r${i}`
              const isOn = state === 'on'
              return (
                <Box flexDirection="column" alignItems="center" width={12} backgroundColor={glowFor(row.entity, state, attributes) ?? undefined}>
                  <Text>{glyphFor(row.entity, attributes, row.icon)}</Text>
                  <Text wrap="truncate-end" dimColor={!isOn}>
                    {name}
                  </Text>
                  <Text color={isOn ? 'warning' : undefined} dimColor={!isOn}>
                    {formatState(state)}
                  </Text>
                  {toggle && toggle.service === 'toggle' ? (
                    <Button key={`${key}/toggle`} dimColor onPress={() => press(`${key}/toggle`, toggle)}>
                      {isOn ? 'Off' : 'On'}
                    </Button>
                  ) : null}
                  {pressNote(pressOf(key))}
                </Box>
              )
            })}
          </Box>,
        )
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
                <Box flexDirection="row" gap={1}>
                  {pressNote(pressOf(key))}
                  {row.call ? (
                    <Button key={key} onPress={() => press(key, row.call!)}>
                      {isAsking ? 'Yes' : 'Run'}
                    </Button>
                  ) : null}
                </Box>
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

    const open = (urlPath: string) => async () => {
      await $.state.set(sidebarOpen, false)
      if (urlPath !== current.urlPath) await loadDashboard($, current.server, urlPath)
    }
    const sidebar = isSidebar ? (
      <Box flexDirection="column" width={SIDEBAR} borderStyle="round" borderColor="subtle" paddingX={1}>
        <Text dimColor>Dashboards</Text>
        {(picking ?? []).map(choice => (
          <Button key={`side-${choice.urlPath}`} dimColor={choice.urlPath !== current.urlPath} onPress={open(choice.urlPath)}>
            {`${choice.urlPath === current.urlPath ? '▸ ' : '  '}${choice.title}`}
          </Button>
        ))}
      </Box>
    ) : null
    // Narrow, the same as a row along the top.
    const topRow =
      isMenuOpen && hasMenu && !isSidebar ? (
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {(picking ?? []).map(choice => (
            <Button key={`side-${choice.urlPath}`} dimColor={choice.urlPath !== current.urlPath} onPress={open(choice.urlPath)}>
              {choice.title}
            </Button>
          ))}
        </Box>
      ) : null

    const main = (
      <Box flexDirection="column" width={mainWidth}>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {hasMenu ? (
            <Button key="menu" hotkey="m" dimColor={!isMenuOpen} onPress={() => $.state.set(sidebarOpen, !isMenuOpen)}>
              ☰
            </Button>
          ) : null}
          <Text bold>{current.title}</Text>
          {views.length > 1
            ? views.map((v, i) => (
                <Button key={`view-${i}`} dimColor={i !== index} onPress={() => $.state.set(view, i)}>
                  {v.title}
                </Button>
              ))
            : null}
        </Box>
        <Box flexDirection="row" gap={1}>
          {masonry(shown?.cards ?? [], columns).map(column => (
            <Box flexDirection="column" width={cardWidth}>
              {column.map(card => drawCard(card, card.key))}
            </Box>
          ))}
        </Box>
        {message ? <Text color="warning" wrap="wrap">{message}</Text> : null}
        {help}
        <Box flexDirection="row" gap={2} marginTop={1}>
          <Button key="reload" hotkey="r" dimColor onPress={() => loadDashboard($, current.server, current.urlPath)}>
            Reload
          </Button>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {topRow}
        {isSidebar ? (
          <Box flexDirection="row" gap={1}>
            {sidebar}
            {main}
          </Box>
        ) : (
          main
        )}
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
  await $.ui.open({ id: PANE, title: 'Dashboard' }).catch(() => undefined)
  void poll($, true)
  // The sidebar: the home's dashboards, read once per home.
  const listed = (await $.state.get(choices)).value ?? null
  if (!listed || !before || before.server !== server) void listDashboards($, server)
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
async function callService($: EngineInterface, server: string, call: ServiceCall): Promise<boolean> {
  lastCall = { server, call }
  const { confirm: _asked, ...args } = call
  void _asked
  const text = await callMcp($, server, 'ha_call_service', args)
  if (text === null) return false
  const ids = targetsOf(call)
  if (ids.length > 0) await readStates($, server, ids)
  return true
}

function targetsOf(call: ServiceCall): string[] {
  const target = call.target?.entity_id
  return Array.isArray(target) ? target : target ? [target] : []
}

/** How an entity looks, to tell that a press changed it: its state and the attributes a press moves. */
function lookOf(live: Live | undefined): string | null {
  if (!live) return null
  const a = live.attributes
  return [live.state, a.brightness, a.temperature, a.current_position, a.percentage].map(v => String(v ?? '')).join('|')
}

/**
 * A press with its outcome shown: sending, then sent once Home Assistant takes the call, then done
 * when the device is seen to change (the state flashes), or "no change seen" if it has not within a
 * few seconds. A slow device or a refused command no longer looks like a press that did nothing.
 */
async function pressAndWatch($: EngineInterface, server: string, key: string, call: ServiceCall) {
  const entity = targetsOf(call)[0] ?? null
  const before = entity ? lookOf(((await $.state.get(states)).value ?? {})[entity]) : null
  const set = async (phase: Pending['phase']) => {
    const now = (await $.state.get(pending)).value ?? {}
    await $.state.set(pending, { ...now, [key]: { phase, at: Date.now(), entity, before } })
  }
  await set('sending')
  const isSent = await callService($, server, call)
  if (!isSent) return set('failed')
  // Already changed by the read straight after the call? Done; else watch for it.
  const after = entity ? lookOf(((await $.state.get(states)).value ?? {})[entity]) : null
  await set(!entity || (after !== null && after !== before) ? 'done' : 'sent')
}

/** Presses waiting on their device: look again, settle them, and clear old outcomes. */
async function watchPresses($: EngineInterface) {
  const now = (await $.state.get(pending)).value ?? {}
  const keys = Object.keys(now)
  if (keys.length === 0) return
  const waiting = keys.filter(key => now[key]!.phase === 'sent')
  const current = (await $.state.get(dash)).value ?? null
  // Look only at the moments set for each press (1, 2.5, 5 and 8 s after it), not every tick.
  const due = waiting.filter(key => {
    const age = Date.now() - now[key]!.at
    return WATCH_AT_MS.some(at => age >= at && age < at + WATCH_EVERY_MS)
  })
  const ids = [...new Set(due.map(key => now[key]!.entity).filter((id): id is string => !!id))]
  if (current && ids.length > 0) await readStates($, current.server, ids)
  const live = (await $.state.get(states)).value ?? {}
  const next: Record<string, Pending> = {}
  for (const key of keys) {
    const p = now[key]!
    const age = Date.now() - p.at
    void age
    if (p.phase === 'sent' && p.entity && lookOf(live[p.entity]) !== p.before) next[key] = { ...p, phase: 'done', at: Date.now() }
    else if (p.phase === 'sent' && age > WATCH_MS) next[key] = { ...p, phase: 'quiet', at: Date.now() }
    else if ((p.phase === 'done' || p.phase === 'quiet' || p.phase === 'failed') && age > OUTCOME_MS) continue
    else next[key] = p
  }
  await $.state.set(pending, next)
  $.ui.invalidate('ui.render')
}

/** States every few seconds for the view on show; templates and history less often. */
async function poll($: EngineInterface, isNow = false) {
  if (isPolling) return
  const current = (await $.state.get(dash)).value ?? null
  if (!current) return
  if ((await $.state.get(blocked)).value && !isNow) return
  if (!isNow && Date.now() < pausedUntil) return
  // Nobody is looking: read nothing. The tab behind another pane, or closed, costs no reads.
  if (!isNow && !(await isShown($))) return
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
  // Every one "not found" at once is the hourly limit talking, not a home with none of them: keep
  // what was last seen, pause the reads, and say so.
  if (rows.length > 2 && rows.every(row => row.found === false)) {
    await pause($)
    return
  }
  const before = (await $.state.get(states)).value ?? {}
  const next = { ...before }
  let isChanged = false
  for (const row of rows) {
    if (typeof row.entity_id !== 'string') continue
    // ha_get_state nests the whole state object under `state`: {entity_id, found, state: {state, attributes}}.
    const held = row.state && typeof row.state === 'object' ? (row.state as Record<string, unknown>) : row
    const value = held.state
    const state = row.found === false ? 'not found' : value === null || value === undefined ? 'unknown' : typeof value === 'object' ? 'unknown' : String(value)
    const attributes = held.attributes && typeof held.attributes === 'object' ? (held.attributes as Record<string, unknown>) : {}
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
      if (/\b429\b|rate.?limit|too many requests|exceeded/i.test(text)) await pause($)
      else await $.state.set(note, firstLine(text) ?? `${tool} failed.`)
      return null
    }
    // A good answer clears an old note, but not the pause's while it lasts.
    if (Date.now() >= pausedUntil && (await $.state.get(note)).value) await $.state.set(note, null)
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

/** Reads refused for the hourly limit: pause them, keep what was last seen, and say so. */
async function pause($: EngineInterface) {
  pausedUntil = Date.now() + BACKOFF_MS
  await $.state.set(
    note,
    "Vome's hourly limit for reading this home's states was reached (500 an hour, shared with Claude's own reads). The pane shows the last states and reads again in five minutes.",
  )
}

async function isShown($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown && pane.isPlaced)
  } catch {
    return true
  }
}

/** Cards into columns as Home Assistant's masonry does: each to the shortest column so far. */
function masonry(cards: Card[], columns: number): Card[][] {
  const out: Card[][] = Array.from({ length: columns }, () => [])
  const heights = new Array<number>(columns).fill(0)
  for (const card of cards) {
    if (card.isForeign && card.rows.length === 0 && card.children.length === 0 && !card.title) continue
    const shortest = heights.indexOf(Math.min(...heights))
    out[shortest]!.push(card)
    heights[shortest]! += heightOf(card)
  }
  return out.filter(column => column.length > 0)
}

function heightOf(card: Card): number {
  const own = 2 + (card.title ? 1 : 0) + (card.markdown !== null ? Math.ceil(card.markdown.length / 50) + 1 : 0) + card.rows.length * (card.hours !== null ? 4 : 1)
  return own + card.children.reduce((sum, child) => sum + heightOf(child), 0)
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
