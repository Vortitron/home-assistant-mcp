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

const reply = (body: unknown) => {
  const text = JSON.stringify(body) + STAMP
  return { result: [{ type: 'text', text }], text }
}
const mount = ($: Engine) =>
  $.ui.mount({ plugin: 'vome-dash', surface: 'vscode', component: 'Pane', requestId: 'vome-dash', props: PANE_PROPS, viewport: { columns: 160, rows: 80 } })

function setup(on: On) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', { tool: tool('mcp__vome__ha_get_dashboard') }, () => reply({ url_path: 'lovelace', config: CONFIG }))
  on('mcp.call', (_$, e) => {
    calls.push({ tool: e.tool, args: e.args })
    const text = (body: unknown) => ({ value: { content: [{ type: 'text', text: (typeof body === 'string' ? body : JSON.stringify(body)) + STAMP }], isError: false } })
    if (e.tool === 'ha_get_state') {
      const ids = e.args.entity_ids as string[]
      return text({ entities: ids.map(id => ({ entity_id: id, found: true, ...(STATES[id] ?? { state: 'unknown', attributes: {} }) })) })
    }
    if (e.tool === 'ha_render_template') return text('Right now: *forage*')
    if (e.tool === 'ha_get_history') return text({ series: [[0.1, 0.4, 0.9, 0.3].map(v => ({ entity_id: 'sensor.housefly_arousal', state: String(v) }))] })
    if (e.tool === 'ha_call_service') {
      if (e.args.domain === 'light') STATES['light.kitchen_2'] = { state: 'off', attributes: { friendly_name: 'Kitchen' } }
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
  const ui = await mount($)
  expect((await ui.find({ text: 'HouseFly' })) !== undefined).toBe(true)
  expect((await ui.find({ text: /Lights — both flies may change these/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /^on 70%$/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /forage/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /[▁▂▃▄▅▆▇█]{3,}/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /housefly-overlay · drawn by Home Assistant/ })) === undefined).toBe(true)
})

test('pressing a light turns it off through Home Assistant, and the pane reads it straight back', async ($, on) => {
  const calls = setup(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.tool.call({ tool: tool('mcp__vome__ha_get_dashboard'), url_path: 'lovelace' } as never)
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
  const changed = JSON.parse(JSON.stringify(CONFIG))
  changed.views[0].cards[2].title = 'Lights'
  await $.tool.call({ tool: tool('mcp__vome__ha_save_dashboard'), url_path: 'lovelace', config: changed } as never)
  void clock
  const ui = await mount($)
  const title = await ui.find({ text: 'Lights' })
  expect(title !== undefined).toBe(true)
})
