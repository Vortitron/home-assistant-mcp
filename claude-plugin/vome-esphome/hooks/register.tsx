// A side pane for the ESPHome build Claude is running.
//
// A compile or a flash takes minutes and its tool returns all of its output
// only at the end, so there was nothing to watch while it ran. This pane opens
// when Claude starts one, reads the build's output as it arrives (the MCP's
// esphome_activity, read-only), and shows the phase, a progress bar where the
// output gives one, the latest lines with errors picked out, and the result.
// With an MCP that predates esphome_activity it still shows the elapsed time
// and then the output once the build returns. It never runs a build itself.
//
// Under the build it draws a map of the device from its YAML (board, network,
// buses, entities, pins, triggers), whenever Claude reads or writes a config or
// builds one, with what a save changed lit for a few seconds. The build log is
// two lines by default; l shows all of it.

import type { EngineInterface, Register } from 'claude-code'

import type { Build, ConfigView, Device } from '../types'
import { bar, elapsed, kindOf, phaseWords, progressOf, toLines } from './build'
import { chipFrame, STRIP_ROWS } from './chip'
import type { ChipState, Scene, Thing } from './chip'
import { diffMaps, mapDevice, rowKey } from './config'
import type { MapRow } from './config'
import type { LineKind } from './build'

const PANE = 'vome-esphome'
const POLL_MS = 1500
const KEEP_LINES = 300
const BUILD_COMMANDS: Record<string, string> = {
  esphome_validate: 'validate',
  esphome_compile: 'compile',
  esphome_upload: 'upload',
  esphome_logs: 'logs',
}
const README_URL = 'https://github.com/Vortitron/home-assistant-mcp/tree/main/claude-plugin/vome-esphome'

const build = { plugin: 'vome-esphome', key: 'build' } as const
const devices = { plugin: 'vome-esphome', key: 'devices' } as const
const blocked = { plugin: 'vome-esphome', key: 'blocked' } as const
const fxOn = { plugin: 'vome-esphome', key: 'fxOn' } as const
const config = { plugin: 'vome-esphome', key: 'config' } as const
const showLog = { plugin: 'vome-esphome', key: 'showLog' } as const
/** How long a save's changes stay lit in the map. */
const CHANGE_MS = 8_000
const LOG_LINES = 2
/** The strip repaints this often while a build runs, and every few frames at rest. */
const FRAME_MS = 80
const IDLE_EVERY = 3

