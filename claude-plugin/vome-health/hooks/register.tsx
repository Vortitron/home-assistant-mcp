// A side pane for the home's health: Vome's score out of 100 and what its
// check found, kept beside the conversation while Claude works through it.
//
// It fills when Claude reads the report (the MCP's vome_health_report) or with
// /health. Each finding is listed by severity with what to do about it; when
// Claude changes something a finding is about (one of its entities, the
// recorder for a flooding sensor, an automation for the automation findings),
// the finding is marked as worked on. A re-check (Claude's vome_health_check,
// or r here) then settles it: resolved findings are struck through and the
// score rolls to the new one, with fireworks when it went up. It never fixes
// anything itself; r only asks for a fresh check.

import type { EngineInterface, Register } from 'claude-code'

import type { Category, Change, Finding, Report } from '../types'
import { STRIP_ROWS, stageFrame } from './stage'
import type { StageState } from './stage'

const PANE = 'vome-health'
const README_URL = 'https://github.com/Vortitron/home-assistant-mcp/tree/main/claude-plugin/vome-health'
/** How often a running check is looked in on: it takes a couple of minutes at Vome. */
const POLL_MS = 10_000
const CHECK_GIVE_UP_MS = 8 * 60_000
/** How long the latest check's changes stay at the top. */
const CHANGE_SHOWN_MS = 5 * 60_000
const FRAME_MS = 80
const IDLE_EVERY = 3
const SEVERITY_ORDER = ['warn', 'advice', 'info']

const report = { plugin: 'vome-health', key: 'report' } as const
const change = { plugin: 'vome-health', key: 'change' } as const
const checking = { plugin: 'vome-health', key: 'checking' } as const
const touched = { plugin: 'vome-health', key: 'touched' } as const
const details = { plugin: 'vome-health', key: 'details' } as const
const fxOn = { plugin: 'vome-health', key: 'fxOn' } as const
const blocked = { plugin: 'vome-health', key: 'blocked' } as const
const note = { plugin: 'vome-health', key: 'note' } as const

