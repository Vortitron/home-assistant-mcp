// A side pane for the Home Assistant automation being worked on over Vome.
//
// It follows the model's own vome MCP calls (reading, saving and tracing an
// automation) and draws the automation as Home Assistant's editor nests it:
// triggers, conditions, actions. After a save it marks what changed and
// watches for the next run, then marks which steps that run took and where it
// stopped. Its own calls to Home Assistant are reads only; it never writes to
// a home. On the terminal a dot-matrix interstitial acts out what just
// happened (a light switched, a save, a run that stopped); b turns it off.

import type { ElementTable, EngineInterface, Register } from 'claude-code'

import type { AutomationConfig, AutomationView, Flash, Interstitial, Lamp, Pending, RunView, Watch } from '../types'
import { frame, FX_ROWS, SCENE_MS, swim, SWIM_ROWS } from './bulbs'
import { buildRows, compact, countChanges, describePath, isObj, parseReply, parseRun, parseStamp } from './flow'
import type { Row, Tone } from './flow'

const PANE = 'vome-automation'
/** The server `/automation <id>` reads from before anything has been seen: the portal's name for it. */
const DEFAULT_SERVER = 'vome'
/** The tools of ours the pane follows, whatever the server is called. */
const FOLLOWED = new Set(['ha_get_automation', 'ha_set_automation', 'ha_get_trace', 'ha_trigger_automation', 'ha_call_service'])

/**
 * How long the pane watches for runs after an automation is read, refreshed or saved. Watching
 * was opt-in (w), and nobody found the key, so runs never appeared; now it is the default.
 */
const WATCH_AFTER_SAVE_MS = 30 * 60_000
/** How long a manual trigger keeps it watching. */
const WATCH_AFTER_TRIGGER_MS = 2 * 60_000
const POLL_RUNS_MS = 15_000
const TICK_MS = 3_000
/** The swim stops this long after the last call about the automation, even mid-turn. */
const BUILD_IDLE_MS = 90_000
/** The interstitial's frame interval: 25 a second. */
const FRAME_MS = 40
/** A lit row fades in three steps over three seconds. */
const FLASH_STEP_MS = 1_000
const FLASH_COLOURS: Record<Flash['kind'], string[]> = {
  change: ['#806000', '#4d3a00', '#261d00'],
  run: ['#006b3c', '#00402a', '#002015'],
}

const view = { plugin: 'vome-automation', key: 'view' } as const
const run = { plugin: 'vome-automation', key: 'run' } as const
const watch = { plugin: 'vome-automation', key: 'watch' } as const
const pending = { plugin: 'vome-automation', key: 'pending' } as const
const note = { plugin: 'vome-automation', key: 'note' } as const
const known = { plugin: 'vome-automation', key: 'known' } as const
const haUrls = { plugin: 'vome-automation', key: 'haUrls' } as const
const flash = { plugin: 'vome-automation', key: 'flash' } as const
const fxOn = { plugin: 'vome-automation', key: 'fxOn' } as const
const fx = { plugin: 'vome-automation', key: 'fx' } as const
const building = { plugin: 'vome-automation', key: 'building' } as const
const blocked = { plugin: 'vome-automation', key: 'blocked' } as const
const servers = { plugin: 'vome-automation', key: 'servers' } as const

/** Where someone with no Home Assistant connected yet goes next. */
const VOME_TOKENS_URL = 'https://vome.io/account/api-tokens'
const OWN_HA_URL = 'https://github.com/Vortitron/home-assistant-mcp#install'
/** Opens the person's own Home Assistant and adds the Vome app's repository (the portal's link too). */
const ADD_APP_URL =
  'https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FVortitron%2FVomeSync'
const CONNECT_COMMAND = '/plugin install vome-connect --marketplace Vortitron/home-assistant-mcp'
const CONNECT_README_URL = 'https://github.com/Vortitron/home-assistant-mcp/tree/main/claude-plugin/vome-connect'

/** The pane's background reads; in auto mode each needs an allow rule (README: "Allow the pane's reads"). */
const READ_TOOLS = ['ha_get_automation', 'ha_get_trace', 'ha_list_traces', 'vomehome_get_instance']
const README_URL = 'https://github.com/Vortitron/home-assistant-mcp/tree/main/claude-plugin/vome-automation#allow-the-panes-reads-auto-mode'

