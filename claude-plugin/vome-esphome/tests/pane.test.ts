import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const STAMP = '\n[vome-instance] target=748d339f-ae52-4cc3-81d7-f7c93f1a8852 home="Home" ha=2026.9.3 components=158'
const tool = (name: string) => name as 'mcp__vome__ha_get_automation'
const PANE_PROPS = {
  title: 'ESPHome',
  isFocused: false,
  bodyColumns: 70,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}
const reply = (body: unknown) => {
  const text = JSON.stringify(body) + STAMP
  return { result: [{ type: 'text', text }], text }
}
const mount = ($: Engine) =>
  $.ui.mount({
    plugin: 'vome-esphome',
    surface: 'vscode',
    component: 'Pane',
    requestId: 'vome-esphome',
    props: PANE_PROPS,
    viewport: { columns: 160, rows: 60 },
  })

function base(on: On) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

test('a flash shows its progress while it runs, then the result', async ($, on) => {
  const clock = mock.clock(on)
  base(on)
  let finish: (value: ReturnType<typeof reply>) => void = () => undefined
  on('tool.call', { tool: tool('mcp__home-assistant__esphome_upload') }, () => new Promise(resolve => (finish = resolve)))
  on('mcp.call', (_$, e) => {
    expect(e.server).toBe('home-assistant')
    const text = JSON.stringify({
      seq: 12,
      jobs: [
        {
          job_id: 'job-1',
          command: 'upload',
          configuration: 'lr.yaml',
          started: new Date().toISOString(),
          done: false,
          lines: ['Compiling .pioenvs/lr/src/main.cpp.o\n', 'INFO Successfully compiled program.\n', 'Uploading: [=====          ] 48% \r'],
        },
      ],
    })
    return { value: { content: [{ type: 'text', text: text + STAMP }], isError: false } }
  })

  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  const call = $.tool.call({ tool: tool('mcp__home-assistant__esphome_upload'), configuration: 'lr.yaml' } as never)
  await clock.advance(1_600)

  const ui = await mount($)
  expect((await ui.find({ text: 'Flashing lr.yaml' })) !== undefined).toBe(true)
  expect((await ui.find({ text: /Uploading 48%/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /Compiling \.pioenvs/ })) !== undefined).toBe(true)
  // In the terminal the chip on the bench sits over it; the editor surfaces go without.
  const terminal = await $.ui.mount({
    plugin: 'vome-esphome',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'vome-esphome',
    props: PANE_PROPS,
    viewport: { columns: 160, rows: 60 },
  })
  expect((await terminal.find({ type: 'Raster', key: 'chip' })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Raster' })) === undefined).toBe(true)

  finish(reply({ command: 'upload', configuration: 'lr.yaml', exit_code: 0, success: true, stopped: 'completed', output: 'INFO OTA successful\n' }))
  await call
  expect((await ui.find({ text: /✓ Flashed in/ })) !== undefined).toBe(true)
  // The live lines stay; the end of the output does not replace them.
  expect((await ui.find({ text: /Compiling \.pioenvs/ })) !== undefined).toBe(true)
})

test('without esphome_activity it still shows the result and the output once the build returns', async ($, on) => {
  base(on)
  on('tool.call', { tool: tool('mcp__vome__esphome_compile') }, () =>
    reply({
      command: 'compile',
      configuration: 'lr.yaml',
      exit_code: 1,
      success: false,
      stopped: 'completed',
      output: 'Compiling .pioenvs/lr/src/main.cpp.o\nsrc/main.cpp:10:3: error: expected ; before }\n',
    }),
  )
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'Unknown tool esphome_activity' }], isError: true } }))

  await $.tool.call({ tool: tool('mcp__vome__esphome_compile'), configuration: 'lr.yaml' } as never)
  const ui = await mount($)
  expect((await ui.find({ text: /✗ Failed after/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /error: expected ; before \}/ })) !== undefined).toBe(true)
})

test('a device listing shows which devices have newer firmware waiting', async ($, on) => {
  base(on)
  on('tool.call', { tool: tool('mcp__vome__esphome_list_devices') }, () =>
    reply({
      configured: [
        { name: 'lr', friendly_name: 'Living room', configuration: 'lr.yaml', deployed_version: '2026.8.1', current_version: '2026.9.3' },
        { name: 'hall', friendly_name: 'Hall', configuration: 'hall.yaml', deployed_version: '2026.9.3', current_version: '2026.9.3' },
      ],
    }),
  )
  await $.tool.call({ tool: tool('mcp__vome__esphome_list_devices') } as never)
  const ui = await mount($)
  expect((await ui.find({ text: /2026\.8\.1 → 2026\.9\.3 available/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /Nothing building/ })) !== undefined).toBe(true)
})

test('when auto mode refuses the progress read, the pane gives the exact line to allow', async ($, on) => {
  const clock = mock.clock(on)
  base(on)
  let finish: (value: ReturnType<typeof reply>) => void = () => undefined
  on('tool.call', { tool: tool('mcp__plugin_vome-connect_vome__esphome_compile') }, () => new Promise(resolve => (finish = resolve)))
  on('mcp.call', () => ({
    deny: 'The server-side auto mode classifier gave no verdict for mcp__plugin_vome-connect_vome__esphome_activity',
  }))
  on('ui.copy', () => ({ value: { isCopied: true } }))

  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  const call = $.tool.call({ tool: tool('mcp__plugin_vome-connect_vome__esphome_compile'), configuration: 'lr.yaml' } as never)
  await clock.advance(1_600)
  const ui = await mount($)
  expect((await ui.find({ type: 'Code' }))?.text).toBe('"mcp__plugin_vome-connect_vome__esphome_activity"')
  expect((await ui.find({ text: /Compiling lr\.yaml/ })) !== undefined).toBe(true)
  finish(reply({ command: 'compile', configuration: 'lr.yaml', exit_code: 0, success: true, stopped: 'completed', output: 'INFO Successfully compiled program.\n' }))
  await call
  expect((await ui.find({ text: /✓ Compiled in/ })) !== undefined).toBe(true)
})
