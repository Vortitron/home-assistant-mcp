import { expect, mock, test } from 'claude-code/testing'

const STAMP = '\n[vome-instance] target=748d339f-ae52-4cc3-81d7-f7c93f1a8852 home="Home" ha=2026.9.3 components=158'
const tool = (name: string) => name as 'mcp__vome__ha_get_automation'
const step = (n: string) => ({ action: 'light.turn_on', target: { entity_id: `light.${n}` } })
const HALL = { id: 'hall', alias: 'Hall at dusk', triggers: [{ trigger: 'sun', event: 'sunset' }], actions: [step('a'), step('b'), step('c')] }
const PANE_PROPS = {
  title: 'Automation',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}
const reply = (body: unknown) => {
  const text = JSON.stringify(body) + STAMP
  return { value: { content: [{ type: 'text', text }], isError: false } }
}


test('/automation with nothing shown lists the automations, and picking one shows it', async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [{ name: 'mcp__vome__ha_get_automation', description: '', mcp: true }] }))
  on('session.surfaces', () => ({ value: ['vscode'] }))
  on('mcp.call', (_$, e) => {
    if (e.tool === 'ha_list_automations')
      return reply({ count: 2, automations: [
        { entity_id: 'automation.hall_at_dusk', id: 'hall', state: 'on', friendly_name: 'Hall at dusk' },
        { entity_id: 'automation.away', id: 'away', state: 'off', friendly_name: 'Away mode' },
      ] })
    if (e.tool === 'ha_get_automation') return reply({ id: 'hall', config: HALL })
    return { value: { content: [{ type: 'text', text: '{}' }], isError: true } }
  })

  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.command.run({ command: 'automation', args: '' } as never)
  await clock.advance(3_500)

  const ui = await $.ui.mount({
    plugin: 'vome-automation',
    surface: 'vscode',
    component: 'Pane',
    requestId: 'vome-automation',
    props: PANE_PROPS,
    viewport: { columns: 160, rows: 60 },
  })
  expect((await ui.find({ text: /Pick an automation \(2\)/ })) !== undefined).toBe(true)
  // Sorted by name: Away mode first.
  await ui.select({ key: 'pick', value: 'hall' })
  await clock.advance(3_500)
  expect((await ui.find({ text: 'Hall at dusk' })) !== undefined).toBe(true)
  expect((await ui.find({ text: /Pick an automation/ })) === undefined).toBe(true)
})

test('inserting a step marks that step alone, not every step after it', async ($, on) => {
  on('tool.call', { tool: tool('mcp__vome__ha_get_automation') }, () => {
    const text = JSON.stringify({ id: 'hall', config: HALL }) + STAMP
    return { result: [{ type: 'text', text }], text }
  })
  on('tool.call', { tool: tool('mcp__vome__ha_set_automation') }, () => {
    const text = JSON.stringify({ saved: true }) + STAMP
    return { result: [{ type: 'text', text }], text }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))

  await $.tool.call({ tool: tool('mcp__vome__ha_get_automation'), automation: 'hall' })
  await $.tool.call({
    tool: tool('mcp__vome__ha_set_automation'),
    automation_id: 'hall',
    config: { ...HALL, actions: [step('new'), ...HALL.actions] },
  } as never)
  const ui = await $.ui.mount({
    plugin: 'vome-automation',
    surface: 'vscode',
    component: 'Pane',
    requestId: 'vome-automation',
    props: PANE_PROPS,
    viewport: { columns: 160, rows: 60 },
  })
  expect((await ui.find({ text: /1 added, 0 changed, 0 removed/ })) !== undefined).toBe(true)
})