// Module variables reset on a reload, which is all these need.
let isBusy = false
let lastPoll = 0
let hasToldNarrow = false
let lastLogged = ''
let isBlocked = false
/** Whether a server with our tools has been seen; once it has, the check stops. */
let hasSeenServer = false
/** The note line holds an error, which the next read that works should take away. */
let isNoteAnError = false
/** When the automation was last read or acted on; the swim ends BUILD_IDLE_MS after. */
let buildingSince = 0
/** Where this person's Claude Code settings live, for the link when auto mode refuses a read. */
let settingsFile = '~/.claude/settings.json'
// The animation's own bookkeeping: what plays, where it is mounted, the fade.
let fxAt = 0
let fxScene: Interstitial | null = null
// Where the strip is mounted, and when nothing else plays, the swim it shows.
let fxSite: { columns: number; isSwim: boolean } | null = null
let isFxOn = true
let isBlitting = false
let flashAt = 0
let lastFlashStep = 0

type Stamp = { instance: string | null; home: string | null }
type Reply = { body: ReturnType<typeof parseReply>; stamp: Stamp; isError: boolean; text: string }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'automation',
      description: 'Show a Home Assistant automation (via Vome) in a side pane',
      argumentHint: '[automation id or entity_id]',
    })
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? '~'}/.claude`
    settingsFile = `${configDir.replace(/\/+$/, '')}/settings.json`
    $.clock.every(TICK_MS, () => void tick($))
    isFxOn = (await $.store.get('fxOn')) !== false
    // State outlives a reload, so a HooksError an older version wrote would sit in the note
    // line forever: start clean, and let the next read say again if something is wrong.
    await $.state.set(note, null)
    await $.state.set(blocked, null)
    await $.state.set(building, false)
    await $.state.set(fxOn, isFxOn)
    $.clock.every(FRAME_MS, () => void animate($))

    return next(e)
  })

  on('command.run', { command: 'automation' }, async ($, e) => {
    const wanted = e.args.trim()
    if (wanted) await $.state.set(pending, { automation: wanted, run: true })
    const opened = await $.ui.open({ id: PANE, title: 'Automation' })
    const current = (await $.state.get(view)).value ?? null
    // Say plainly when this surface will not draw the pane, rather than look like it did.
    // A session with no surface attached reports every pane placed, so name the surfaces too.
    const surfaces = await $.session.surfaces()
    const drawnOn = surfaces.length > 0 ? `drawing on ${surfaces.join(', ')}` : 'no surface is attached to draw it'
    const placement = opened.isPlaced ? ` (pane placed; ${drawnOn})` : ` The pane is not drawn here: ${opened.reason} (${drawnOn}).`

    if (wanted) return { text: `Fetching ${wanted} into the automation pane.${placement}` }
    if (current) return { text: `The automation pane shows "${current.alias}".${placement}` }
    return {
      text: `The automation pane fills when an automation is read or saved through the Home Assistant MCP, or with /automation <id>.${placement}`,
    }
  })

  // Our MCP's tools, on whatever its server is called: `vome` from the portal, `home-assistant`
  // from the README, a relay's own name. Tool matchers must be literals, so match here instead.
  on('tool.call', async ($, e, next) => {
    const ours = ourTool(e.tool)
    if (!ours) return next(e)
    const { server, name } = ours
    const args = e as unknown as Record<string, unknown>

    // The model saved one: diff it against what came before, then watch for its next run.
    if (name === 'ha_set_automation') {
      const id = typeof args.automation_id === 'string' ? args.automation_id : null
      const config = isObj(args.config as never) ? (args.config as AutomationConfig) : null
      if (!id || !config) return next(e)

      const before = await baseline($, server, id)
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError) {
        await $.state.set(note, `Save of ${id} failed: ${compact(stripStamp(ran.text ?? ran.deny ?? ''), 160)}`)
        return ran
      }

      const stamp = parseStamp(ran.text ?? '')
      const sameHome = before !== null && (before.instance === null || before.instance === stamp.instance)
      const prev = sameHome ? before.config : {}
      await show($, server, id, config, stamp, { prev })
      await $.state.set(building, false)
      buildingSince = 0
      await $.state.set(run, null)
      const changed = buildRows(config, null, prev).filter(row => row.change !== null)
      await startFlash($, changed.map(row => row.path), 'change')
      await play($, { kind: 'saved', caption: `saved · ${changed.length} line${changed.length === 1 ? '' : 's'} changed` })
      await $.state.set(watch, { id, instance: stamp.instance, since: new Date().toISOString(), until: Date.now() + WATCH_AFTER_SAVE_MS })
      lastPoll = 0
      await openPane($)

      return ran
    }

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const text = ran.text ?? ''
    if (buildingSince > 0) buildingSince = Date.now()

    if (name === 'ha_get_automation') {
      // The model read an automation: show it, and swim while it is worked on.
      const body = parseReply(text)
      if (body && isObj(body.config)) {
        const id = typeof body.id === 'string' ? body.id : String(body.config.id ?? '')
        if (id) {
          await show($, server, id, body.config, parseStamp(text), null)
          await $.state.set(pending, { run: true })
          await $.state.set(building, true)
          buildingSince = Date.now()
          await openPane($)
        }
      }
    } else if (name === 'ha_get_trace') {
      // The model fetched a run of the automation on show: draw it too.
      const current = (await $.state.get(view)).value ?? null
      const body = parseReply(text)
      if (current && body && current.server === server && body.item_id === current.id && isSameHome(current.instance, parseStamp(text).instance)) {
        const parsed = parseRun(body)
        if (parsed) await $.state.set(run, parsed)
      }
    } else if (name === 'ha_trigger_automation') {
      // The model ran it by hand: watch briefly for that run.
      const current = (await $.state.get(view)).value ?? null
      if (current && current.server === server) {
        const existing = (await $.state.get(watch)).value ?? null
        await $.state.set(watch, {
          id: current.id,
          instance: current.instance,
          since: new Date(Date.now() - 2_000).toISOString(),
          until: Math.max(existing?.until ?? 0, Date.now() + WATCH_AFTER_TRIGGER_MS),
        })
        lastPoll = 0
      }
    } else if (name === 'ha_call_service') {
      // The model switched a device by hand: act it out.
      const domain = typeof args.domain === 'string' ? args.domain : ''
      const isOn = SWITCHED[typeof args.service === 'string' ? args.service : '']
      const target = (args.target ?? {}) as { entity_id?: unknown }
      const data = (args.data ?? {}) as { entity_id?: unknown }
      if (DEVICE_DOMAINS.has(domain) && isOn !== undefined) {
        const lamps = entityIds(target.entity_id ?? data.entity_id).map(id => ({ label: friendly(id), isOn, domain }))
        if (lamps.length > 0) await play($, { kind: 'switch', lamps })
      }
    }

    return ran
  })

  // The turn is over: whatever was being built is done (or set aside), so the swimmers rest.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    buildingSince = 0
    if ((await $.state.get(building)).value) await $.state.set(building, false)

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Code, Markdown } = $.ui.resolve(e)
    const current = (await $.state.get(view)).value ?? null
    const latest = (await $.state.get(run)).value ?? null
    const watching = (await $.state.get(watch)).value ?? null
    const message = (await $.state.get(note)).value ?? null
    const urls = (await $.state.get(haUrls)).value ?? {}
    const lit = (await $.state.get(flash)).value ?? null
    const isFxEnabled = (await $.state.get(fxOn)).value ?? true
    const playing = (await $.state.get(fx)).value ?? null
    const isBuilding = (await $.state.get(building)).value ?? false
    const refusal = (await $.state.get(blocked)).value ?? null

    // A refused read takes the whole pane until dismissed: what to add and where, over everything,
    // rather than a HooksError in the note line that names neither.
    if (refusal && !refusal.isDismissed) {
      fxSite = null
      const rules = READ_TOOLS.map(tool => `"mcp__${refusal.server}__${tool}"`).join(',\n')
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
          <Text bold color="warning">
            The automation pane needs permission to read
          </Text>
          <Text wrap="wrap">
            Auto mode refused its background read of {refusal.tool} on the {refusal.server} server. Claude Code refuses
            reads nobody asked for unless they are allowed by name.
          </Text>
          <Box marginTop={1}>
            <Text wrap="wrap">Add these lines to permissions.allow in</Text>
          </Box>
          <Markdown text={`[${settingsFile}](file://${settingsFile})`} />
          <Code source={rules} />
          <Text dimColor wrap="wrap">
            Or run /permissions and choose Allow for each. They only read: an automation and its recorded runs.
          </Text>
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              Claude Code said: {compact(refusal.error, 300)}
            </Text>
          </Box>
          <Box flexDirection="row" gap={2} marginTop={1}>
            <Button
              key="copy-rules"
              hotkey="c"
              variant="primary"
              autoFocus
              onPress={press => $.ui.copy({ text: rules, surface: press.surface })}
            >
              Copy the lines
            </Button>
            <Button
              key="retry"
              hotkey="r"
              onPress={async () => {
                isBlocked = false
                await $.state.set(blocked, null)
                await $.state.set(note, null)
                await $.state.set(pending, { run: true })
              }}
            >
              Try again
            </Button>
            <Button key="dismiss" hotkey="d" role="dismiss" onPress={() => $.state.set(blocked, { ...refusal, isDismissed: true })}>
              Dismiss
            </Button>
          </Box>
          <Link href={README_URL}>Why the pane needs these</Link>
        </Box>
      )
    }
    // Dismissed: the pane as usual, its note line saying how to get the help back.
    const showHelp = refusal ? (
      <Button key="help" hotkey="h" dimColor onPress={() => $.state.set(blocked, { ...refusal, isDismissed: false })}>
        What to allow
      </Button>
    ) : null

    // While an interstitial plays it takes the header's first four lines; the swim (the intro, or
    // while an automation is worked on) takes all six. Same heights, so nothing below moves.
    // Both are Rasters, which only the terminal draws; elsewhere the pane goes without.
    const isSwimming = !current || isBuilding
    let sceneStrip = null
    let swimStrip = null
    if (e.surface === 'terminal' && isFxEnabled && (playing || isSwimming)) {
      const { Raster } = $.ui.resolve(e)
      const columns = Math.max(10, Math.min(512, e.props.bodyColumns))
      fxSite = { columns, isSwim: !playing }
      if (playing) {
        sceneStrip = <Raster key="bulbs" columns={columns} rows={FX_ROWS} cells={frame(Date.now() - playing.at, playing.scene, columns)} />
      } else {
        swimStrip = <Raster key="bulbs" columns={columns} rows={SWIM_ROWS} cells={swim(Date.now(), columns)} />
      }
    } else {
      fxSite = null
    }

    const connected = (await $.state.get(servers)).value ?? null
    if (!current && connected !== null && connected.length === 0) {
      return (
        <Box flexDirection="column">
          {swimStrip ?? sceneStrip}
          <Text bold>Connect Home Assistant first</Text>
          <Text wrap="wrap">
            This pane follows Claude's work through the Home Assistant MCP (@vortitron/home-assistant-mcp), and nothing
            connected in this session has its tools.
          </Text>
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Through Vome: one key, nothing to run</Text>
            <Text wrap="wrap">
              1. Get a key. Home Assistant on your own hardware: the Vome app's Agent tab, no sign-up needed. A home on
              Vome: vome.io, Account → API tokens.
            </Text>
            <Link href={ADD_APP_URL}>Add the Vome app to Home Assistant</Link>
            <Text wrap="wrap">2. Run this; it asks for the key:</Text>
            <Code source={CONNECT_COMMAND} />
            <Box flexDirection="row" gap={2}>
              <Button key="copy-connect" hotkey="c" onPress={press => $.ui.copy({ text: CONNECT_COMMAND, surface: press.surface })}>
                Copy the command
              </Button>
              <Link href={VOME_TOKENS_URL}>vome.io → API tokens</Link>
              <Link href={CONNECT_README_URL}>About vome-connect</Link>
            </Box>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Without Vome</Text>
            <Text wrap="wrap">Run the same MCP on your machine with npx, pointed at your Home Assistant and a token.</Text>
            <Link href={OWN_HA_URL}>How to set it up</Link>
          </Box>
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              Then run /reload-plugins. Once it's connected (check with /mcp) this goes by itself; ask Claude about an
              automation to fill the pane.
            </Text>
          </Box>
        </Box>
      )
    }

    if (!current) {
      return (
        <Box flexDirection="column">
          {swimStrip ?? sceneStrip}
          <Text dimColor>No automation yet. It appears here when one is read or saved through Vome, or with /automation &lt;id&gt;.</Text>
          {message ? <Text color="warning">{message}</Text> : null}
          {showHelp}
        </Box>
      )
    }

    const isRunBeforeSave = latest !== null && current.savedAt !== null && toMs(latest.started) < toMs(current.savedAt)
    const rows = buildRows(current.config, isRunBeforeSave ? null : latest, current.prev)
    const changes = countChanges(rows)
    const mode = typeof current.config.mode === 'string' ? current.config.mode : 'single'
    const url = current.instance ? urls[current.instance] : undefined
    const outcome = latest ? describeRun(latest) : null
    const step = lit ? Math.floor((Date.now() - lit.at) / FLASH_STEP_MS) : -1
    const litColour = lit ? FLASH_COLOURS[lit.kind][step] : undefined
    const litPaths = new Set(litColour && lit ? lit.paths : [])

    return (
      <Box flexDirection="column">
        {/* Six header lines, always there, so a change rewrites a line instead of moving the tree.
            The swim takes all six while it plays; an interstitial the first four. */}
        {swimStrip ?? (
          <Box flexDirection="column">
            {sceneStrip ?? (
              <Box flexDirection="column">
                <Text bold wrap="truncate-end">{current.alias}</Text>
                <Text dimColor wrap="truncate-end">
                  {[current.id, mode, current.home].filter(Boolean).join(' · ')}
                </Text>

                {current.savedAt ? (
                  <Text color="warning" wrap="truncate-end">
                    Saved {clock(current.savedAt)}
                    {current.prev ? ` · ${changes.added} added, ${changes.changed} changed, ${changes.removed} removed` : ''}
                  </Text>
                ) : (
                  <Text dimColor>Not changed this session.</Text>
                )}

                {latest && outcome ? (
                  <Text wrap="truncate-end">
                    <Text color={toneColour(isRunBeforeSave ? 'skipped' : outcome.tone)}>
                      Last run {clock(latest.started)} · {outcome.text}
                    </Text>
                    {latest.trigger ? <Text dimColor> · {latest.trigger}</Text> : null}
                    {isRunBeforeSave ? <Text dimColor> (before the save, so not marked below)</Text> : null}
                  </Text>
                ) : (
                  <Text dimColor>No run shown yet.</Text>
                )}
              </Box>
            )}

            <Text dimColor wrap="truncate-end">
              {watching ? `Watching for a new run until ${clock(new Date(watching.until).toISOString())}.` : 'Not watching for runs.'}
            </Text>
            <Text color="warning" wrap="truncate-end">
              {message ?? ' '}
            </Text>
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          {rows.map(row => drawRow(Text, row, litPaths.has(row.path) ? litColour : undefined))}
        </Box>

        <Box flexDirection="row" gap={2} marginTop={1}>
          <Button key="refresh" hotkey="r" onPress={() => $.state.set(pending, { automation: current.id, run: true })}>
            Refresh
          </Button>
          <Button
            key="watch"
            hotkey="w"
            onPress={() =>
              $.state.set(
                watch,
                watching
                  ? null
                  : {
                      id: current.id,
                      instance: current.instance,
                      since: new Date().toISOString(),
                      until: Date.now() + WATCH_AFTER_SAVE_MS,
                    },
              )
            }
          >
            {watching ? 'Stop watching' : 'Watch for runs'}
          </Button>
          {showHelp}
          <Button
            key="bulbs"
            hotkey="b"
            dimColor
            onPress={async () => {
              const isOn = !isFxEnabled
              isFxOn = isOn
              if (!isOn) fxSite = null
              await $.store.set('fxOn', isOn)
              await $.state.set(fxOn, isOn)
            }}
          >
            {isFxEnabled ? 'Bulbs off' : 'Bulbs on'}
          </Button>
          {url ? <Link href={`${url}/config/automation/edit/${encodeURIComponent(current.id)}`}>Open in Home Assistant</Link> : null}
        </Box>
        <Text dimColor>● ran  ✗ false or error  ○ not reached  + added  ~ changed  − removed</Text>
      </Box>
    )
  })
}

