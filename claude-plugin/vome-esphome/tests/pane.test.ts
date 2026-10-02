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
    if (e.tool === 'esphome_get_config') return { value: { content: [{ type: 'text', text: 'esphome:\n  name: lr\n' + STAMP }], isError: false } }
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
  // Only the latest lines by default; l shows the whole log.
  expect((await ui.find({ text: /Compiling \.pioenvs/ })) === undefined).toBe(true)
  await ui.press({ key: 'log' })
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
  expect((await ui.find({ type: 'Code' }))?.text).toBe(
    '"mcp__plugin_vome-connect_vome__esphome_activity",\n"mcp__plugin_vome-connect_vome__esphome_get_config"',
  )
  expect((await ui.find({ text: /Compiling lr\.yaml/ })) !== undefined).toBe(true)
  finish(reply({ command: 'compile', configuration: 'lr.yaml', exit_code: 0, success: true, stopped: 'completed', output: 'INFO Successfully compiled program.\n' }))
  await call
  expect((await ui.find({ text: /✓ Compiled in/ })) !== undefined).toBe(true)
})

test('real ESP-IDF output: colour codes sent as text, and ninja steps as a percentage', async ($, on) => {
  const clock = mock.clock(on)
  base(on)
  let finish: (value: ReturnType<typeof reply>) => void = () => undefined
  on('tool.call', { tool: tool('mcp__vome-staging__esphome_compile') }, () => new Promise(resolve => (finish = resolve)))
  on('mcp.call', (_$, e) => {
    if (e.tool === 'esphome_get_config') return { value: { content: [{ type: 'text', text: 'Not found' }], isError: true } }
    // As chap-test2's dashboard really streamed it, 2 Oct 2026.
    const lines = [
      '\\033[32mINFO ESPHome 2026.9.1\\033[0m\n\n',
      '\\033[32mINFO Compiling app... Build path: /data/build/vome-pane-test\\033[0m\n\n',
      '[437/972] Building C object esp-idf/freertos/CMakeFiles/__idf_freertos.dir/port.c.obj\n',
    ]
    const text = JSON.stringify({ seq: 9, jobs: [{ job_id: 'j', command: 'compile', configuration: 'vome-pane-test.yaml', started: new Date().toISOString(), done: false, lines }] })
    return { value: { content: [{ type: 'text', text: text + STAMP }], isError: false } }
  })

  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  const call = $.tool.call({ tool: tool('mcp__vome-staging__esphome_compile'), configuration: 'vome-pane-test.yaml' } as never)
  await clock.advance(1_600)
  const ui = await mount($)
  expect((await ui.find({ text: /Compiling 45% \(437 steps\)/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /\[437\/972\] Building C object/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /\\033/ })) === undefined).toBe(true)
  finish(reply({ command: 'compile', configuration: 'vome-pane-test.yaml', exit_code: 0, success: true, stopped: 'completed', output: '' }))
  await call
})

test('when Claude stops waiting, the pane keeps following the build and takes its result from the job', async ($, on) => {
  const clock = mock.clock(on)
  base(on)
  let finish: (value: { isError: true; result: unknown; text: string }) => void = () => undefined
  on('tool.call', { tool: tool('mcp__vome-staging__esphome_compile') }, () => new Promise(resolve => (finish = resolve)))
  let isDone = false
  on('mcp.call', (_$, e) => {
    if (e.tool === 'esphome_get_config') return { value: { content: [{ type: 'text', text: 'Not found' }], isError: true } }
    const lines = isDone ? ['[972/972] Linking CXX executable vome-pane-test.elf\n'] : ['[10/972] Building C object\n']
    const job = { job_id: 'j', command: 'compile', configuration: 'vome-pane-test.yaml', started: new Date().toISOString(), done: isDone, exit_code: isDone ? 0 : null, lines }
    return { value: { content: [{ type: 'text', text: JSON.stringify({ seq: isDone ? 20 : 10, jobs: [job] }) + STAMP }], isError: false } }
  })

  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  const call = $.tool.call({ tool: tool('mcp__vome-staging__esphome_compile'), configuration: 'vome-pane-test.yaml' } as never)
  await clock.advance(1_600)
  finish({ isError: true, result: null, text: 'MCP server "vome-staging" tool "esphome_compile" sent no response or progress for 300s; aborting.' })
  await call
  await clock.advance(1_600)
  const ui = await mount($)
  expect((await ui.find({ text: /Failed/ })) === undefined).toBe(true)
  expect((await ui.find({ text: /Compiling 1%/ })) !== undefined).toBe(true)

  isDone = true
  await clock.advance(1_600)
  expect((await ui.find({ text: /✓ Compiled in/ })) !== undefined).toBe(true)
})