// Module variables reset on a reload, which is all these need.
let isPolling = false
/** The MCP has no esphome_activity: stop asking until the next build. */
let isUnsupported = false
let settingsFile = '~/.claude/settings.json'
/** Where the strip is mounted and what it shows, for the frame timer. */
let strip: { columns: number; state: ChipState } | null = null
let frame = 0
let isFxOn = true
let isBlitting = false
let shownTitle = 'ESPHome'
/** The configuration whose YAML the poll has asked for, once a build. */
let configAsked: string | null = null

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'esphome', description: 'Show the ESPHome build pane' })
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? '~'}/.claude`
    settingsFile = `${configDir.replace(/\/+$/, '')}/settings.json`
    $.clock.every(POLL_MS, () => void poll($))
    isFxOn = (await $.store.get('fxOn')) !== false
    await $.state.set(fxOn, isFxOn)
    $.clock.every(FRAME_MS, () => void animate($))

    return next(e)
  })

  on('command.run', { command: 'esphome' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'ESPHome' })
    return { text: opened.isPlaced ? 'ESPHome pane open.' : `The ESPHome pane is not drawn here: ${opened.reason}.` }
  })

  // The MCP's ESPHome tools, on whatever its server is called (tool matchers must be literals).
  on('tool.call', async ($, e, next) => {
    const match = /^mcp__(.+)__(esphome_[a-z_]+)$/.exec(e.tool)
    if (!match?.[1] || !match[2]) return next(e)
    const server = match[1]
    const name = match[2]
    const args = e as unknown as { configuration?: unknown }

    if (name === 'esphome_get_config' && typeof args.configuration === 'string') {
      const ran = await next(e)
      if (ran.deny === undefined && !ran.isError && ran.text) await showConfig($, args.configuration, stripStamp(ran.text))
      return ran
    }
    if (name === 'esphome_save_config' && typeof args.configuration === 'string') {
      const yaml = (e as unknown as { yaml?: unknown }).yaml
      const ran = await next(e)
      if (ran.deny === undefined && !ran.isError && typeof yaml === 'string') await showConfig($, args.configuration, yaml)
      return ran
    }

    if (name === 'esphome_list_devices') {
      const ran = await next(e)
      if (ran.deny === undefined && !ran.isError) {
        const list = parseDevices(ran.text ?? '')
        if (list) await $.state.set(devices, list)
      }
      return ran
    }

    const command = BUILD_COMMANDS[name]
    if (!command || typeof args.configuration !== 'string') return next(e)

    const started: Build = {
      server,
      command,
      configuration: args.configuration,
      startedAt: Date.now(),
      finishedAt: null,
      lines: [],
      seq: 0,
      isLive: false,
      outcome: 'running',
      error: null,
    }
    isUnsupported = false
    await $.state.set(build, started)
    await $.ui.open({ id: PANE, title: 'ESPHome' }).catch(() => undefined)
    shownTitle = 'ESPHome'
    configAsked = null

    const ran = await next(e)
    const current = (await $.state.get(build)).value ?? started
    const body = parseJson(ran.text ?? '')
    const output = body && typeof body.output === 'string' ? body.output : ''
    // Lines that arrived live stay; otherwise the full output is the first the pane sees of it.
    const lines = current.isLive && current.lines.length > 0 ? current.lines : toLines([output]).slice(-KEEP_LINES)
    const isOk =
      ran.deny === undefined && !ran.isError && body !== null && (body.success === true || (command === 'logs' && body.stopped === 'timeout'))
    // Claude Code moved the call to the background (after 120 s) or gave up waiting on it (a silent
    // 300 s), but the build carries on at home: keep following it, and let the job say how it ended.
    const said = ran.text ?? ran.deny ?? ''
    const isBackground = !isOk && /moved to the background|still running after/i.test(said)
    const isAbandoned = !isOk && (isBackground || (!isUnsupported && /no response or progress|aborted|cancel|timed? ?out/i.test(said)))
    if (isAbandoned) {
      await $.state.set(build, {
        ...current,
        error: isBackground ? 'Running in the background; it shows here as it goes.' : 'Claude stopped waiting; the build carries on at home and shows here.',
      })
      // A read refused earlier may be allowed by now: try again.
      isUnsupported = false
      return ran
    }
    await $.state.set(build, {
      ...current,
      lines,
      finishedAt: Date.now(),
      outcome: isOk ? 'ok' : 'failed',
      error: isOk ? null : firstLine(ran.deny ?? (body === null ? ran.text : null) ?? null),
    })

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const current = (await $.state.get(build)).value ?? null
    const known = (await $.state.get(devices)).value ?? null
    const refusal = (await $.state.get(blocked)).value ?? null
    const isFxEnabled = (await $.state.get(fxOn)).value ?? true
    const view = (await $.state.get(config)).value ?? null
    const isFullLog = (await $.state.get(showLog)).value ?? false
    const width = Math.max(20, e.props.bodyColumns)
    const rows = Math.max(6, (e.viewport?.rows ?? 30) - 14)

    const deviceRows = known && known.length > 0 ? (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Devices</Text>
        {known.map(d => {
          const isBehind = d.deployed !== null && d.current !== null && d.deployed !== d.current
          return (
            <Text wrap="truncate-end">
              <Text color={isBehind ? 'warning' : undefined}>{isBehind ? '↑ ' : '  '}</Text>
              {d.name}
              <Text dimColor>
                {'  '}
                {d.configuration}
                {d.deployed ? `  ${d.deployed}` : ''}
                {isBehind ? ` → ${d.current} available` : ''}
              </Text>
            </Text>
          )
        })}
      </Box>
    ) : null

    // Auto mode refuses a background read nobody asked for unless it is allowed by name.
    const help = refusal ? (
      <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1} marginTop={1}>
        <Text color="warning" wrap="wrap">
          Auto mode refused the pane's read of the build's progress or the device's YAML. Add these to permissions.allow
          in {settingsFile}, then the next build shows live:
        </Text>
        <Code source={allowLines(refusal.server)} />
        <Button key="copy-rule" hotkey="c" onPress={press => $.ui.copy({ text: allowLines(refusal.server), surface: press.surface })}>
          Copy the lines
        </Button>
      </Box>
    ) : null

    const map = view ? deviceMap($.ui.resolve(e), view) : null
    const isStage = e.surface === 'terminal' && isFxEnabled
    const things = view ? thingsOf(view) : []
    const stage = (state: Omit<ChipState, 'things' | 'hasWifi'>) => {
      if (e.surface !== 'terminal') return null
      const { Raster } = $.ui.resolve(e)
      const columns = Math.min(512, width)
      strip = { columns, state: { ...state, things, hasWifi: !!view?.rows.some(row => row.section === 'Network' && row.label === 'wifi') } }
      return <Raster key="chip" columns={columns} rows={STRIP_ROWS} cells={chipFrame(Date.now(), strip.state, columns)} />
    }

    if (!current) {
      if (!isStage) strip = null
      return (
        <Box flexDirection="column">
          {isStage
            ? stage({
                outcome: 'idle',
                scene: 'idle',
                percent: null,
                words: view ? `${view.name} · ${things.length || 'no'} thing${things.length === 1 ? '' : 's'} attached` : 'dreaming of devices…',
                endedAt: null,
              })
            : null}
          {map ?? (
            <Text dimColor wrap="wrap">
              Nothing building. When Claude reads, edits or builds an ESPHome device, its map shows here, and a build's
              progress as it runs.
            </Text>
          )}
          {deviceRows}
          {help}
        </Box>
      )
    }

    const progress = progressOf(current.lines, current.command)
    const took = elapsed((current.finishedAt ?? Date.now()) - current.startedAt)
    const verb = { validate: 'Checking', compile: 'Compiling', upload: 'Flashing', logs: 'Logs from' }[current.command] ?? current.command
    const done = { validate: 'Valid', compile: 'Compiled', upload: 'Flashed', logs: 'Read the logs' }[current.command] ?? 'Done'
    const status =
      current.outcome === 'running'
        ? `${phaseWords(progress, current.command)} · ${took}`
        : current.outcome === 'ok'
          ? `✓ ${done} in ${took}`
          : `✗ Failed after ${took}`
    const isUploading = current.outcome === 'running' && progress.uploadPercent !== null
    const isCompiling = current.outcome === 'running' && !isUploading && progress.compilePercent !== null
    const kept = current.lines.filter(line => current.command === 'logs' || kindOf(line) !== 'debug')
    // The latest couple of lines unless asked for all; a failure keeps a few more, where it explains itself.
    const tail = isFullLog || current.command === 'logs' ? kept.slice(-rows) : kept.slice(current.outcome === 'failed' ? -6 : -LOG_LINES)

    // The chip on the bench: a Raster, which only the terminal draws. Not for a logs read.
    let chip = null
    if (isStage) {
      // The scene follows the build, not the command: a flash compiles first, then uploads.
      const isUploadPhase = current.command === 'upload' && (progress.uploadPercent !== null || progress.phase === 'uploading')
      const scene: Scene =
        current.command === 'logs' ? 'logs' : current.command === 'validate' ? 'validate' : isUploadPhase ? 'upload' : 'compile'
      const words =
        current.outcome === 'running'
          ? `${scene === 'upload' ? 'flashing' : scene === 'validate' ? 'checking' : scene === 'logs' ? 'listening to' : 'compiling'} ${current.configuration}${(scene === 'upload' ? progress.uploadPercent : progress.compilePercent) !== null && scene !== 'logs' ? ` · ${scene === 'upload' ? progress.uploadPercent : progress.compilePercent}%` : ''}`
          : current.outcome === 'ok'
            ? `✓ ${current.configuration} ${done.toLowerCase()}`
            : `✗ ${current.configuration} failed`
      chip = stage({
        outcome: current.outcome,
        scene,
        percent: scene === 'upload' ? progress.uploadPercent : progress.compilePercent,
        words,
        endedAt: current.finishedAt,
      })
    } else {
      strip = null
    }

    return (
      <Box flexDirection="column">
        {chip}
        <Text bold wrap="truncate-end">
          {verb} {current.configuration}
        </Text>
        <Text color={current.outcome === 'ok' ? 'success' : current.outcome === 'failed' ? 'error' : 'warning'} wrap="truncate-end">
          {status}
        </Text>
        {isUploading ? (
          <Text color="suggestion">
            {bar(progress.uploadPercent ?? 0, Math.min(40, width - 8))} {progress.uploadPercent}%
          </Text>
        ) : isCompiling ? (
          <Text color="suggestion">
            {bar(progress.compilePercent ?? 0, Math.min(40, width - 8))} {progress.compilePercent}%
          </Text>
        ) : current.outcome === 'running' ? (
          <Text color="suggestion">{busy(Date.now(), Math.min(40, width - 8))}</Text>
        ) : null}
        <Text dimColor wrap="truncate-end">
          {[
            progress.ram ? `RAM ${progress.ram}` : null,
            progress.flash ? `Flash ${progress.flash}` : null,
            progress.warnings ? `${progress.warnings} warning${progress.warnings === 1 ? '' : 's'}` : null,
            current.outcome === 'running' && !current.isLive ? 'output arrives when it finishes' : null,
          ]
            .filter(Boolean)
            .join(' · ') || ' '}
        </Text>
        {current.outcome === 'failed' && (progress.errors[0] || current.error) ? (
          <Text color="error" wrap="wrap">
            {progress.errors[0] ?? current.error}
          </Text>
        ) : null}
        <Box flexDirection="column">
          {tail.map(line => (
            <Text wrap="truncate-end" color={lineColour(kindOf(line))} dimColor={kindOf(line) === 'plain' || kindOf(line) === 'debug'}>
              {line}
            </Text>
          ))}
        </Box>
        {isFullLog ? null : map}
        {deviceRows}
        {help}
        <Box marginTop={1} gap={2}>
          <Button key="log" hotkey="l" dimColor onPress={() => $.state.set(showLog, !isFullLog)}>
            {isFullLog ? 'Map and latest lines' : 'Full log'}
          </Button>
          <Button
            key="fx"
            hotkey="b"
            dimColor
            onPress={async () => {
              isFxOn = !isFxEnabled
              if (!isFxOn) strip = null
              await $.store.set('fxOn', isFxOn)
              await $.state.set(fxOn, isFxOn)
            }}
          >
            {isFxEnabled ? 'Animation off' : 'Animation on'}
          </Button>
        </Box>
      </Box>
    )
  })
}

/** Repaints the chip while the build runs and briefly after, without redrawing the pane. */
async function animate($: EngineInterface) {
  if (!isFxOn || !strip || isBlitting) return
  // At rest (idle, or a finished build that has settled), a gentler frame rate.
  const ended = strip.state.endedAt
  const isResting = strip.state.outcome === 'idle' || (ended !== null && Date.now() - ended > 5_000)
  frame = (frame + 1) % IDLE_EVERY
  if (isResting && frame !== 0) return
  isBlitting = true
  try {
    const result = await $.ui.blit({ requestId: PANE, key: 'chip', cells: chipFrame(Date.now(), strip.state, strip.columns) })
    if (result.deny !== undefined) strip = null
  } finally {
    isBlitting = false
  }
}

// ---------------------------------------------------------------- the device map

function deviceMap(ui: ReturnType<EngineInterface['ui']['resolve']>, view: ConfigView) {
  const { Box, Text } = ui
  const isFresh = view.changedAt !== null && Date.now() - view.changedAt < CHANGE_MS
  const rows: MapRow[] = [...view.rows]
  if (isFresh) {
    // A removed row stays a moment where it was, struck out, after the rest of its section.
    for (const gone of view.removed) {
      const last = rows.map(r => r.section).lastIndexOf(gone.section)
      rows.splice(last < 0 ? rows.length : last + 1, 0, gone)
    }
  }
  let section = ''
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold wrap="truncate-end">
        {view.name}
        <Text dimColor>
          {'  '}
          {view.chip}
          {view.chip ? ' · ' : ''}
          {view.configuration}
        </Text>
      </Text>
      {rows.map(row => {
        const change = isFresh ? view.changes[rowKey(row)] : undefined
        const heading = row.section !== section ? (section = row.section) : null
        const mark = change === 'added' ? '+' : change === 'changed' ? '~' : change === 'removed' ? '-' : ' '
        const colour = change === 'removed' ? 'error' : change ? 'suggestion' : undefined
        return (
          <Box flexDirection="column">
            {heading ? (
              <Text color="subtle" wrap="truncate-end">
                {heading}
              </Text>
            ) : null}
            <Text wrap="truncate-end" color={colour} strikethrough={change === 'removed'}>
              {mark}
              {'  '.repeat(row.depth + 1)}
              <Text color={colour ?? (row.icon === '!' ? 'warning' : 'suggestion')}>{row.icon}</Text> {row.label}
              <Text dimColor>
                {row.detail ? '  ' : ''}
                {row.detail}
              </Text>
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

/** What to draw wired to the chip at rest: the device's things, from its map, six at most. */
function thingsOf(view: ConfigView): Thing[] {
  const things: Thing[] = []
  for (const row of view.rows) {
    if (row.icon === '⚡') continue
    const words = `${row.label} ${row.detail}`.toLowerCase()
    const kind: Thing | null =
      row.section === 'Lights' ? 'light'
      : row.section === 'Sensors' ? (/humid|moist|water/.test(words) ? 'droplet' : /batt|adc|volt/.test(words) ? 'battery' : row.depth === 0 && view.rows.some(r => r.depth === 1 && r.section === 'Sensors' && view.rows.indexOf(r) === view.rows.indexOf(row) + 1) ? null : 'thermometer')
      : row.section === 'Binary sensors' || row.section === 'Buttons' ? 'button'
      : row.section === 'Switches' ? 'toggle'
      : row.section === 'Fans' ? 'fan'
      : row.section === 'Displays' ? 'screen'
      : row.section === 'Climate' ? 'thermometer'
      : ['Covers', 'Locks', 'Valves', 'Numbers', 'Selects', 'Media', 'Infrared and RF'].includes(row.section) ? 'gadget'
      : null
    if (kind) things.push(kind)
  }
  return things.slice(0, 6)
}

/** Maps the YAML and, against the last map of the same file, marks what changed. */
async function showConfig($: EngineInterface, configuration: string, yaml: string) {
  let device
  try {
    device = mapDevice(yaml)
  } catch {
    return
  }
  const before = (await $.state.get(config)).value ?? null
  const isSame = before?.configuration === configuration
  const diff = isSame ? diffMaps(before.rows, device.rows) : { changes: {}, removed: [] }
  const hasChanges = Object.keys(diff.changes).length > 0
  await $.state.set(config, {
    configuration,
    name: device.name,
    chip: device.chip,
    rows: device.rows,
    changes: hasChanges ? diff.changes : isSame ? before.changes : {},
    removed: hasChanges ? diff.removed : isSame ? before.removed : [],
    changedAt: hasChanges ? Date.now() : isSame ? before.changedAt : null,
  })
  await $.ui.open({ id: PANE, title: shownTitle }).catch(() => undefined)
}

/** Reads the YAML of what is being built, for the map; a refusal shows the line to allow. */
async function loadConfig($: EngineInterface, server: string, configuration: string) {
  try {
    const result = await $.mcp.call(server, 'esphome_get_config', { configuration })
    if (result.isError) return
    await showConfig($, configuration, stripStamp(result.content.map(block => block.text ?? '').join('\n')))
  } catch (error) {
    if (/auto mode|classifier|permission|denied|not allowed/i.test(String(error))) {
      await $.state.set(blocked, { server, error: String(error) })
    }
  }
}

function allowLines(server: string): string {
  return `"mcp__${server}__esphome_activity",\n"mcp__${server}__esphome_get_config"`
}

function stripStamp(text: string): string {
  return text.replace(/\n?\[vome-instance\][^\n]*/g, '')
}

/** The pane's tab says how the build is going, since another pane may be in front of it. */
async function retitle($: EngineInterface, current: Build) {
  const progress = progressOf(current.lines, current.command)
  const percent = progress.uploadPercent ?? progress.compilePercent
  const title =
    current.outcome === 'ok'
      ? 'ESPHome ✓'
      : current.outcome === 'failed'
        ? 'ESPHome ✗'
        : `ESPHome · ${percent !== null ? `${Math.floor(percent / 5) * 5}%` : '…'}`
  if (title === shownTitle) return
  shownTitle = title
  try {
    // Only a pane that is up: one the person closed stays closed.
    if (!(await $.ui.panes()).some(pane => pane.id === PANE)) return
    await $.ui.open({ id: PANE, title })
  } catch {
    // A surface without panes: the title is a nicety.
  }
}

// ---------------------------------------------------------------- polling

/** While a build runs: its new output from esphome_activity, and a redraw for the clock. */
async function poll($: EngineInterface) {
  if (isPolling) return
  const view = (await $.state.get(config)).value ?? null
  if (view?.changedAt && Date.now() - view.changedAt < CHANGE_MS + POLL_MS) $.ui.invalidate('ui.render')
  const current = (await $.state.get(build)).value ?? null
  if (current && current.finishedAt && Date.now() - current.finishedAt < POLL_MS * 2) await retitle($, current)
  if (!current || current.outcome !== 'running') return
  // The map of what is being built, read alongside when Claude has not read it this session.
  // (Here, not in the tool hook: a state read there before the call pins its view of the build.)
  if (configAsked !== current.configuration && current.command !== 'logs') {
    configAsked = current.configuration
    if (view?.configuration !== current.configuration) void loadConfig($, current.server, current.configuration)
  }
  isPolling = true
  try {
    if (isUnsupported) {
      $.ui.invalidate('ui.render')
      return
    }
    let text = ''
    try {
      const result = await $.mcp.call(current.server, 'esphome_activity', { since: current.seq })
      text = result.content.map(block => block.text ?? '').join('\n')
      if (result.isError) {
        isUnsupported = true
        await giveUp($)
        return
      }
    } catch (error) {
      if (/auto mode|classifier|permission|denied|not allowed/i.test(String(error))) {
        await $.state.set(blocked, { server: current.server, error: String(error) })
      }
      isUnsupported = true
      await giveUp($)
      return
    }
    const body = parseJson(text)
    const jobs = body && Array.isArray(body.jobs) ? (body.jobs as Record<string, unknown>[]) : []
    // This build's jobs: same configuration, started no earlier than the call. A flash is two
    // (the MCP compiles, then uploads), followed as one build.
    const commands = current.command === 'upload' ? ['compile', 'upload'] : [current.command]
    const mine = jobs
      .filter(j => commands.includes(String(j.command)) && j.configuration === current.configuration)
      .filter(j => Date.parse(String(j.started)) >= current.startedAt - 5_000)
    const fresh = mine.flatMap(j => (Array.isArray(j.lines) ? toLines(j.lines.map(String)) : []))
    // The job that says how it ended: the last one, once it is the build's own command or has failed.
    const last = mine.at(-1)
    const job = last && (last.command === current.command || (last.done === true && last.exit_code !== 0)) ? last : undefined
    const seq = typeof body?.seq === 'number' ? body.seq : current.seq
    const latest = (await $.state.get(build)).value ?? current
    if (latest.outcome !== 'running') return
    // The job finished: the result comes from it when the tool call was abandoned before it.
    if (job && job.done === true && latest.error) {
      await $.state.set(build, {
        ...latest,
        lines: [...latest.lines, ...fresh].slice(-KEEP_LINES),
        seq,
        finishedAt: Date.now(),
        outcome: job.exit_code === 0 ? 'ok' : 'failed',
        error: job.exit_code === 0 ? null : typeof job.error === 'string' ? job.error : `exit code ${String(job.exit_code)}`,
      })
      return
    }
    await retitle($, { ...latest, lines: [...latest.lines, ...fresh] })
    if (fresh.length > 0 || seq !== latest.seq) {
      await $.state.set(build, {
        ...latest,
        lines: [...latest.lines, ...fresh].slice(-KEEP_LINES),
        seq,
        isLive: latest.isLive || fresh.length > 0,
      })
      if ((await $.state.get(blocked)).value) await $.state.set(blocked, null)
    } else {
      $.ui.invalidate('ui.render')
    }
  } finally {
    isPolling = false
  }
}

/** A call Claude abandoned, with no way to follow the job: say so rather than spin for ever. */
async function giveUp($: EngineInterface) {
  const latest = (await $.state.get(build)).value ?? null
  if (latest?.outcome === 'running' && latest.error) await $.state.set(build, { ...latest, finishedAt: Date.now(), outcome: 'failed' })
}

// ---------------------------------------------------------------- small things

function lineColour(kind: LineKind): string | undefined {
  return kind === 'error' ? 'error' : kind === 'warning' ? 'warning' : undefined
}

/** A bar that moves while there is no percentage to show. */
function busy(now: number, width: number): string {
  const at = Math.floor(now / 400) % (width + 6)
  return Array.from({ length: width }, (_, i) => (i >= at - 6 && i < at ? '▰' : '▱')).join('')
}

function firstLine(text: string | null): string | null {
  return text ? (text.split('\n').find(line => line.trim()) ?? null) : null
}

/** The JSON body of a vome MCP reply, which ends with a `[vome-instance]` line. */
function parseJson(raw: string): Record<string, unknown> | null {
  // Drop the stamp first: its own brackets would otherwise end the slice below inside it.
  const text = raw.replace(/\[vome-instance\][^\n]*/g, '')
  const start = text.search(/[[{]/)
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { list: value }
  } catch {
    return null
  }
}

/** esphome_list_devices: the dashboard's own model, `{configured: [...]}` or a bare list, tolerated either way. */
function parseDevices(text: string): Device[] | null {
  const body = parseJson(text)
  if (!body) return null
  const holder = (body.devices && typeof body.devices === 'object' ? body.devices : body) as Record<string, unknown>
  const rows = Array.isArray(holder.configured) ? holder.configured : Array.isArray(holder.list) ? holder.list : Array.isArray(holder) ? holder : []
  return (rows as Record<string, unknown>[])
    .filter(row => row && typeof row === 'object')
    .map(row => ({
      name: String(row.friendly_name ?? row.name ?? row.configuration ?? '?'),
      configuration: String(row.configuration ?? ''),
      deployed: typeof row.deployed_version === 'string' ? row.deployed_version : null,
      current: typeof row.current_version === 'string' ? row.current_version : null,
    }))
}