// ---------------------------------------------------------------- drawing

function drawRow(T: ElementTable['Text'], row: Row, highlight: string | undefined) {
  if (row.isSection) {
    return (
      <T bold color="suggestion">
        {row.text.toUpperCase()}
      </T>
    )
  }
  const isStruck = row.change === '-' || row.tone === 'disabled'
  return (
    <T wrap="truncate-end" backgroundColor={highlight}>
      <T color={changeColour(row.change)}>{row.change === '-' ? '−' : row.change ?? ' '}</T>
      {'  '.repeat(row.depth)}
      <T color={toneColour(row.tone)}>{toneGlyph(row.tone)} </T>
      <T dimColor={row.tone === 'skipped' || row.tone === 'disabled'} strikethrough={isStruck}>
        {row.text}
      </T>
      {row.note ? <T dimColor>{`  ${row.note}`}</T> : null}
    </T>
  )
}

function toneGlyph(tone: Tone): string {
  return { plain: '·', ran: '●', false: '✗', error: '✗', skipped: '○', disabled: '⊘' }[tone]
}

function toneColour(tone: Tone): string | undefined {
  return { plain: undefined, ran: 'success', false: 'warning', error: 'error', skipped: undefined, disabled: undefined }[tone]
}

function changeColour(change: Row['change']): string | undefined {
  return change === '+' ? 'success' : change === '~' ? 'warning' : change === '-' ? 'error' : undefined
}

