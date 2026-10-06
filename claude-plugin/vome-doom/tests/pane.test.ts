import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE_PROPS = { title: 'house.wad', isFocused: false, bodyColumns: 96, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const mount = ($: Engine) =>
  $.ui.mount({ plugin: 'vome-doom', surface: 'terminal', component: 'Pane', requestId: 'house-wad', props: PANE_PROPS, viewport: { columns: 200, rows: 50 } })

function base(on: On) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', () => ({ value: '/home/someone' }))
}

test('the pane offers a real game and a practice one', async ($, on) => {
  base(on)
  const ui = await mount($)
  expect((await ui.find({ text: /Your home as a Doom level/ })) !== undefined).toBe(true)
  expect((await ui.find({ key: 'play' })) !== undefined).toBe(true)
  expect((await ui.find({ key: 'practice' })) !== undefined).toBe(true)
})

test('/doom opens the pane', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  const opened: string[] = []
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  const result = await $.command.run({ command: 'doom', args: '' } as never)
  expect(opened).toContain('house-wad')
  expect(JSON.stringify(result)).toContain('Press Play')
})
