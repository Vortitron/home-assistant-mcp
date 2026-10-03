import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const STAMP = '\n[vome-instance] target=748d339f-ae52-4cc3-81d7-f7c93f1a8852 home="Home" ha=2026.9.3 components=158'
const tool = (name: string) => name as 'mcp__vome__ha_get_automation'
const PANE_PROPS = { title: 'Dashboard', isFocused: false, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} }

// HouseFly Demo's Overview, trimmed: what ha_get_dashboard returned on 3 Oct 2026.
const CONFIG = {
  title: 'HouseFly',
  views: [
    {
      title: 'The house',
      path: 'house',
      cards: [
        { type: 'custom:housefly-overlay', entry_id: '01M2' },
        { type: 'markdown', content: 'Right now: *{{ states("sensor.housefly_mode") }}*' },
        { type: 'entities', title: 'Lights — both flies may change these', entities: ['light.kitchen_2', 'switch.kitchen_socket'] },
        { type: 'entities', title: '🪰 Make it panic', entities: [{ entity: 'input_number.approach_distance', name: 'How close you are' }] },
        {
          type: 'entities',
          title: 'Interfere with it',
          entities: [
            {
              type: 'button',
              name: 'Wipe its memory',
              tap_action: {
                action: 'perform-action',
                perform_action: 'fly_house.reset_memory',
                target: { entity_id: 'sensor.housefly_mode' },
                confirmation: { text: 'Wipe everything this fly has learned about the house?' },
              },
            },
          ],
        },
        { type: 'history-graph', title: 'Arousal', hours_to_show: 48, entities: [{ entity: 'sensor.housefly_arousal', name: 'HouseFly' }] },
        { type: 'picture-entity', entity: 'camera.anasmotet_sydvast' },
      ],
    },
    { title: 'History', path: 'history', cards: [] },
  ],
}
const STATES: Record<string, { state: string; attributes: Record<string, unknown> }> = {
  'light.kitchen_2': { state: 'on', attributes: { friendly_name: 'Kitchen', brightness: 178 } },
  'switch.kitchen_socket': { state: 'off', attributes: { friendly_name: 'Kitchen socket' } },
  'input_number.approach_distance': { state: '5.0', attributes: { min: 0.5, max: 5, step: 0.1, unit_of_measurement: 'm' } },
  'sensor.housefly_arousal': { state: '0.42', attributes: {} },
}

// VomeHome's dashboard, trimmed: button cards in a stack.
const STACK = {
  title: 'VomeHome',
  views: [{ title: 'Home', cards: [{ type: 'vertical-stack', cards: [
    { type: 'button', name: 'Reset to Home Assistant defaults', tap_action: { action: 'perform-action', perform_action: 'vomesync.reset' } },
    { type: 'button', name: 'Make HA Overview default', tap_action: { action: 'perform-action', perform_action: 'vomesync.default' } },
  ] }] }],
}

/** The first refresh runs after Claude's call has answered: let it land before looking. */
const settle = () => new Promise(resolve => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout(() => resolve(undefined), 120))

const reply = (body: unknown) => {
  const text = JSON.stringify(body) + STAMP
  return { result: [{ type: 'text', text }], text }
}
const mount = ($: Engine) =>
  $.ui.mount({ plugin: 'vome-dash', surface: 'vscode', component: 'Pane', requestId: 'vome-dash', props: PANE_PROPS, viewport: { columns: 160, rows: 80 } })

/** Vome's hourly limit hit: every state read answers "not found". */
let LIMITED = false
/** An MCP from before ha_view_snapshot. */
let NO_SNAPSHOT = false
/** The MCP can watch live states, and how many waits the pane has made. */
let WATCH = false
let WATCH_READS = 0