function describeRun(r: RunView): { text: string; tone: Tone } {
  if (r.error || (r.failedAt && /error/.test(r.failedAt.reason))) {
    const where = r.failedAt ? ` at ${describePath(r.failedAt.path)}` : ''
    return { text: `error${where}${r.error ? `: ${r.error}` : ''}`, tone: 'error' }
  }
  if (r.failedAt) return { text: `stopped: ${describePath(r.failedAt.path)} was false`, tone: 'false' }
  return { text: r.execution ?? r.state ?? 'ran', tone: 'ran' }
}

/** What a run acts out: the lights it switched, else how it stopped, else that it ran. */
function sceneForRun(r: RunView): Interstitial {
  const outcome = describeRun(r)
  if (outcome.tone === 'error') return { kind: 'error', caption: outcome.text }
  if (outcome.tone === 'false') return { kind: 'stopped', caption: outcome.text }
  const lamps: Lamp[] = []
  let firstService: string | null = null
  for (const step of r.steps) {
    const params = serviceParams(step.result)
    if (!params) continue
    firstService ??= `${params.domain}.${params.service}`
    const isOn = SWITCHED[params.service]
    if (!DEVICE_DOMAINS.has(params.domain) || isOn === undefined) continue
    for (const id of params.entities) lamps.push({ label: friendly(id), isOn, domain: params.domain })
  }
  if (lamps.length > 0) return { kind: 'switch', lamps }
  return { kind: 'ran', caption: `ran · ${firstService ?? outcome.text}` }
}

