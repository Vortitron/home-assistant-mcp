import { expect, test } from 'claude-code/testing'

// Our MCP under the names it really goes by: the README's, and a relay's own.
const CONFIG = {
  id: 'hall',
  alias: 'Hall light at dusk',
  triggers: [{ trigger: 'sun', event: 'sunset' }],
  actions: [{ action: 'light.turn_on', target: { entity_id: 'light.hall' } }],
}
const BODY = JSON.stringify({ id: 'hall', config: CONFIG })
// The typings list only the servers connected when they were written; these names are made up.
const tool = (name: string) => name as 'mcp__vome__ha_get_automation'

const PANE_PROPS = {
  title: 'Automation',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

for (const server of ['home-assistant', 'ha-gamlabio']) {
  test(`follows the tools on a server called ${server}, and reads back from it`, async ($, on) => {
    const asked: string[] = []
    on('tool.call', { tool: tool(`mcp__${server}__ha_get_automation`) }, () => ({ result: [{ type: 'text', text: BODY }], text: BODY }))
    // The pane's own reads (the latest run, the HA link): record which server they go to.
    on('mcp.call', (_$, e) => {
      asked.push(`${e.server}:${e.tool}`)
      return { value: { content: [{ type: 'text', text: '{}' }], isError: true } }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.log', () => ({ value: undefined }))

    await $.tool.call({ tool: tool(`mcp__${server}__ha_get_automation`), automation: 'hall' })

    const ui = await $.ui.mount({
      plugin: 'vome-automation',
      surface: 'vscode',
      component: 'Pane',
      requestId: 'vome-automation',
      props: PANE_PROPS,
      viewport: { columns: 160, rows: 50 },
    })
    expect((await ui.find({ text: /Hall light at dusk/ })) !== undefined).toBe(true)
    expect((await ui.find({ text: /light\.turn_on/ })) !== undefined).toBe(true)
    expect(asked.every(call => call.startsWith(`${server}:`))).toBe(true)
  })
}

test('ignores tools that are not ours, and ours under names it does not follow', async ($, on) => {
  on('tool.call', () => ({ result: [{ type: 'text', text: BODY }], text: BODY }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.tool.call({ tool: tool('mcp__other__get_automation'), automation: 'hall' })
  const ui = await $.ui.mount({
    plugin: 'vome-automation',
    surface: 'vscode',
    component: 'Pane',
    requestId: 'vome-automation',
    props: PANE_PROPS,
    viewport: { columns: 160, rows: 50 },
  })
  expect((await ui.find({ text: /No automation yet/ })) !== undefined).toBe(true)
})
