// house.wad in a pane: the Home Assistant home as a Doom level, in the terminal.
//
// house.wad's own game (github.com/Vortitron/housewad) runs as a Node process:
// its terminal host builds the level from a snapshot of the home, runs the
// same engine as the Lovelace card, and sends frames as half-block cells,
// which this pane draws in a Raster. Keys come from a Client strip under the
// screen and reach the game as small files in a folder (a process started
// from a plugin has no open stdin). What the game does to the house (a lamp
// shot, a door used) arrives as a call, which this pane makes through the
// Vome MCP, as the dashboard pane's buttons do.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Phase, Status } from '../types'

const PANE = 'house-wad'
/** The house.wad release whose dist/ has the terminal host. */
const HOUSEWAD_VERSION = '0.7.6'
const RELEASE = `https://raw.githubusercontent.com/Vortitron/housewad/v${HOUSEWAD_VERSION}/dist/`
const FILES = ['housewad-term.mjs', 'housewad-engine.js', 'housewad-engine.wasm', 'housewad-zdbsp.js', 'housewad-zdbsp.wasm', 'freedoom2.wad']
/** What the level is built from: the domains house.wad reads. */
/** The reads a game starts with, all read-only: what auto mode needs allowed by name. */
const READS = ['ha_list_areas', 'ha_list_devices', 'ha_get_entity_registry', 'ha_list_entities', 'ha_get_state']
const DOMAINS = ['light', 'switch', 'lock', 'vacuum', 'sensor', 'media_player', 'cover', 'person', 'sun', 'camera', 'binary_sensor', 'water_heater', 'climate', 'alarm_control_panel']

const phase = atom({ plugin: 'vome-doom', key: 'phase' } as const, 'idle' as Phase)
const note = atom({ plugin: 'vome-doom', key: 'note' } as const, null as string | null)
const size = atom({ plugin: 'vome-doom', key: 'size' } as const, null as { columns: number; rows: number } | null)
const status = atom({ plugin: 'vome-doom', key: 'status' } as const, null as Status | null)
const homeName = atom({ plugin: 'vome-doom', key: 'home' } as const, null as string | null)
const blocked = atom({ plugin: 'vome-doom', key: 'blocked' } as const, null as { server: string; tool: string } | null)