/** The domains a run or call acts out as a device switching. */
const DEVICE_DOMAINS = new Set(['light', 'switch', 'input_boolean', 'fan', 'cover', 'climate', 'water_heater', 'lock', 'media_player'])
/** Which way a service sends a device ("on" is open for a cover, locked for a lock); a toggle shows as on. */
const SWITCHED: Record<string, boolean> = {
  turn_on: true,
  turn_off: false,
  toggle: true,
  open_cover: true,
  close_cover: false,
  lock: true,
  unlock: false,
  media_play: true,
  media_pause: false,
  media_stop: false,
}

/** A trace step's service call, from its result: `{"params":{"domain","service","target":{...}}}`. */
function serviceParams(result: string | undefined): { domain: string; service: string; entities: string[] } | null {
  if (!result) return null
  try {
    const parsed = JSON.parse(result) as { params?: { domain?: unknown; service?: unknown; target?: { entity_id?: unknown }; service_data?: { entity_id?: unknown } } }
    const params = parsed.params
    if (!params || typeof params.domain !== 'string' || typeof params.service !== 'string') return null
    return { domain: params.domain, service: params.service, entities: entityIds(params.target?.entity_id ?? params.service_data?.entity_id) }
  } catch {
    return null
  }
}

function entityIds(value: unknown): string[] {
  const all = Array.isArray(value) ? value : [value]
  return all.filter((id): id is string => typeof id === 'string' && id.includes('.'))
}