// Module variables reset on a reload, which is all these need.
let isPolling = false
let settingsFile = '~/.claude/settings.json'
let strip: { columns: number; state: StageState } | null = null
let isFxOn = true
let isBlitting = false
let frame = 0

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'health', description: "Show the home's Vome health score in a side pane" })
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? '~'}/.claude`
    settingsFile = `${configDir.replace(/\/+$/, '')}/settings.json`
    $.clock.every(POLL_MS, () => void poll($))
    $.clock.every(FRAME_MS, () => void animate($))
    isFxOn = (await storeGet($, 'fxOn')) !== false
    await $.state.set(fxOn, isFxOn)
    return next(e)
  })

  on('command.run', { command: 'health' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Health' })
    const known = (await $.state.get(report)).value ?? null
    const server = known?.server ?? (await healthServers($))[0]
    if (!server) {
      // Connected, but to a server that predates the tool: Claude Code keeps the tool list it read at connect.
      const older = (await $.tool.list()).map(tool => /^mcp__(.+)__ha_get_state$/.exec(tool.name)?.[1]).find(Boolean)
      return {
        text: older
          ? `${older} has no vome_health_report in the tool list Claude Code read when it connected. If the server was updated since, run /mcp, choose ${older}, then Reconnect.`
          : 'No connected MCP server has vome_health_report yet: connect Home Assistant through Vome first (vome-connect).',
      }
    }
    void fetchReport($, server)
    return { text: opened.isPlaced ? "Reading the home's health report into the pane." : `The health pane is not drawn here: ${opened.reason}.` }
  })

  on('tool.call', async ($, e, next) => {
    const match = /^mcp__(.+)__([a-z_]+)$/.exec(e.tool)
    if (!match?.[1] || !match[2]) return next(e)
    const server = match[1]
    const name = match[2]

    if (name === 'vome_health_report') {
      const ran = await next(e)
      if (ran.deny === undefined && !ran.isError) {
        await applyReport($, server, ran.text ?? '')
        await $.ui.open({ id: PANE, title: 'Health' }).catch(() => undefined)
      }
      return ran
    }
    if (name === 'vome_health_check') {
      const ran = await next(e)
      if (ran.deny === undefined && !ran.isError) await startChecking($, server)
      return ran
    }

    // Anything else that changes the home: is it about one of the findings?
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError || isRead(name)) return ran
    const current = (await $.state.get(report)).value ?? null
    if (!current) return ran
    const text = JSON.stringify(e)
    const hit = current.findings.filter(finding => touches(finding, name, text))
    if (hit.length > 0) {
      const before = (await $.state.get(touched)).value ?? {}
      await $.state.set(touched, { ...before, ...Object.fromEntries(hit.map(finding => [finding.id, Date.now()])) })
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code, Link } = $.ui.resolve(e)
    const current = (await $.state.get(report)).value ?? null
    const latest = (await $.state.get(change)).value ?? null
    const running = (await $.state.get(checking)).value ?? null
    const worked = (await $.state.get(touched)).value ?? {}
    const isDetailed = (await $.state.get(details)).value ?? false
    const isFxEnabled = (await $.state.get(fxOn)).value ?? true
    const refusal = (await $.state.get(blocked)).value ?? null
    const message = (await $.state.get(note)).value ?? null
    const width = Math.max(20, e.props.bodyColumns)
    const isChangeShown = latest !== null && Date.now() - latest.at < CHANGE_SHOWN_MS

    let stage = null
    if (e.surface === 'terminal' && isFxEnabled) {
      const { Raster } = $.ui.resolve(e)
      const columns = Math.min(512, width)
      const home = current ? homeName(current) : ''
      const words = running
        ? `checking ${home || 'the home'}…`
        : current
          ? isChangeShown && latest.from !== null && latest.to !== null && latest.from !== latest.to
            ? `${home} · ${latest.from} → ${latest.to}`
            : `${home} · ${current.findings.length} finding${current.findings.length === 1 ? '' : 's'}`
          : 'no health score yet'
      strip = {
        columns,
        state: {
          score: current?.score ?? null,
          from: isChangeShown ? latest.from : null,
          changedAt: isChangeShown ? latest.at : null,
          isChecking: running !== null,
          words,
        },
      }
      stage = <Raster key="stage" columns={columns} rows={STRIP_ROWS} cells={stageFrame(Date.now(), strip.state, columns)} />
    } else {
      strip = null
    }

    const help = refusal ? (
      <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1} marginTop={1}>
        <Text color="warning" wrap="wrap">
          Auto mode refused the pane's {refusal.tool === 'vome_health_check' ? 're-check' : 'read of the report'}. Add this to
          permissions.allow in {settingsFile}, or ask Claude to {refusal.tool === 'vome_health_check' ? 're-check the health score' : 'read the health report'}:
        </Text>
        <Code source={`"mcp__${refusal.server}__${refusal.tool}"`} />
        <Button key="copy-rule" hotkey="c" onPress={press => $.ui.copy({ text: `"mcp__${refusal.server}__${refusal.tool}"`, surface: press.surface })}>
          Copy the line
        </Button>
      </Box>
    ) : null

    if (!current) {
      return (
        <Box flexDirection="column">
          {stage}
          <Text dimColor wrap="wrap">
            No health score yet. Ask Claude "how healthy is my Home Assistant?", or press /health. Vome's check scores the home
            out of 100 and lists what to fix.
          </Text>
          {running ? <Text color="suggestion">Checking… the score lands here in a couple of minutes.</Text> : null}
          {message ? <Text color="warning" wrap="wrap">{message}</Text> : null}
          {help}
        </Box>
      )
    }

    const groups = groupFindings(current.findings)
    const ago = current.generatedAt ? since(Date.parse(current.generatedAt)) : 'unknown'
    const isStale = current.generatedAt !== null && Date.now() - Date.parse(current.generatedAt) > 7 * 24 * 3600_000

    return (
      <Box flexDirection="column">
        {stage}
        <Text bold wrap="truncate-end">
          {homeName(current)}
          <Text color={scoreColour(current.score)}>
            {'  '}
            {current.score ?? '?'}/100
          </Text>
          <Text dimColor color={isStale ? 'warning' : undefined}>
            {'  '}checked {ago}
            {isStale ? ' (re-check for today\'s)' : ''}
          </Text>
        </Text>
        {current.summary ? (
          <Text dimColor wrap="wrap">
            {current.summary}
          </Text>
        ) : null}
        <Text wrap="truncate-end">
          {current.categories.map((category: Category) => (
            <Text color={severityColour(category.severity)}>
              {severityIcon(category.severity)} {category.label}
              {'   '}
            </Text>
          ))}
        </Text>
        {running ? (
          <Text color="suggestion" wrap="wrap">
            Checking… the new score lands here in a couple of minutes ({since(running.startedAt).replace(' ago', '')} so far).
          </Text>
        ) : null}
        {isChangeShown ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={latest.to !== null && latest.from !== null && latest.to < latest.from ? 'warning' : 'success'}>
              {latest.from ?? '?'} → {latest.to ?? '?'}
              {latest.resolved.length > 0 ? `: ${latest.resolved.length} finding${latest.resolved.length === 1 ? '' : 's'} gone` : ''}
              {latest.added.length > 0 ? `, ${latest.added.length} new` : ''}
            </Text>
            {latest.resolved.map((finding: Finding) => (
              <Text color="success" strikethrough wrap="truncate-end">
                ✓ {finding.title}
              </Text>
            ))}
          </Box>
        ) : null}
        {groups.map(group => (
          <Box flexDirection="column" marginTop={1}>
            <Text color="subtle">{group.label}</Text>
            {group.findings.map((finding: Finding) => {
              const isWorked = worked[finding.id] !== undefined
              const isNew = isChangeShown && latest.added.includes(finding.id)
              const isOpen = isDetailed || (finding.severity === 'warn' && !isWorked)
              return (
                <Box flexDirection="column">
                  <Text wrap="truncate-end" color={isWorked ? 'suggestion' : undefined}>
                    <Text color={severityColour(finding.severity)}>{isWorked ? '✎' : severityIcon(finding.severity)}</Text> {isNew ? '+ ' : ''}
                    {finding.title}
                    {isWorked ? <Text dimColor>  changed; re-check to confirm</Text> : null}
                  </Text>
                  {isOpen && finding.recommendation ? (
                    <Text dimColor wrap="wrap">
                      {'   '}
                      {finding.recommendation}
                    </Text>
                  ) : null}
                  {isDetailed && finding.evidence ? (
                    <Text dimColor wrap="wrap">
                      {'   '}
                      {finding.evidence}
                    </Text>
                  ) : null}
                </Box>
              )
            })}
          </Box>
        ))}
        {message ? <Text color="warning" wrap="wrap">{message}</Text> : null}
        {help}
        <Box flexDirection="row" gap={2} marginTop={1}>
          <Button key="recheck" hotkey="r" onPress={() => requestCheck($, current.server)}>
            {running ? 'Checking…' : 'Re-check'}
          </Button>
          <Button key="details" hotkey="d" dimColor onPress={() => $.state.set(details, !isDetailed)}>
            {isDetailed ? 'Less' : 'Details'}
          </Button>
          <Button
            key="fx"
            hotkey="b"
            dimColor
            onPress={async () => {
              isFxOn = !isFxEnabled
              if (!isFxOn) strip = null
              await storeSet($, 'fxOn', isFxOn)
              await $.state.set(fxOn, isFxOn)
            }}
          >
            {isFxEnabled ? 'Animation off' : 'Animation on'}
          </Button>
          {current.healthUrl ? <Link href={current.healthUrl}>Full report</Link> : <Link href={README_URL}>About</Link>}
        </Box>
      </Box>
    )
  })
}

// ---------------------------------------------------------------- the report

/** A report from vome_health_report's reply; against the one before it, what the new check changed. */
async function applyReport($: EngineInterface, server: string, raw: string) {
  const body = parseJson(raw)
  if (!body) return
  if (body.found === false) {
    await $.state.set(note, typeof body.note === 'string' ? body.note : 'No health score on this home yet.')
    return
  }
  const next: Report = {
    server,
    home: /\[vome-instance\][^\n]*\bhome="([^"]*)"/.exec(raw)?.[1] ?? 'Home',
    entityId: String(body.entity_id ?? ''),
    score: typeof body.score === 'number' ? body.score : null,
    summary: typeof body.summary === 'string' ? body.summary : '',
    generatedAt: typeof body.generated_at === 'string' ? body.generated_at : null,
    categories: Array.isArray(body.categories) ? (body.categories as Category[]) : [],
    findings: Array.isArray(body.findings) ? (body.findings as Finding[]).filter(f => f && typeof f.title === 'string') : [],
    healthUrl: typeof body.health_url === 'string' ? body.health_url : null,
  }
  const before = (await $.state.get(report)).value ?? null
  const running = (await $.state.get(checking)).value ?? null
  const isNewCheck = before !== null && before.server === server && before.generatedAt !== next.generatedAt
  if (isNewCheck) {
    const same = (a: Finding, b: Finding) => a.id === b.id || a.title === b.title
    const delta: Change = {
      from: before.score,
      to: next.score,
      at: Date.now(),
      resolved: before.findings.filter(old => !next.findings.some(now => same(old, now))),
      added: next.findings.filter(now => !before.findings.some(old => same(old, now))).map(f => f.id),
    }
    await $.state.set(change, delta)
    await $.state.set(touched, {})
  }
  if (running && running.previousGeneratedAt !== next.generatedAt) await $.state.set(checking, null)
  await $.state.set(report, next)
  await $.state.set(note, null)
}

async function fetchReport($: EngineInterface, server: string) {
  const reply = await callMcp($, server, 'vome_health_report', {})
  if (reply) await applyReport($, server, reply)
}

async function startChecking($: EngineInterface, server: string) {
  const current = (await $.state.get(report)).value ?? null
  await $.state.set(checking, { server, startedAt: Date.now(), previousGeneratedAt: current?.generatedAt ?? null })
  await $.ui.open({ id: PANE, title: 'Health' }).catch(() => undefined)
}

/** r: ask for a fresh check. The person pressed it, so it is theirs; auto mode may still want it allowed. */
async function requestCheck($: EngineInterface, server: string) {
  if ((await $.state.get(checking)).value) return
  const reply = await callMcp($, server, 'vome_health_check', {})
  if (reply !== null) await startChecking($, server)
}

/** One background call; a refusal shows the line to allow, any other failure a note. */
async function callMcp($: EngineInterface, server: string, tool: string, args: Record<string, unknown>): Promise<string | null> {
  try {
    const result = await $.mcp.call(server, tool, args)
    const text = result.content.map(block => block.text ?? '').join('\n')
    if (result.isError) {
      await $.state.set(note, firstLine(text) ?? `${tool} failed.`)
      return null
    }
    if ((await $.state.get(blocked)).value) await $.state.set(blocked, null)
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

/** While a check runs, look in on the report until the new one lands. */
async function poll($: EngineInterface) {
  if (isPolling) return
  const running = (await $.state.get(checking)).value ?? null
  const latest = (await $.state.get(change)).value ?? null
  if (latest && Date.now() - latest.at < CHANGE_SHOWN_MS + POLL_MS) $.ui.invalidate('ui.render')
  if (!running) return
  isPolling = true
  try {
    if (Date.now() - running.startedAt > CHECK_GIVE_UP_MS) {
      await $.state.set(checking, null)
      await $.state.set(note, 'The check is taking longer than usual. The score lands on the home when it finishes; /health reads it then.')
      return
    }
    await fetchReport($, running.server)
    $.ui.invalidate('ui.render')
  } finally {
    isPolling = false
  }
}

/** Repaints the strip; gently at rest, quickly while a check runs or a new score rolls in. */
async function animate($: EngineInterface) {
  if (!isFxOn || !strip || isBlitting) return
  const changed = strip.state.changedAt
  const isBusy = strip.state.isChecking || (changed !== null && Date.now() - changed < 6_000)
  frame = (frame + 1) % IDLE_EVERY
  if (!isBusy && frame !== 0) return
  isBlitting = true
  try {
    const result = await $.ui.blit({ requestId: PANE, key: 'stage', cells: stageFrame(Date.now(), strip.state, strip.columns) })
    if (result.deny !== undefined) strip = null
  } finally {
    isBlitting = false
  }
}

// ---------------------------------------------------------------- which change is about which finding

/** Tools that only read: they cannot have fixed anything. */
function isRead(name: string): boolean {
  return /^(ha|esphome|nodered|vomehome)_(get|list|read|render|check|camera)|_activity$|_logs$|_validate$|^vome_health/.test(name)
}

/**
 * Whether a change Claude made is about this finding: one of its entities named in the call, or
 * the kind of change its category calls for (the recorder for a flooding sensor, an automation for
 * the automation findings, a removal for the leftover entities).
 */
export function touches(finding: Finding, tool: string, text: string): boolean {
  if (finding.entities?.some(id => text.includes(id))) return true
  switch (finding.category) {
    case 'flapping':
    case 'recorder':
      return (tool === 'ha_write_config_file' && /recorder/.test(text)) || /update_interval/.test(text)
    case 'automations':
      return /automation/.test(tool) || /"automation\.|"domain":"automation"/.test(text)
    case 'dead_entities':
      return /delete|remove/.test(tool) && /entit|config_entry/.test(tool + text)
    case 'batteries':
      return /batter/.test(text)
    default:
      return false
  }
}

// ---------------------------------------------------------------- small things

function groupFindings(findings: Finding[]): { label: string; findings: Finding[] }[] {
  const couldNot = (f: Finding) => /could not be checked/i.test(f.title)
  const labels: Record<string, string> = { warn: 'To fix', advice: 'Worth doing', info: 'Fine' }
  const groups = SEVERITY_ORDER.map(severity => ({
    label: labels[severity] ?? severity,
    findings: findings.filter(f => !couldNot(f) && f.severity === severity),
  }))
  const other = findings.filter(f => !couldNot(f) && !SEVERITY_ORDER.includes(f.severity))
  const skipped = findings.filter(couldNot)
  return [...groups, { label: 'Other', findings: other }, { label: 'Not checked this time', findings: skipped }].filter(g => g.findings.length > 0)
}

function severityIcon(severity: string): string {
  return severity === 'warn' ? '⚠' : severity === 'advice' ? '◆' : severity === 'info' ? '✓' : '·'
}

function severityColour(severity: string): string | undefined {
  return severity === 'warn' ? 'warning' : severity === 'advice' ? 'suggestion' : severity === 'info' ? 'success' : undefined
}

function scoreColour(score: number | null): string | undefined {
  if (score === null) return undefined
  return score >= 85 ? 'success' : score >= 65 ? 'warning' : 'error'
}

function homeName(current: Report): string {
  return current.home || 'Home'
}

function since(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 90) return `${s} s ago`
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 2 * 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}

async function healthServers($: EngineInterface): Promise<string[]> {
  return (await $.tool.list())
    .map(tool => /^mcp__(.+)__vome_health_report$/.exec(tool.name)?.[1])
    .filter((server): server is string => !!server)
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

async function storeGet($: EngineInterface, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

async function storeSet($: EngineInterface, key: string, value: unknown) {
  try {
    await $.store.set(key, value as never)
  } catch {
    // A store that cannot keep it: the toggle still works for this session.
  }
}