// The running game: the module's own, gone with a reload (which kills the child too).
let frame: string | null = null
let inputDir: string | null = null
let sequence = 0
let server: string | null = null
let room = { columns: 96, rows: 36 }
let stopRequested = false
let settingsFile = '~/.claude/settings.json'
let lastMode: 'real' | 'practice' = 'practice'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'doom', description: 'Play house.wad: your Home Assistant home as a Doom level, in a pane (play, practice)' })
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? '~'}/.claude`
    settingsFile = `${configDir.replace(/\/+$/, '')}/settings.json`
    return next(e)
  })

  // /doom opens the pane; /doom play or /doom practice starts a game straight away.
  on('command.run', { command: 'doom' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'house.wad', focus: true })
    const word = e.args.trim().toLowerCase()
    if (word === 'play' || word === 'practice') {
      void start($, word === 'play' ? 'real' : 'practice')
      return { text: `Starting house.wad${word === 'practice' ? ' in practice (nothing in the house changes)' : ''}. Click the strip under the screen to play.` }
    }
    return { text: 'house.wad is open in the pane. Press Play when you are ready (or /doom play, /doom practice).' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return <Text>house.wad plays in the terminal.</Text>
    }
    const { Box, Text, Button, Raster, Client, Markdown, Code } = $.ui.resolve(e)
    // Room for the screen: the pane's width, its height less the strip and the buttons.
    room = { columns: Math.max(40, e.props.bodyColumns), rows: Math.max(12, (e.viewport?.rows ?? 40) - 6) }
    const now = await read($, phase)
    const said = await read($, note)
    const home = await read($, homeName)
    const refusal = await read($, blocked)
    const rules = refusal
      ? refusal.tool === 'ha_call_service'
        ? `"mcp__${refusal.server}__ha_call_service"`
        : READS.map(tool => `"mcp__${refusal.server}__${tool}"`).join(',\n')
      : ''
    const help = refusal ? (
      <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
        {refusal.tool === 'ha_call_service' ? (
          <Text color="warning" wrap="wrap">
            Auto mode refused what the game did to the house: it calls ha_call_service, and allowing that by name would let
            Claude change things without asking too. Practise, switch auto mode off, or allow it in {settingsFile} if you are
            happy with that:
          </Text>
        ) : (
          <Text color="warning" wrap="wrap">
            Auto mode refused reading your home. Add these to permissions.allow in {settingsFile}; they only read:
          </Text>
        )}
        <Markdown text={`[${settingsFile}](file://${settingsFile})`} />
        <Code source={rules} />
        <Box flexDirection="row" gap={2}>
          <Button key="copy-rule" hotkey="c" onPress={press => $.ui.copy({ text: rules, surface: press.surface })}>
            Copy
          </Button>
          {refusal.tool === 'ha_call_service' ? null : (
            <Button
              key="retry"
              hotkey="r"
              onPress={async () => {
                await update($, blocked, () => null)
                await start($, lastMode)
              }}
            >
              Retry
            </Button>
          )}
          <Button key="dismiss-rule" dimColor onPress={() => update($, blocked, () => null)}>
            Dismiss
          </Button>
        </Box>
      </Box>
    ) : null

    if (now === 'playing') {
      const shape = await read($, size)
      const line = await read($, status)
      if (!shape) return <Text dimColor>Starting…</Text>
      const text = line
        ? [line.room, line.aim ? `aiming at ${line.aim}` : '', line.last].filter(Boolean).join(' · ') || 'LIVE: this is your house'
        : 'LIVE: this is your house'
      return (
        <Box flexDirection="column">
          <Raster key="screen" columns={shape.columns} rows={shape.rows} cells={frame ?? blank(shape.columns, shape.rows)} />
          <Client
            key="keys"
            module="./keys.tsx"
            width={shape.columns}
            props={{ text, hint: 'Click here to play. Arrows/WASD move, Space fires, E uses, Y/N answers, M menu, Esc gives the keys back.' }}
          />
          <Box flexDirection="row" gap={1}>
            <Button key="stop" hotkey="q" onPress={() => stop($)}>Stop</Button>
            {said ? <Text dimColor wrap="truncate-end">{said}</Text> : null}
          </Box>
          {help}
        </Box>
      )
    }

    const busy = now === 'checking' || now === 'downloading' || now === 'reading' || now === 'building'
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>house.wad{home ? `: ${home}` : ''}</Text>
        <Text wrap="wrap">
          Your home as a Doom level. Rooms are your areas; lamps, plugs and screens are where they really are. Shoot a lamp and it
          turns off for real. Use a door and its lock opens, after a Y/N. House problems are the monsters.
        </Text>
        {busy ? <Text color="yellow">{said ?? 'Working…'}</Text> : said && !refusal ? <Text color={now === 'failed' ? 'red' : undefined} wrap="wrap">{said}</Text> : null}
        {help}
        {busy ? null : (
          <Box flexDirection="row" gap={1}>
            <Button key="play" variant="primary" hotkey="p" onPress={() => start($, 'real')}>Play for real</Button>
            <Button key="practice" hotkey="t" onPress={() => start($, 'practice')}>Practice (nothing changes)</Button>
          </Box>
        )}
        <Text dimColor wrap="wrap">
          Needs Node 18 or newer. The first game downloads its data once (about 19 MB, Freedoom's free game data). Built from
          github.com/Vortitron/housewad.
        </Text>
      </Box>
    )
  })

  // Keys from the strip under the screen, to the game.
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'keys') return next(e)
    const data = e.data as { keys?: unknown }
    const keys = Array.isArray(data?.keys) ? data.keys.filter((k): k is string => typeof k === 'string' && k.length > 0) : []
    if (keys.length > 0) await send($, keys.map(key => ({ t: 'key', key })))
    return {}
  })
}