const LOFT = `substitutions:
  name: loft
esphome:
  name: \${name}
  friendly_name: Loft
esp32:
  variant: esp32c3
  framework:
    type: esp-idf
api:
  encryption:
    key: "c2VjcmV0LWtleS12YWx1ZQ=="
wifi:
  ssid: !secret wifi_ssid
  password: hunter2
i2c:
  sda: GPIO8
  scl: GPIO9
sensor:
  - platform: bme280_i2c
    temperature:
      name: Loft temperature
    humidity:
      name: Loft humidity
binary_sensor:
  - platform: gpio
    pin:
      number: GPIO5
      inverted: true
    name: Hatch
    on_press:
      then:
        - light.toggle: status
light:
  - platform: status_led
    name: Status
    id: status
    pin: GPIO8
`

test('reading a config draws a map of the device, and a save lights what it changed', async ($, on) => {
  base(on)
  on('tool.call', { tool: tool('mcp__vome__esphome_get_config') }, () => ({ result: [{ type: 'text', text: LOFT + STAMP }], text: LOFT + STAMP }))
  on('tool.call', { tool: tool('mcp__vome__esphome_save_config') }, () => reply({ saved: true, configuration: 'loft.yaml' }))

  await $.tool.call({ tool: tool('mcp__vome__esphome_get_config'), configuration: 'loft.yaml' } as never)
  const ui = await mount($)
  expect((await ui.find({ text: /ESP32 · esp32c3 · esp-idf/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: 'Loft humidity' })) !== undefined).toBe(true)
  expect((await ui.find({ text: /light\.toggle/ })) !== undefined).toBe(true)
  // The I2C bus and the LED both on GPIO8: the map says so.
  expect((await ui.find({ text: /i2c sda, Status  \(shared, strapping pin\)/ })) !== undefined).toBe(true)
  // Keys and passwords in the YAML are never drawn.
  expect((await ui.find({ text: /hunter2|c2VjcmV0/ })) === undefined).toBe(true)

  await $.tool.call({ tool: tool('mcp__vome__esphome_save_config'), configuration: 'loft.yaml', yaml: LOFT.replace('pin: GPIO8', 'pin: GPIO10') } as never)
  const moved = await ui.find({ text: /GPIO10/ })
  expect(moved !== undefined).toBe(true)
  expect((await ui.find({ text: /^~/ })) !== undefined).toBe(true)
})

test('a call Claude Code moves to the background is not a failure: the pane follows the job to its end', async ($, on) => {
  const clock = mock.clock(on)
  base(on)
  on('tool.call', { tool: tool('mcp__vome-staging__esphome_compile') }, () => ({
    isError: true,
    result: null,
    text: 'MCP tool "vome-staging/esphome_compile" is still running after 120s. It was moved to the background as task kha529d9x and keeps running',
  }))
  let isDone = false
  on('mcp.call', (_$, e) => {
    if (e.tool === 'esphome_get_config') return { value: { content: [{ type: 'text', text: 'Not found' }], isError: true } }
    const job = { job_id: 'j', command: 'compile', configuration: 't.yaml', started: new Date().toISOString(), done: isDone, exit_code: isDone ? 0 : null, lines: ['[400/920] Building C object\n'] }
    return { value: { content: [{ type: 'text', text: JSON.stringify({ seq: isDone ? 2 : 1, jobs: [job] }) + STAMP }], isError: false } }
  })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.tool.call({ tool: tool('mcp__vome-staging__esphome_compile'), configuration: 't.yaml' } as never)
  await clock.advance(1_600)
  const ui = await mount($)
  expect((await ui.find({ text: /Failed/ })) === undefined).toBe(true)
  expect((await ui.find({ text: /Compiling 43%/ })) !== undefined).toBe(true)
  isDone = true
  await clock.advance(1_600)
  expect((await ui.find({ text: /✓ Compiled in/ })) !== undefined).toBe(true)
})

test('at rest the terminal still has its stage: dreams with no device known, the device after a read', async ($, on) => {
  base(on)
  on('tool.call', { tool: tool('mcp__vome__esphome_get_config') }, () => ({ result: [{ type: 'text', text: LOFT + STAMP }], text: LOFT + STAMP }))
  const terminal = () =>
    $.ui.mount({ plugin: 'vome-esphome', surface: 'terminal', component: 'Pane', requestId: 'vome-esphome', props: PANE_PROPS, viewport: { columns: 160, rows: 60 } })
  const before = await terminal()
  expect((await before.find({ type: 'Raster', key: 'chip' })) !== undefined).toBe(true)
  await $.tool.call({ tool: tool('mcp__vome__esphome_get_config'), configuration: 'loft.yaml' } as never)
  const after = await terminal()
  expect((await after.find({ type: 'Raster', key: 'chip' })) !== undefined).toBe(true)
  expect((await after.find({ text: 'Loft' })) !== undefined).toBe(true)
})
