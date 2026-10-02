import { expect, mock, test } from 'claude-code/testing'

const STAMP = '\n[vome-instance] target=748d339f-ae52-4cc3-81d7-f7c93f1a8852 home="Home" ha=2026.9.3 components=158'
const CONFIG = {
  id: 'demo',
  alias: 'Demo',
  triggers: [{ trigger: 'state', entity_id: 'binary_sensor.kitchen_occupied', to: 'on' }],
  actions: [{ action: 'light.turn_on', target: { entity_id: 'light.kitchen' } }],
}
const PANE_PROPS = {
  title: 'Automation',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}
// What auto mode answers a background read nobody asked for, as the session reported it.
const VERDICT =
  'The server-side auto mode classifier gave no verdict for mcp__ha-home__ha_get_trace: the request that produced this action did not come from the user'

test('a read auto mode refuses becomes the exact allow lines for that server, a copy and the settings link', async ($, on) => {
  const clock = mock.clock(on)
  const copied: string[] = []
  const tool = (name: string) => name as 'mcp__vome__ha_get_automation'
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/someone' : undefined }))
  on('store.get', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('tool.call', { tool: tool('mcp__ha-home__ha_get_automation') }, () => {
    const text = JSON.stringify({ id: 'demo', config: CONFIG }) + STAMP
    return { result: [{ type: 'text', text }], text }
  })
  on('mcp.call', () => ({ deny: VERDICT }))
  on('tool.list', () => ({ value: [{ name: 'mcp__ha-home__ha_get_automation', description: 'read an automation', mcp: true }] }))

  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.tool.call({ tool: tool('mcp__ha-home__ha_get_automation'), automation: 'demo' })
  await clock.advance(3_500) // the pane's tick: it reads the latest run, and is refused

  const ui = await $.ui.mount({
    plugin: 'vome-automation',
    surface: 'vscode',
    component: 'Pane',
    requestId: 'vome-automation',
    props: PANE_PROPS,
    viewport: { columns: 160, rows: 60 },
  })
  const lines = (await ui.find({ type: 'Code' }))?.text ?? ''
  expect(lines).toContain('"mcp__ha-home__ha_get_trace"')
  expect(lines).toContain('"mcp__ha-home__ha_list_traces"')
  expect(lines).toContain('"mcp__ha-home__ha_get_automation"')
  expect((await ui.find({ type: 'Markdown', text: /file:\/\/\/home\/someone\/\.claude\/settings\.json/ })) !== undefined).toBe(true)

  // It takes the pane: the tree is not drawn behind it, and it quotes what Claude Code said.
  expect((await ui.find({ text: 'WHEN' })) === undefined).toBe(true)
  expect((await ui.find({ text: /Claude Code said: .*gave no verdict/ })) !== undefined).toBe(true)

  await ui.press({ key: 'copy-rules' })
  expect(copied[0]).toBe(lines)

  // Dismissed, the pane is back, with h to bring the help back.
  await ui.press({ key: 'dismiss' })
  expect((await ui.find({ text: 'WHEN' })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Code' })) === undefined).toBe(true)
  await ui.press({ key: 'help' })
  expect((await ui.find({ type: 'Code' })) !== undefined).toBe(true)
})