// ---------------------------------------------------------------- the game

async function start($: EngineInterface, mode: 'real' | 'practice') {
  lastMode = mode
  stopRequested = false
  await update($, blocked, () => null)
  frame = null
  await update($, status, () => null)
  await update($, size, () => null)
  try {
    await setPhase($, 'checking', 'Looking for Node…')
    let why = ''
    const node = await $.process.run(['node', '--version'], { timeoutMs: 10_000 }).catch(error => {
      why = firstLine(String(error)) ?? ''
      return null
    })
    const found = node && node.exitCode === 0 ? node.stdout.trim() : ''
    const major = Number(/^v(\d+)/.exec(found)?.[1] ?? 0)
    if (major < 18) {
      return fail($, `house.wad needs Node 18 or newer on this computer (nodejs.org), then press Play again.${found ? ` This one is ${found}.` : why ? ` (${why})` : ''}`)
    }

    const home = await $.env.get('HOME')
    if (!home) return fail($, 'There is no HOME folder to keep the game data in.')
    const dir = `${home}/.cache/vome-doom/${HOUSEWAD_VERSION}`
    const missing: string[] = []
    for (const file of FILES) if (!(await $.fs.exists(`${dir}/${file}`))) missing.push(file)
    if (missing.length > 0 && !(await download($, dir, missing))) return

    server = await findServer($)
    if (!server) return fail($, 'Connect Home Assistant through Vome first: /plugin install vome-connect --marketplace Vortitron/home-assistant-mcp')
    await setPhase($, 'reading', 'Reading your home…')
    const snapshot = await readHome($, server)
    if (!snapshot) return
    await update($, homeName, () => snapshot.location_name)

    await setPhase($, 'building', `Building ${snapshot.location_name} as a level…`)
    inputDir = `${home}/.cache/vome-doom/run-${Date.now()}`
    await $.fs.write(`${inputDir}/.keep`, '')
    void run($, dir, mode, snapshot)
  } catch (error) {
    await fail($, `Could not start: ${String(error)}`)
  }
}