/** `light.living_room` → "living room". */
function friendly(entityId: string): string {
  return (entityId.split('.')[1] ?? entityId).replace(/_/g, ' ')
}

// ---------------------------------------------------------------- state

async function show(
  $: EngineInterface,
  server: string,
  id: string,
  config: AutomationConfig,
  stamp: Stamp,
  saved: { prev: AutomationConfig } | null,
) {
  const all = (await $.state.get(known)).value ?? {}
  await $.state.set(known, { ...all, [id]: { instance: stamp.instance, config } })
  const current = (await $.state.get(view)).value ?? null
  const alias = typeof config.alias === 'string' ? config.alias : id
  // Re-reading what was just saved keeps the diff rather than wiping it.
  const isSameSave =
    !saved &&
    current !== null &&
    current.server === server &&
    current.id === id &&
    current.instance === stamp.instance &&
    JSON.stringify(current.config) === JSON.stringify(config)
  const next: AutomationView = isSameSave
    ? { ...current, alias, home: stamp.home ?? current.home }
    : {
        server,
        id,
        alias,
        config,
        prev: saved ? saved.prev : null,
        savedAt: saved ? new Date().toISOString() : null,
        instance: stamp.instance,
        home: stamp.home,
      }
  await $.state.set(view, next)
  await $.state.set(note, null)

  // Watch for its runs by default: a fresh watch for a new automation, a longer one for the same.
  const watching = (await $.state.get(watch)).value ?? null
  const isSameWatch = watching !== null && watching.id === id && watching.instance === stamp.instance
  await $.state.set(watch, {
    id,
    instance: stamp.instance,
    since: isSameWatch ? watching.since : new Date().toISOString(),
    until: Date.now() + WATCH_AFTER_SAVE_MS,
  })
  lastPoll = 0
}

/** The config a save replaces: the last one seen, else read live before the save lands. */
async function baseline($: EngineInterface, server: string, id: string): Promise<{ instance: string | null; config: AutomationConfig } | null> {
  const seen = ((await $.state.get(known)).value ?? {})[id]
  if (seen) return seen
  const reply = await callVome($, server, 'ha_get_automation', { automation: id })
  if (reply.body && isObj(reply.body.config)) return { instance: reply.stamp.instance, config: reply.body.config }
  // Not found: a new automation, so everything in it is added.
  return reply.isError ? { instance: reply.stamp.instance, config: {} } : null
}

async function openPane($: EngineInterface) {
  // The view is already in state; a surface that cannot open panes must not lose it.
  const opened = await $.ui.open({ id: PANE, title: 'Automation' }).catch((error: unknown) => ({
    isPlaced: false as const,
    reason: String(error),
  }))
  if (!opened.isPlaced && !hasToldNarrow) {
    hasToldNarrow = true
    $.ui.log(`vome-automation: the pane is not drawn here (${opened.reason}); /automation tries again.`)
  }
}