function setup(on: On) {
  // Every test starts in the same house: a press in one leaves no light off for the next.
  STATES['light.kitchen_2'] = { state: 'on', attributes: { friendly_name: 'Kitchen', brightness: 178 } }
  LIMITED = false
  NO_SNAPSHOT = false
  WATCH = false
  WATCH_READS = 0
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', { tool: tool('mcp__vome__ha_get_dashboard') }, (_$, e) =>
    (e as unknown as { url_path?: string }).url_path === 'vomehome' ? reply({ url_path: 'vomehome', config: STACK }) : reply({ url_path: 'lovelace', config: CONFIG }),
  )
  on('mcp.call', (_$, e) => {
    calls.push({ tool: e.tool, args: e.args })
    const text = (body: unknown) => ({ value: { content: [{ type: 'text', text: (typeof body === 'string' ? body : JSON.stringify(body)) + STAMP }], isError: false } })
    if (e.tool === 'ha_watch_states') {
      // A live watch: the whole picture, then one change, then the watch ends.
      if (!WATCH) return { value: { content: [{ type: 'text', text: 'Unknown tool: ha_watch_states' }], isError: true } }
      WATCH_READS += 1
      if (WATCH_READS === 1) return text({ cursor: 1, full: true, states: [{ entity_id: 'light.kitchen_2', state: 'on', attributes: { brightness: 178 } }], done: false, error: null })
      if (WATCH_READS === 2) return text({ cursor: 2, full: false, states: [{ entity_id: 'light.kitchen_2', state: 'off', attributes: {} }], done: false, error: null })
      return text({ cursor: 2, full: false, states: [], done: true, error: 'closed' })
    }
    if (e.tool === 'ha_view_snapshot') {
      if (NO_SNAPSHOT) return { value: { content: [{ type: 'text', text: 'Unknown tool: ha_view_snapshot' }], isError: true } }
      const a = e.args as { entity_ids?: string[]; templates?: Record<string, string>; history?: Array<{ key: string; entity_ids: string[] }>; frames?: Array<{ key: string; entity_id: string }> }
      const states = Object.fromEntries((a.entity_ids ?? []).map(id => [id, LIMITED ? null : (STATES[id] ?? { state: 'unknown', attributes: {} })]))
      const templates = Object.fromEntries(Object.keys(a.templates ?? {}).map(k => [k, 'Right now: *forage*']))
      const history = Object.fromEntries((a.history ?? []).map(h => [h.key, h.entity_ids.map(id => ({ entity_id: id, unit: null, points: [0.1, 0.4, 0.9, 0.3].map((v, i) => [`t${i}`, v]) }))]))
      const rgb = btoa(String.fromCharCode(...[255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255]))
      const frames = Object.fromEntries((a.frames ?? []).map(f => [f.key, { width: 4, height: 2, rgb }]))
      return text({ at: 'now', states, templates, history, frames })
    }
    if (e.tool === 'ha_get_state') {
      const ids = e.args.entity_ids as string[]
      if (LIMITED) return text({ entities: ids.map(id => ({ entity_id: id, found: false, state: null })) })
      // The real shape: the whole state object nested under `state`.
      return text({ entities: ids.map(id => ({ entity_id: id, found: true, state: { entity_id: id, ...(STATES[id] ?? { state: 'unknown', attributes: {} }) } })) })
    }
    if (e.tool === 'ha_render_template') return text('Right now: *forage*')
    if (e.tool === 'ha_list_dashboards') return text({ dashboards: [{ url_path: 'lovelace', title: 'Overview' }, { url_path: 'claude-lights', title: 'Lights' }] })
    if (e.tool === 'ha_get_dashboard' && e.args.url_path === 'lovelace') return text({ url_path: 'lovelace', config: CONFIG })
    if (e.tool === 'ha_get_dashboard') return text({ url_path: e.args.url_path, config: { title: 'Lights', views: [{ title: 'Home', cards: [{ type: 'entities', title: 'Bulbs', entities: ['light.kitchen_2'] }] }] } })
    if (e.tool === 'ha_get_history' && e.args.max_points) return text({ series: [{ entity_id: 'sensor.housefly_arousal', unit: null, points: [0.1, 0.4, 0.9, 0.3].map((v, i) => [`t${i}`, v]) }] })
    if (e.tool === 'ha_get_history') return text({ series: [[0.1, 0.4, 0.9, 0.3].map(v => ({ entity_id: 'sensor.housefly_arousal', state: String(v) }))] })
    if (e.tool === 'ha_camera_frame') {
      // A 4 x 2 frame: red on top, blue below.
      const rgb = btoa(String.fromCharCode(...[255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255]))
      return text({ entity_id: e.args.entity_id, width: 4, height: 2, rgb })
    }
    if (e.tool === 'ha_call_service') {
      if (e.args.domain === 'light') STATES['light.kitchen_2'] = { state: 'off', attributes: { friendly_name: 'Kitchen' } }
      // A socket whose device is slow: Home Assistant takes the call, nothing has changed yet.
      return text({ changed: [] })
    }
    return text({})
  })
  return calls
}