async function run($: EngineInterface, dir: string, mode: 'real' | 'practice', snapshot: Snapshot) {
  const argv = [
    'node', `${dir}/housewad-term.mjs`, '--assets', dir, '--input', inputDir!, '--mode', mode,
    '--columns', String(room.columns), '--rows', String(room.rows),
  ]
  let pending = ''
  let isPlaying = false
  try {
    for await (const piece of $.process.spawn({ argv, input: JSON.stringify(snapshot) })) {
      if (stopRequested) break
      if (piece.stream !== 'stdout') continue
      pending += piece.text
      let at = pending.indexOf('\n')
      while (at >= 0) {
        const line = pending.slice(0, at)
        pending = pending.slice(at + 1)
        at = pending.indexOf('\n')
        let message: Record<string, unknown>
        try {
          message = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (message.t === 'frame' && typeof message.cells === 'string') {
          frame = message.cells
          const shape = (await read($, size))
          if (isPlaying && shape) void $.ui.blit({ requestId: PANE, key: 'screen', cells: frame, columns: shape.columns, rows: shape.rows })
        } else if (message.t === 'ready') {
          await update($, size, () => ({ columns: Number(message.columns), rows: Number(message.rows) }))
          await setPhase($, 'playing', mode === 'real' ? null : 'Practice: nothing in the house changes.')
          isPlaying = true
        } else if (message.t === 'status') {
          await update($, status, () => ({ room: String(message.room ?? ''), aim: String(message.aim ?? ''), last: String(message.last ?? ''), world: String(message.world ?? '') }))
        } else if (message.t === 'call') {
          void act($, message)
        } else if (message.t === 'error') {
          await fail($, String(message.text ?? 'The game stopped.'))
          return
        }
      }
    }
  } catch (error) {
    await fail($, `The game stopped: ${String(error)}`)
    return
  }
  if ((await read($, phase)) !== 'failed') await setPhase($, 'ended', stopRequested ? null : 'The game ended.')
}

/** A call the game makes on the house: through the MCP, then the entity's new state back to it. */
async function act($: EngineInterface, message: Record<string, unknown>) {
  const id = message.id
  const data = (message.data && typeof message.data === 'object' ? message.data : {}) as Record<string, unknown>
  let error: string | null = null
  try {
    const result = await $.mcp.call(server!, 'ha_call_service', { domain: message.domain, service: message.service, data })
    if (result.isError) error = firstLine(result.content.map(block => block.text ?? '').join('\n')) ?? 'refused'
  } catch (thrown) {
    if (/auto mode|classifier|permission|denied/i.test(String(thrown))) {
      error = 'auto mode refused it'
      await update($, blocked, () => ({ server: server!, tool: 'ha_call_service' }))
    } else {
      error = firstLine(String(thrown)) ?? 'failed'
    }
  }
  await send($, [{ t: 'reply', id, error }])
  const entity = typeof data.entity_id === 'string' ? data.entity_id : null
  if (!entity || error) return
  // The device answers in its own time: look twice.
  for (const wait of [700, 2500]) {
    await $.clock.sleep(wait)
    const state = await stateOf($, entity)
    if (state) await send($, [{ t: 'state', entity_id: entity, state }])
  }
}

async function stop($: EngineInterface) {
  stopRequested = true
  await send($, [{ t: 'quit' }])
  await setPhase($, 'ended', null)
}

/** Messages to the game: one small file each batch, read in name order and deleted by the game. */
async function send($: EngineInterface, messages: unknown[]) {
  if (!inputDir) return
  sequence += 1
  await $.fs.write(`${inputDir}/${String(sequence).padStart(9, '0')}.json`, messages.map(m => JSON.stringify(m)).join('\n') + '\n')
}

async function download($: EngineInterface, dir: string, files: string[]): Promise<boolean> {
  await setPhase($, 'downloading', 'Downloading the game data (once)…')
  // Node fetches, so nothing but Node is needed; each file lands whole or not at all.
  const script = [
    "const fs=require('fs'),path=require('path');",
    'const [dir,base,...files]=process.argv.slice(1);',
    '(async()=>{fs.mkdirSync(dir,{recursive:true});',
    'for(const f of files){const r=await fetch(base+f);if(!r.ok)throw new Error(f+": HTTP "+r.status);',
    "const total=Number(r.headers.get('content-length'))||0;const parts=[];let got=0,n=0;",
    'for await(const c of r.body){parts.push(c);got+=c.length;if(++n%200===0)console.log(JSON.stringify({file:f,got,total}))}',
    "fs.writeFileSync(path.join(dir,f+'.part'),Buffer.concat(parts));fs.renameSync(path.join(dir,f+'.part'),path.join(dir,f));",
    'console.log(JSON.stringify({file:f,done:true}))}})().catch(e=>{console.error(e.message);process.exit(1)})',
  ].join('')
  let errors = ''
  try {
    const fetching = $.process.spawn({ argv: ['node', '-e', script, dir, RELEASE, ...files] })
    for await (const piece of fetching) {
      if (piece.stream === 'stderr') {
        errors += piece.text
        continue
      }
      for (const line of piece.text.split('\n')) {
        try {
          const p = JSON.parse(line) as { file?: string; got?: number; total?: number }
          const total = p.total ?? 0
          if (p.file && total > 0) await update($, note, () => `Downloading ${p.file}: ${Math.round((p.got ?? 0) / 1e6)} of ${Math.round(total / 1e6)} MB`)
        } catch {
          // a partial line
        }
      }
    }
  } catch (error) {
    errors += String(error)
  }
  for (const file of files) {
    if (!(await $.fs.exists(`${dir}/${file}`))) {
      await fail($, `Could not download the game data (${firstLine(errors) ?? file}). Check the connection and press Play again.`)
      return false
    }
  }
  return true
}

// ---------------------------------------------------------------- the home

type Snapshot = {
  location_name: string
  areas: unknown[]
  devices: unknown[]
  entities: unknown[]
  states: unknown[]
}

async function findServer($: EngineInterface): Promise<string | null> {
  const names = (await $.tool.list()).map(tool => /^mcp__(.+)__ha_list_areas$/.exec(tool.name)?.[1]).filter((s): s is string => !!s)
  return names.find(name => /vome/i.test(name)) ?? names[0] ?? null
}

async function readHome($: EngineInterface, from: string): Promise<Snapshot | null> {
  let location: string | null = null
  const ask = async (tool: string, args: Record<string, unknown>) => {
    try {
      const result = await $.mcp.call(from, tool, args)
      const text = result.content.map(block => block.text ?? '').join('\n')
      location = location ?? /\[vome-instance\][^\n]*home="([^"]+)"/.exec(text)?.[1] ?? null
      if (result.isError) throw new Error(firstLine(text) ?? `${tool} failed`)
      return parseJson(text) ?? {}
    } catch (error) {
      if (/auto mode|classifier|permission|denied/i.test(String(error))) {
        await update($, blocked, () => ({ server: from, tool }))
        throw new Error(`auto mode refused ${tool}.`)
      }
      throw error
    }
  }
  try {
    const areas = ((await ask('ha_list_areas', {})).areas as unknown[]) ?? []
    const devices = ((await ask('ha_list_devices', {})).devices as unknown[]) ?? []
    const entities: unknown[] = []
    const states: unknown[] = []
    for (const domain of DOMAINS) {
      await update($, note, () => `Reading your home: ${domain.replace(/_/g, ' ')}…`)
      entities.push(...(((await ask('ha_get_entity_registry', { domain, include_disabled: false })).entities as unknown[]) ?? []))
      states.push(...(((await ask('ha_list_entities', { domain, include_attributes: true, limit: 500 })).entities as unknown[]) ?? []))
    }
    return { location_name: location ?? 'Home', areas, devices, entities, states }
  } catch (error) {
    await fail($, `Could not read your home: ${firstLine(String(error).replace(/^Error: /, ''))}`)
    return null
  }
}

async function stateOf($: EngineInterface, entity: string): Promise<Record<string, unknown> | null> {
  try {
    const result = await $.mcp.call(server!, 'ha_get_state', { entity_ids: [entity] })
    const body = parseJson(result.content.map(block => block.text ?? '').join('\n'))
    const row = Array.isArray(body?.entities) ? (body!.entities as Record<string, unknown>[])[0] : null
    const held = row && row.state && typeof row.state === 'object' ? (row.state as Record<string, unknown>) : null
    return held ? { entity_id: entity, ...held } : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- small things

async function setPhase($: EngineInterface, next: Phase, text: string | null) {
  await update($, phase, () => next)
  await update($, note, () => text)
}

async function fail($: EngineInterface, text: string) {
  await setPhase($, 'failed', text)
}

/** A black screen of the right size, until the first frame. */
function blank(columns: number, rows: number): string {
  const words = new Uint32Array(columns * rows * 3)
  for (let i = 0; i < columns * rows; i++) words[i * 3] = 0x2580
  return base64(new Uint8Array(words.buffer))
}

function base64(bytes: Uint8Array): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += A[(n >> 18) & 63]! + A[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? A[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? A[n & 63]! : '='
  }
  return out
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
