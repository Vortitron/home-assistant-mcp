import { expect, mock, test } from 'claude-code/testing'

const PANE_PROPS = {
  title: 'Automation',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

test('with no Home Assistant MCP connected, the pane says how to connect one, then steps aside', async ($, on) => {
  const clock = mock.clock(on)
  let tools = [{ name: 'Bash', description: 'shell', mcp: false }]
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.list', () => ({ value: tools }))

  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await clock.advance(3_500)

  const ui = await $.ui.mount({
    plugin: 'vome-automation',
    surface: 'vscode',
    component: 'Pane',
    requestId: 'vome-automation',
    props: PANE_PROPS,
    viewport: { columns: 160, rows: 60 },
  })
  expect((await ui.find({ text: 'Connect Home Assistant first' })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Link', text: /API tokens/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Link', text: /set it up/ })) !== undefined).toBe(true)

  // The server connects a little later, under whatever name it has: the usual empty pane.
  tools = [...tools, { name: 'mcp__home-assistant__ha_get_automation', description: 'read an automation', mcp: true }]
  await clock.advance(3_000)
  expect((await ui.find({ text: 'Connect Home Assistant first' })) === undefined).toBe(true)
  expect((await ui.find({ text: /No automation yet/ })) !== undefined).toBe(true)
})
