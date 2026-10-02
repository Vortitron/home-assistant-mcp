import { expect, test } from 'claude-code/testing'

// A real ha_get_automation reply from the demo home, trimmed: JSON, then the vome MCP's stamp line.
const CONFIG = {
  id: 'demo_lights_follow_people',
  alias: 'Demo: lights follow the simulated occupant',
  triggers: [{ trigger: 'state', entity_id: ['binary_sensor.kitchen_occupied'], to: 'on', id: 'arrive' }],
  actions: [{ action: 'light.turn_on', target: { entity_id: 'light.kitchen' }, data: { brightness_pct: 75 } }],
  mode: 'parallel',
}
const REPLY =
  JSON.stringify({ id: CONFIG.id, config: CONFIG }, null, 2) +
  '\n[vome-instance] target=748d339f-ae52-4cc3-81d7-f7c93f1a8852 home="Home" ha=2026.9.3 components=158'

const PANE_PROPS = {
  title: 'Automation',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 36 },
  view: {},
}

for (const placed of [true, false]) {
  test(`a read automation reaches the pane (pane ${placed ? 'placed' : 'refused'})`, async ($, on) => {
    on('tool.call', { tool: 'mcp__vome__ha_get_automation' }, () => ({
      result: [{ type: 'text', text: REPLY }],
      text: REPLY,
    }))
    on('ui.log', () => ({ value: undefined }))
    on('ui.open', () => (placed ? { value: { isPlaced: true } } : { value: { isPlaced: false, reason: 'no panes here' } }))

    const ran = await $.tool.call({ tool: 'mcp__vome__ha_get_automation', automation: CONFIG.id })
    expect(ran.deny).toBe(undefined)

    for (const surface of ['terminal', 'vscode', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'vome-automation',
        surface,
        component: 'Pane',
        requestId: 'vome-automation',
        props: PANE_PROPS,
        viewport: { columns: 160, rows: 40 },
      })
      // On the terminal the swimmers hold the title's line while Claude works on it.
      if (surface !== 'terminal') expect((await ui.find({ text: /lights follow/ })) !== undefined).toBe(true)
      expect((await ui.find({ text: /light\.turn_on/ })) !== undefined).toBe(true)
      // Reading it starts watching for its runs; nobody has to find the key.
      if (surface !== 'terminal') expect((await ui.find({ text: /Watching for a new run until/ })) !== undefined).toBe(true)
    }
  })
}