// ---------------------------------------------------------------- animation

async function play($: EngineInterface, scene: Interstitial) {
  fxAt = Date.now()
  fxScene = scene
  await $.state.set(fx, { at: fxAt, scene })
}

async function startFlash($: EngineInterface, paths: string[], kind: Flash['kind']) {
  flashAt = Date.now()
  lastFlashStep = 0
  await $.state.set(flash, { at: flashAt, paths, kind })
}

/** Every frame: step the highlight's fade, and repaint the bulbs where the strip is mounted. */
async function animate($: EngineInterface) {
  const now = Date.now()
  // A long turn about something else should not leave the swimmers over the header.
  if (buildingSince > 0 && now - buildingSince > BUILD_IDLE_MS) {
    buildingSince = 0
    await $.state.set(building, false)
  }
  if (flashAt > 0) {
    const step = Math.floor((now - flashAt) / FLASH_STEP_MS)
    if (step >= FLASH_COLOURS.change.length) {
      flashAt = 0
      await $.state.set(flash, null)
    } else if (step !== lastFlashStep) {
      lastFlashStep = step
      $.ui.invalidate('ui.render')
    }
  }
  if (fxAt > 0 && now - fxAt > SCENE_MS) {
    fxAt = 0
    fxScene = null
    fxSite = null
    await $.state.set(fx, null)
  }

  if (!isFxOn || !fxSite || isBlitting) return
  const cells = fxScene ? frame(now - fxAt, fxScene, fxSite.columns) : fxSite.isSwim ? swim(now, fxSite.columns) : null
  if (!cells) return
  isBlitting = true
  try {
    const result = await $.ui.blit({ requestId: PANE, key: 'bulbs', cells })
    // Not mounted (the pane closed, or redrawn at another size): wait for the next drawing.
    if (result.deny !== undefined) fxSite = null
  } finally {
    isBlitting = false
  }
}

// ---------------------------------------------------------------- polling

/**
 * Which connected MCP servers carry our tools. Someone who installs the pane before connecting
 * Home Assistant otherwise sees a pane that waits forever for an automation; with none, it tells
 * them how to connect instead. Servers connect after the session starts, so this runs each tick
 * until one is seen.
 */
async function lookForServers($: EngineInterface) {
  const names = (await $.tool.list())
    .map(tool => ourTool(tool.name))
    .filter((found): found is { server: string; name: string } => found !== null && found.name === 'ha_get_automation')
    .map(found => found.server)
  hasSeenServer = names.length > 0
  const before = (await $.state.get(servers)).value
  if (!before || before.join() !== names.join()) await $.state.set(servers, names)
}

async function tick($: EngineInterface) {
  if (isBusy) return
  isBusy = true
  try {
    // Its own failure must not stop the reads below it: worst case, the connect screen waits.
    if (!hasSeenServer) await lookForServers($).catch(() => undefined)
    const want = (await $.state.get(pending)).value ?? null
    if (want) {
      await $.state.set(pending, null)
      await fetchPending($, want)
    }

    const watching = (await $.state.get(watch)).value ?? null
    if (watching) {
      if (Date.now() > watching.until) await $.state.set(watch, null)
      else if (Date.now() - lastPoll >= POLL_RUNS_MS) {
        lastPoll = Date.now()
        await pollRuns($, watching)
      }
    }

    await lookUpHaUrl($)
  } catch (error) {
    // Already shown, with what to do about it, by callVome.
    if (error instanceof RefusedRead) return
    const text = `Vome: ${String(error)}`
    // Once per distinct failure in full to the transcript; the pane keeps a short form.
    if (text !== lastLogged) {
      lastLogged = text
      $.ui.log(text)
    }
    isNoteAnError = true
    await $.state.set(note, compact(text, 400))
  } finally {
    isBusy = false
  }
}

async function fetchPending($: EngineInterface, want: Pending) {
  if (want.automation) {
    const server = want.server ?? ((await $.state.get(view)).value ?? null)?.server ?? DEFAULT_SERVER
    const reply = await callVome($, server, 'ha_get_automation', { automation: want.automation })
    if (!reply.body || !isObj(reply.body.config)) {
      await $.state.set(note, `Couldn't read ${want.automation}: ${compact(stripStamp(reply.text), 160)}`)
      return
    }
    const id = typeof reply.body.id === 'string' ? reply.body.id : want.automation
    await show($, server, id, reply.body.config, reply.stamp, null)
    await openPane($)
  }

  if (want.run) {
    const current = (await $.state.get(view)).value ?? null
    if (!current) return
    const reply = await callVome($, current.server, 'ha_get_trace', { item: current.id })
    if (!isSameHome(current.instance, reply.stamp.instance)) {
      await $.state.set(note, 'Vome now points at a different home than this automation came from.')
      return
    }
    const parsed = reply.body ? parseRun(reply.body) : null
    await $.state.set(run, parsed)
    if (!parsed) await $.state.set(note, `No run to show: ${compact(stripStamp(reply.text), 140)}`)
  }
}