test('a dashboard Claude reads appears working: live states, Markdown rendered by the home, sparklines', async ($, on) => {
  setup(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.tool.call({ tool: tool('mcp__vome__ha_get_dashboard'), url_path: 'lovelace' } as never)
  await settle()
  const ui = await mount($)
  expect((await ui.find({ text: 'HouseFly' })) !== undefined).toBe(true)
  expect((await ui.find({ text: /Lights — both flies may change these/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /^on 70%$/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /forage/ })) !== undefined).toBe(true)
  // A history graph is a chart in braille, three lines high, not a sparkline.
  expect((await ui.find({ text: /[\u2801-\u28ff]{5,}/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /housefly-overlay · drawn by Home Assistant/ })) === undefined).toBe(true)
  expect((await ui.find({ text: /object Object/ })) === undefined).toBe(true)
})

test('pressing a light turns it off through Home Assistant, and the pane reads it straight back', async ($, on) => {
  const calls = setup(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.tool.call({ tool: tool('mcp__vome__ha_get_dashboard'), url_path: 'lovelace' } as never)
  await settle()
  const ui = await mount($)
  await ui.press({ key: 'v0/c2/r0/toggle' })
  const press = calls.find(c => c.tool === 'ha_call_service')
  expect(press?.args).toEqual({ domain: 'light', service: 'toggle', target: { entity_id: 'light.kitchen_2' } })
  expect((await ui.find({ text: /^off$/ })) !== undefined).toBe(true)
})

test('a button that asks first runs only on the second press', async ($, on) => {
  const calls = setup(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.tool.call({ tool: tool('mcp__vome__ha_get_dashboard'), url_path: 'lovelace' } as never)
  await settle()
  const ui = await mount($)
  await ui.press({ key: 'v0/c4/r0' })
  expect(calls.some(c => c.tool === 'ha_call_service')).toBe(false)
  expect((await ui.find({ text: /Wipe everything this fly has learned about the house\? Press again\./ })) !== undefined).toBe(true)
  await ui.press({ key: 'v0/c4/r0' })
  expect(calls.find(c => c.tool === 'ha_call_service')?.args).toEqual({
    domain: 'fly_house',
    service: 'reset_memory',
    target: { entity_id: 'sensor.housefly_mode' },
  })
})

test('a slider steps by a tenth of its range', async ($, on) => {
  const calls = setup(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.tool.call({ tool: tool('mcp__vome__ha_get_dashboard'), url_path: 'lovelace' } as never)
  await settle()
  const ui = await mount($)
  await ui.press({ key: 'v0/c3/r0/down' })
  expect(calls.find(c => c.tool === 'ha_call_service')?.args).toEqual({
    domain: 'input_number',
    service: 'set_value',
    target: { entity_id: 'input_number.approach_distance' },
    data: { value: 4.5 },
  })
})

test("a save lights the card it changed", async ($, on) => {
  const clock = mock.clock(on)
  setup(on)
  on('tool.call', { tool: tool('mcp__vome__ha_save_dashboard') }, () => reply({ saved: true }))
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.tool.call({ tool: tool('mcp__vome__ha_get_dashboard'), url_path: 'lovelace' } as never)
  await settle()
  const changed = JSON.parse(JSON.stringify(CONFIG))
  changed.views[0].cards[2].title = 'Lights'
  await $.tool.call({ tool: tool('mcp__vome__ha_save_dashboard'), url_path: 'lovelace', config: changed } as never)
  void clock
  const ui = await mount($)
  const title = await ui.find({ text: 'Lights' })
  expect(title !== undefined).toBe(true)
})

test('a press shows it was taken, and the state it led to', async ($, on) => {
  setup(on)
  STATES['light.kitchen_2'] = { state: 'on', attributes: { friendly_name: 'Kitchen', brightness: 178 } }
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.tool.call({ tool: tool('mcp__vome__ha_get_dashboard'), url_path: 'lovelace' } as never)
  await settle()
  const ui = await mount($)
  await ui.press({ key: 'v0/c2/r0/toggle' })
  expect((await ui.find({ text: '✓' })) !== undefined).toBe(true)
  // The socket's device has not changed yet: the press is taken, and the pane says it is waiting.
  await ui.press({ key: 'v0/c2/r1/toggle' })
  expect((await ui.find({ text: /sent, waiting/ })) !== undefined).toBe(true)
})

test("the home's dashboards are a sidebar, and one press opens another", async ($, on) => {
  const calls = setup(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.tool.call({ tool: tool('mcp__vome__ha_get_dashboard'), url_path: 'lovelace' } as never)
  await settle()
  const ui = await mount($)
  // Hidden until asked for, then gone again once one is picked.
  expect((await ui.find({ text: 'Dashboards' })) === undefined).toBe(true)
  await ui.press({ key: 'menu' })
  expect((await ui.find({ text: 'Dashboards' })) !== undefined).toBe(true)
  await ui.press({ key: 'side-claude-lights' })
  expect((await ui.find({ text: 'Dashboards' })) === undefined).toBe(true)
  expect(calls.some(c => c.tool === 'ha_get_dashboard' && c.args.url_path === 'claude-lights')).toBe(true)
  expect((await ui.find({ text: 'Bulbs' })) !== undefined).toBe(true)
})

test("the hourly limit pauses the reads and says so, keeping the last states", async ($, on) => {
  setup(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.tool.call({ tool: tool('mcp__vome__ha_get_dashboard'), url_path: 'lovelace' } as never)
  await settle()
  const ui = await mount($)
  LIMITED = true
  await ui.press({ key: 'reload' })
  expect((await ui.find({ text: /hourly limit/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /not found/ })) === undefined).toBe(true)
})

test('a camera card is the camera\'s picture, in half blocks, in the terminal', async ($, on) => {
  const calls = setup(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.tool.call({ tool: tool('mcp__vome__ha_get_dashboard'), url_path: 'lovelace' } as never)
  await settle()
  const terminal = await $.ui.mount({ plugin: 'vome-dash', surface: 'terminal', component: 'Pane', requestId: 'vome-dash', props: PANE_PROPS, viewport: { columns: 160, rows: 80 } })
  // One call for the whole view: states, the template, the chart in a few points, the camera.
  const snap = calls.find(c => c.tool === 'ha_view_snapshot')!
  expect((snap.args.frames as Array<{ entity_id: string }>)[0]!.entity_id).toBe('camera.anasmotet_sydvast')
  expect(typeof (snap.args.history as Array<{ max_points: number }>)[0]!.max_points).toBe('number')
  expect(calls.some(c => c.tool === 'ha_get_state' || c.tool === 'ha_get_history')).toBe(false)
  expect((await terminal.find({ type: 'Raster', key: 'frame-v0/c6' })) !== undefined).toBe(true)
})

test('a card inside a stack fits inside it, and a button card does not repeat its name', async ($, on) => {
  setup(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.tool.call({ tool: tool('mcp__vome__ha_get_dashboard'), url_path: 'vomehome' } as never)
  await settle()
  const ui = await mount($)
  const boxes = (await ui.findAll({ type: 'Box' })).map(b => (b as unknown as { props: { width?: number; borderStyle?: string } }).props).filter(p => p.borderStyle === 'round' && typeof p.width === 'number')
  const widths = boxes.map(p => p.width!)
  expect(widths.length).toBe(3)
  expect(Math.max(...widths) - Math.min(...widths)).toBe(4)
  // The button's label, but no title line of the same words above it.
  expect((await ui.find({ text: /▸ Reset to Home Assistant defaults/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /^Reset to Home Assistant defaults$/ })) === undefined).toBe(true)
})

test('an MCP from before the snapshot gets the separate calls', async ($, on) => {
  const calls = setup(on)
  NO_SNAPSHOT = true
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.tool.call({ tool: tool('mcp__vome__ha_get_dashboard'), url_path: 'lovelace' } as never)
  await settle()
  const ui = await mount($)
  expect(calls.some(c => c.tool === 'ha_get_state')).toBe(true)
  expect((await ui.find({ text: /^on 70%$/ })) !== undefined).toBe(true)
})

test('a live watch brings changes by itself, and the snapshot stops asking for states', async ($, on) => {
  const calls = setup(on)
  WATCH = true
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.tool.call({ tool: tool('mcp__vome__ha_get_dashboard'), url_path: 'lovelace' } as never)
  await settle()
  const ui = await mount($)
  expect(WATCH_READS).toBeGreaterThanOrEqual(2)
  expect((await ui.find({ text: /^off$/ })) !== undefined).toBe(true)
  const watched = calls.find(c => c.tool === 'ha_watch_states')!
  expect((watched.args.entity_ids as string[]).includes('light.kitchen_2')).toBe(true)
})
