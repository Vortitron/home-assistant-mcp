import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const STAMP = '\n[vome-instance] target=rly-568e6d697864 home="GamlaBio" ha=2026.9.4 components=373'
const tool = (name: string) => name as 'mcp__vome__ha_get_automation'
const PANE_PROPS = { title: 'Health', isFocused: false, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

// GamlaBio's report on 3 Oct 2026, trimmed, as vome_health_report returns it.
const FLOODING = {
  id: 'd9e72640',
  category: 'flapping',
  severity: 'warn',
  title: '7 entities are flooding the recorder',
  evidence: 'sensor.allrum_motion_motion_gate_2_energy (540,544, 14%, 375.4/min) …',
  recommendation: 'Exclude them from the recorder or raise their update interval.',
  entities: ['sensor.allrum_motion_motion_gate_2_energy'],
}
const OFF = { id: 'a1', category: 'automations', severity: 'advice', title: '20 automation(s) are turned off', recommendation: 'Delete the ones you no longer need.' }
const report = (score: number, findings: unknown[], generated: string) => ({
  found: true,
  entity_id: 'sensor.vome_vome_health_score',
  score,
  summary: 'GamlaBio is broadly in good order.',
  generated_at: generated,
  categories: [{ id: 'flapping', label: 'Chatty devices', severity: 'warn' }],
  findings,
})
const reply = (body: unknown) => {
  const text = JSON.stringify(body) + STAMP
  return { result: [{ type: 'text', text }], text }
}
const mount = ($: Engine) =>
  $.ui.mount({ plugin: 'vome-health', surface: 'vscode', component: 'Pane', requestId: 'vome-health', props: PANE_PROPS, viewport: { columns: 160, rows: 60 } })

function base(on: On) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

test('reading the report fills the pane: the score, the findings by severity, what to do', async ($, on) => {
  base(on)
  on('tool.call', { tool: tool('mcp__vome__vome_health_report') }, () => reply(report(75, [FLOODING, OFF], '2026-09-14T10:05:57.000Z')))
  await $.tool.call({ tool: tool('mcp__vome__vome_health_report') } as never)
  const ui = await mount($)
  expect((await ui.find({ text: /^GamlaBio  75\/100/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: 'To fix' })) !== undefined).toBe(true)
  expect((await ui.find({ text: /7 entities are flooding the recorder/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /Exclude them from the recorder/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /re-check for today/ })) !== undefined).toBe(true)
})

test('a change about a finding marks it as worked on', async ($, on) => {
  base(on)
  on('tool.call', { tool: tool('mcp__vome__vome_health_report') }, () => reply(report(75, [FLOODING, OFF], '2026-09-14T10:05:57.000Z')))
  on('tool.call', { tool: tool('mcp__vome__ha_write_config_file') }, () => reply({ written: true }))
  await $.tool.call({ tool: tool('mcp__vome__vome_health_report') } as never)
  await $.tool.call({ tool: tool('mcp__vome__ha_write_config_file'), path: 'configuration.yaml', content: 'recorder:\n  exclude:\n    entity_globs:\n      - sensor.allrum_motion_*' } as never)
  const ui = await mount($)
  expect((await ui.find({ text: /7 entities are flooding the recorder  changed; re-check to confirm/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /20 automation\(s\) are turned off  changed/ })) === undefined).toBe(true)
})

test('a re-check rolls the score to the new one and strikes what it no longer finds', async ($, on) => {
  const clock = mock.clock(on)
  base(on)
  on('tool.call', { tool: tool('mcp__vome__vome_health_report') }, () => reply(report(75, [FLOODING, OFF], '2026-09-14T10:05:57.000Z')))
  on('tool.call', { tool: tool('mcp__vome__vome_health_check') }, () => reply({ started: true }))
  let isDone = false
  on('mcp.call', (_$, e) => {
    expect(e.tool).toBe('vome_health_report')
    const body = isDone ? report(88, [OFF], '2026-10-03T09:00:00.000Z') : report(75, [FLOODING, OFF], '2026-09-14T10:05:57.000Z')
    return { value: { content: [{ type: 'text', text: JSON.stringify(body) + STAMP }], isError: false } }
  })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.tool.call({ tool: tool('mcp__vome__vome_health_report') } as never)
  await $.tool.call({ tool: tool('mcp__vome__vome_health_check') } as never)
  const ui = await mount($)
  expect((await ui.find({ text: /^Checking… the new score lands/ })) !== undefined).toBe(true)
  await clock.advance(10_500)
  expect((await ui.find({ text: /^GamlaBio  75\/100/ })) !== undefined).toBe(true)
  isDone = true
  await clock.advance(10_500)
  expect((await ui.find({ text: /^75 → 88: 1 finding gone/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /✓ 7 entities are flooding the recorder/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /^GamlaBio  88\/100/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /^Checking…/ })) === undefined).toBe(true)
})

test('a home with no score yet says how to get one', async ($, on) => {
  base(on)
  on('tool.call', { tool: tool('mcp__vome__vome_health_report') }, () => reply({ found: false, note: 'No health score on this home yet. vome_health_check runs a first check.' }))
  await $.tool.call({ tool: tool('mcp__vome__vome_health_report') } as never)
  const ui = await mount($)
  expect((await ui.find({ text: /No health score yet/ })) !== undefined).toBe(true)
  expect((await ui.find({ text: /vome_health_check runs a first check/ })) !== undefined).toBe(true)
})
