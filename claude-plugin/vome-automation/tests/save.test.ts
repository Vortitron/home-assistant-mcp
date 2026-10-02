import { expect, test } from 'claude-code/testing'

const STAMP = '\n[vome-instance] target=748d339f-ae52-4cc3-81d7-f7c93f1a8852 home="Home" ha=2026.9.3 components=158'
const BEFORE = {
  id: 'demo',
  alias: 'Demo',
  triggers: [{ trigger: 'state', entity_id: 'binary_sensor.kitchen_occupied', to: 'on' }],
  actions: [{ action: 'light.turn_on', target: { entity_id: 'light.kitchen' }, data: { brightness_pct: 75 } }],
}
const AFTER = { ...BEFORE, actions: [{ ...BEFORE.actions[0], data: { brightness_pct: 70 } }] }
const PANE_PROPS = {
  title: 'Automation',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

test('a save rewrites header lines without moving the tree, and lights the changed line', async ($, on) => {
  on('tool.call', { tool: 'mcp__vome__ha_get_automation' }, () => {
    const text = JSON.stringify({ id: 'demo', config: BEFORE }) + STAMP
    return { result: [{ type: 'text', text }], text }
  })
  on('tool.call', { tool: 'mcp__vome__ha_set_automation' }, () => {
    const text = JSON.stringify({ saved: true }) + STAMP
    return { result: [{ type: 'text', text }], text }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))

  await $.tool.call({ tool: 'mcp__vome__ha_get_automation', automation: 'demo' })
  const ui = await $.ui.mount({
    plugin: 'vome-automation',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'vome-automation',
    props: PANE_PROPS,
    viewport: { columns: 160, rows: 50 },
  })
  const whenAt = async () => (await ui.findAll({ type: 'Text' })).findIndex(t => t.text === 'WHEN')
  // With the bulbs off the header stays text, so the tree's place can be counted in lines.
  await ui.press({ key: 'bulbs' })

  const before = await whenAt()
  await $.tool.call({ tool: 'mcp__vome__ha_set_automation', automation_id: 'demo', config: AFTER })
  const after = await whenAt()
  expect(before > 0).toBe(true)
  expect(after).toBe(before)

  const changed = (await ui.findAll({ type: 'Text', text: /brightness_pct 70/ })).find(
    t => t.props.backgroundColor !== undefined,
  )
  expect(changed !== undefined).toBe(true)
})

test('the strip swims while an automation is worked on, acts out a light, and only on the terminal', async ($, on) => {
  on('tool.call', { tool: 'mcp__vome__ha_get_automation' }, () => {
    const text = JSON.stringify({ id: 'demo', config: BEFORE }) + STAMP
    return { result: [{ type: 'text', text }], text }
  })
  on('tool.call', { tool: 'mcp__vome__ha_call_service' }, () => {
    const text = JSON.stringify({ changed: ['light.living_room'] }) + STAMP
    return { result: [{ type: 'text', text }], text }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.tool.call({ tool: 'mcp__vome__ha_get_automation', automation: 'demo' })

  const mount = (surface: 'terminal' | 'vscode') =>
    $.ui.mount({
      plugin: 'vome-automation',
      surface,
      component: 'Pane',
      requestId: 'vome-automation',
      props: PANE_PROPS,
      viewport: { columns: 160, rows: 50 },
    })
  const terminal = await mount('terminal')
  const vscode = await mount('vscode')
  // Having just read it, Claude is working on it: the swimmers have the header.
  expect((await terminal.find({ type: 'Raster' })) !== undefined).toBe(true)

  // Switching a light on is acted out: a bulb comes in over the top of the pane.
  await $.tool.call({ tool: 'mcp__vome__ha_call_service', domain: 'light', service: 'turn_on', target: { entity_id: 'light.living_room' } })
  expect((await terminal.find({ type: 'Raster' })) !== undefined).toBe(true)
  expect((await terminal.find({ type: 'Text', text: 'Demo' })) === undefined).toBe(true)
  expect((await vscode.find({ type: 'Raster' })) === undefined).toBe(true)
  expect((await vscode.find({ type: 'Text', text: 'Demo' })) !== undefined).toBe(true)

  // A service that is not a light plays nothing.
  await $.tool.call({ tool: 'mcp__vome__ha_call_service', domain: 'notify', service: 'notify', data: { message: 'hi' } })
})

test('an empty pane shows the swimmers as an intro, on the terminal only', async $ => {
  for (const surface of ['terminal', 'vscode'] as const) {
    const ui = await $.ui.mount({
      plugin: 'vome-automation',
      surface,
      component: 'Pane',
      requestId: 'vome-automation',
      props: PANE_PROPS,
      viewport: { columns: 160, rows: 50 },
    })
    expect((await ui.find({ type: 'Raster' })) !== undefined).toBe(surface === 'terminal')
    expect((await ui.find({ type: 'Text', text: /No automation yet/ })) !== undefined).toBe(true)
  }
})
