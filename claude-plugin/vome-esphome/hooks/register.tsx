// A side pane for the ESPHome build Claude is running.
//
// A compile or a flash takes minutes and its tool returns all of its output
// only at the end, so there was nothing to watch while it ran. This pane opens
// when Claude starts one, reads the build's output as it arrives (the MCP's
// esphome_activity, read-only), and shows the phase, a progress bar where the
// output gives one, the latest lines with errors picked out, and the result.
// With an MCP that predates esphome_activity it still shows the elapsed time
// and then the output once the build returns. It never runs a build itself.

import type { EngineInterface, Register } from 'claude-code'

import type { Build, Device } from '../types'
import { bar, elapsed, kindOf, phaseWords, progressOf, toLines } from './build'
import { chipFrame, STRIP_ROWS } from './chip'
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
/** The strip repaints this often while a build runs, and for a few seconds after. */
const FRAME_MS = 80
const AFTERGLOW_MS = 4_000

// Module variables reset on a reload, which is all these need.
let isPolling = false
/** The MCP has no esphome_activity: stop asking until the next build. */
let isUnsupported = false
let settingsFile = '~/.claude/settings.json'
/** Where the strip is mounted and what it shows, for the frame timer. */
let strip: { columns: number; state: Parameters<typeof chipFrame>[1] } | null = null
let isFxOn = true
let isBlitting = false

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

    const ran = await next(e)
    const current = (await $.state.get(build)).value ?? started
    const body = parseJson(ran.text ?? '')
    const output = body && typeof body.output === 'string' ? body.output : ''
    // Lines that arrived live stay; otherwise the full output is the first the pane sees of it.
    const lines = current.isLive && current.lines.length > 0 ? current.lines : toLines([output]).slice(-KEEP_LINES)
    const isOk =
      ran.deny === undefined && !ran.isError && body !== null && (body.success === true || (command === 'logs' && body.stopped === 'timeout'))
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
    const width = Math.max(20, e.props.bodyColumns)
    const rows = Math.max(6, (e.viewport?.rows ?? 30) - 14)

    const deviceRows = known ? (
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
          Auto mode refused the pane's read of the build's progress. Add this to permissions.allow in {settingsFile}, then
          the next build shows live:
        </Text>
        <Code source={`"mcp__${refusal.server}__esphome_activity"`} />
        <Button
          key="copy-rule"
          hotkey="c"
          onPress={press => $.ui.copy({ text: `"mcp__${refusal.server}__esphome_activity"`, surface: press.surface })}
        >
          Copy the line
        </Button>
      </Box>
    ) : null

    if (!current) {
      return (
        <Box flexDirection="column">
          <Text dimColor wrap="wrap">
            Nothing building. When Claude validates, compiles, flashes or reads the logs of an ESPHome device, it shows
            here as it runs.
          </Text>
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
    const tail = current.lines.filter(line => current.command === 'logs' || kindOf(line) !== 'debug').slice(-rows)

    // The chip on the bench: a Raster, which only the terminal draws. Not for a logs read.
    let chip = null
    if (e.surface === 'terminal' && isFxEnabled && current.command !== 'logs') {
      const { Raster } = $.ui.resolve(e)
      const columns = Math.min(512, width)
      const words =
        current.outcome === 'running'
          ? `${current.command === 'upload' ? 'flashing' : current.command === 'validate' ? 'checking' : 'compiling'} ${current.configuration}${progress.uploadPercent !== null ? ` · ${progress.uploadPercent}%` : ''}`
          : current.outcome === 'ok'
            ? `✓ ${current.configuration} ${done.toLowerCase()}`
            : `✗ ${current.configuration} failed`
      strip = {
        columns,
        state: { outcome: current.outcome, percent: progress.uploadPercent, words, endedAt: current.finishedAt },
      }
      chip = <Raster key="chip" columns={columns} rows={STRIP_ROWS} cells={chipFrame(Date.now(), strip.state, columns)} />
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
        <Box flexDirection="column" marginTop={1}>
          {tail.map(line => (
            <Text wrap="truncate-end" color={lineColour(kindOf(line))} dimColor={kindOf(line) === 'plain' || kindOf(line) === 'debug'}>
              {line}
            </Text>
          ))}
        </Box>
        {deviceRows}
        {help}
        <Box marginTop={1}>
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
  const ended = strip.state.endedAt
  if (ended !== null && Date.now() - ended > AFTERGLOW_MS) return
  isBlitting = true
  try {
    const result = await $.ui.blit({ requestId: PANE, key: 'chip', cells: chipFrame(Date.now(), strip.state, strip.columns) })
    if (result.deny !== undefined) strip = null
  } finally {
    isBlitting = false
  }
}

// ---------------------------------------------------------------- polling

/** While a build runs: its new output from esphome_activity, and a redraw for the clock. */
async function poll($: EngineInterface) {
  if (isPolling) return
  const current = (await $.state.get(build)).value ?? null
  if (!current || current.outcome !== 'running') return
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
        return
      }
    } catch (error) {
      if (/auto mode|classifier|permission|denied|not allowed/i.test(String(error))) {
        await $.state.set(blocked, { server: current.server, error: String(error) })
      }
      isUnsupported = true
      return
    }
    const body = parseJson(text)
    const jobs = body && Array.isArray(body.jobs) ? (body.jobs as Record<string, unknown>[]) : []
    // This build's job: same command and configuration, started no earlier than the call.
    const job = jobs
      .filter(j => j.command === current.command && j.configuration === current.configuration)
      .filter(j => Date.parse(String(j.started)) >= current.startedAt - 5_000)
      .at(-1)
    const fresh = job && Array.isArray(job.lines) ? toLines(job.lines.map(String)) : []
    const seq = typeof body?.seq === 'number' ? body.seq : current.seq
    const latest = (await $.state.get(build)).value ?? current
    if (latest.outcome !== 'running') return
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