async function pollRuns($: EngineInterface, watching: Watch) {
  const current = (await $.state.get(view)).value ?? null
  if (!current || current.id !== watching.id) {
    await $.state.set(watch, null)
    return
  }

  const reply = await callVome($, current.server, 'ha_list_traces', { item: watching.id, limit: 1 })
  if (!isSameHome(watching.instance, reply.stamp.instance)) {
    await $.state.set(watch, null)
    await $.state.set(note, 'Vome now points at a different home; stopped watching.')
    return
  }
  const newest = reply.body && Array.isArray(reply.body.traces) ? reply.body.traces.find(isObj) : undefined
  if (!newest || typeof newest.run_id !== 'string' || typeof newest.started !== 'string') return
  if (toMs(newest.started) < toMs(watching.since)) return
  if (((await $.state.get(run)).value ?? null)?.runId === newest.run_id) return

  const detail = await callVome($, current.server, 'ha_get_trace', { item: watching.id, run_id: newest.run_id })
  const parsed = detail.body ? parseRun(detail.body) : null
  if (!parsed) return
  await $.state.set(run, parsed)
  const outcome = describeRun(parsed)
  const touched = buildRows(current.config, parsed, null).filter(
    row => !row.isSection && (row.tone === 'ran' || row.tone === 'false' || row.tone === 'error'),
  )
  await startFlash($, touched.map(row => row.path), 'run')
  await play($, sceneForRun(parsed))
  $.ui.toast(`${current.alias}: ${outcome.text}`)
}

async function lookUpHaUrl($: EngineInterface) {
  const current = (await $.state.get(view)).value ?? null
  const instance = current?.instance
  if (!instance || ((await $.state.get(haUrls)).value ?? {})[instance] !== undefined) return
  // Only a server linked to Vome has this tool; any other answers no link, quietly.
  const reply = await callVome($, current.server, 'vomehome_get_instance', { instance_id: instance }).catch(() => null)
  const url = reply?.body && typeof reply.body.ha_url === 'string' ? reply.body.ha_url : ''
  const all = (await $.state.get(haUrls)).value ?? {}
  await $.state.set(haUrls, { ...all, [instance]: url.startsWith('https://') ? url.replace(/\/+$/, '') : '' })
}

/** A background read auto mode refused; the pane already shows what to allow. */
class RefusedRead extends Error {}

async function callVome($: EngineInterface, server: string, tool: string, args: Record<string, unknown>): Promise<Reply> {
  let result
  try {
    result = await $.mcp.call(server, tool, args)
  } catch (error) {
    // Auto mode refuses a background read nobody asked for unless it is allowed by name. Say so
    // where it shows, with the exact lines for this server, rather than as a raw HooksError. Its
    // wording differs between builds, so only "auto mode" is relied on; server and tool are ours.
    if (/auto mode|classifier|permission|denied|not allowed/i.test(String(error))) {
      isBlocked = true
      await $.state.set(blocked, { server, tool, error: String(error), isDismissed: false })
      await $.state.set(note, `A read of ${tool} was refused: press h for what to allow.`)
      throw new RefusedRead(tool)
    }
    throw new Error(`${tool}: ${String(error)}`)
  }
  if (isBlocked || isNoteAnError) {
    isBlocked = false
    isNoteAnError = false
    await $.state.set(blocked, null)
    await $.state.set(note, null)
  }
  const text = result.content.map(block => block.text ?? '').join('\n')
  return { body: result.isError ? null : parseReply(text), stamp: parseStamp(text), isError: result.isError, text }
}

// ---------------------------------------------------------------- small things

/** `mcp__<server>__<tool>` for a tool the pane follows, as its server and name; else null. */
function ourTool(tool: string): { server: string; name: string } | null {
  const match = /^mcp__(.+)__([a-z_]+)$/.exec(tool)
  return match && match[1] && match[2] && FOLLOWED.has(match[2]) ? { server: match[1], name: match[2] } : null
}

function isSameHome(expected: string | null, actual: string | null): boolean {
  return expected === null || actual === null || expected === actual
}

function stripStamp(text: string): string {
  return text.replace(/\[vome-instance\][^\n]*/g, '').trim()
}

/** HA writes microseconds; keep milliseconds so every engine parses it. */
function toMs(iso: string): number {
  return Date.parse(iso.replace(/(\.\d{3})\d+/, '$1')) || 0
}

function clock(iso: string): string {
  const at = new Date(toMs(iso))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}
