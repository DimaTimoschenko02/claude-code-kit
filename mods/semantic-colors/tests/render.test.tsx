import type { On, RenderSurface } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { PALETTE } from '../hooks/rules'
import { SAMPLE } from '../hooks/sample'

const PLUGIN = 'semantic-colors'
const WARNING = 'render hook broken, falling back to stock rendering — /semantic-colors for details'
const REPLY = 'result: PH-12 собран\n\nТесты упали, теперь работает. Занимает 350 МБ.'

const TURN = { reason: 'answer', answer: 'Готово, тесты passed.', durationMs: 1000, isAborted: false, turnId: 't1' } as const

type World = { toasts: string[]; statuses: (string | undefined)[]; store: Map<string, unknown> }

// The engine beneath the mod: a store in memory, a toast and status log, and the engine's own drawing as one Text.
function world(on: On, options: { surfaces?: readonly RenderSurface[]; store?: Record<string, unknown> } = {}): World {
  const seen: World = { toasts: [], statuses: [], store: new Map(Object.entries(options.store ?? {})) }
  // The store over a Map the test reads back; a value goes through JSON as the engine's does.
  on('store.get', (_, e) => ({ value: seen.store.get(e.key) }))
  on('store.set', (_, e) => {
    seen.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    seen.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...seen.store.keys()] }))
  on('command.register', () => ({ value: { command: PLUGIN } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: options.surfaces ?? ['terminal'] }))
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: 'Готово.' }))
  return seen
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: 'D:\\work\\game', surface: 'terminal', isInteractive: true })
}

function reply($: Engine, text: string, surface: 'terminal' | 'desktop' = 'terminal', props: Record<string, unknown> = {}) {
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'AssistantMessage', props: { text, isFirstOfReply: true, ...props } as never })
}

function command($: Engine, args: string) {
  return $.command.run({ command: PLUGIN, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
}

test('a reply with signals is drawn in colours on the terminal, markdown kept', async ($, on) => {
  world(on)
  await start($)
  const ui = await reply($, REPLY)
  const texts = await ui.findAll({ type: 'Text' })
  const run = (text: string) => texts.find(t => t.text === text)
  expect(run('PH-12')?.props.color).toBe(PALETTE.purple)
  expect(run('упали')?.props.color).toBe(PALETTE.red)
  expect(run('работает')?.props.color).toBe(PALETTE.green)
  expect(run('350 МБ')?.props.color).toBe(PALETTE.yellow)
  expect(run('●')?.props.color).toBe('text')
  expect(texts.some(t => t.text === 'engine')).toBe(false)
  await ui.unmount()
})

test('a reply with nothing to colour, a summary and other surfaces are the engine own drawing', async ($, on) => {
  world(on)
  await start($)
  for (const ui of [
    await reply($, 'Обычный ответ без сигналов.'),
    await reply($, REPLY, 'terminal', { isSummary: true }),
    await reply($, REPLY, 'desktop'),
    await reply($, 'API Error: 500 failed'),
  ]) {
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
    await ui.unmount()
  }
})

test('a code fence in a coloured reply is drawn by the Markdown element, untouched', async ($, on) => {
  world(on)
  await start($)
  const ui = await reply($, 'Упал тест:\n\n```\nerror PH-1\n```')
  const markdown = await ui.find({ type: 'Markdown' })
  expect(markdown?.props.text).toBe('```\nerror PH-1\n```')
  await ui.unmount()
})

test('a simulated throw: stock drawing, one warning toast, a red status, and stock from then on', async ($, on) => {
  const seen = world(on)
  await start($)
  await command($, 'selftest throw')
  const first = await reply($, REPLY)
  expect((await first.find({ type: 'Text' }))?.text).toBe('engine')
  await first.unmount()
  expect(seen.toasts).toEqual([WARNING])
  expect(seen.statuses.at(-1)).toContain('🔴 render hook broken')

  const second = await reply($, REPLY)
  expect((await second.find({ type: 'Text' }))?.text).toBe('engine')
  await second.unmount()
  expect(seen.toasts).toEqual([WARNING])

  const status = await command($, '')
  expect(status.text).toContain('BROKEN, stock rendering: threw: simulated by /semantic-colors selftest')

  await command($, 'reset')
  expect(seen.statuses.at(-1)).toBeUndefined()
  const third = await reply($, REPLY)
  expect((await third.findAll({ type: 'Text' })).some(t => t.text === 'PH-12')).toBe(true)
  await third.unmount()
})

test('a tree the site refuses goes through the registration catch: stock drawing and the warning', async ($, on) => {
  const seen = world(on)
  await start($)
  await command($, 'selftest refuse')
  const ui = await reply($, REPLY)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
  expect(seen.toasts).toEqual([WARNING])
  expect((await command($, '')).text).toContain('BROKEN, stock rendering: refused')
})

test('props in a shape the mod does not know: stock drawing and the warning', async ($, on) => {
  const seen = world(on)
  await start($)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AssistantMessage', props: { body: REPLY } as never })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
  expect(seen.toasts).toEqual([WARNING])
  expect((await command($, '')).text).toContain('props')
})

test('replies that never reach the hook on a terminal are reported as a silent site', async ($, on) => {
  const seen = world(on)
  await start($)
  await $.turn.complete(TURN)
  expect(seen.toasts).toEqual([])
  await $.turn.complete(TURN)
  expect(seen.toasts).toEqual([WARNING])
  expect((await command($, '')).text).toContain('silent')
})

test('replies drawn through the hook keep the silent check quiet; a headless run never checks', async ($, on) => {
  const seen = world(on, { surfaces: [] })
  await start($)
  for (let i = 0; i < 3; i += 1) await $.turn.complete(TURN)
  expect(seen.toasts).toEqual([])
})

test('off draws stock and is kept in the store; on brings colours back', async ($, on) => {
  world(on)
  await start($)
  await command($, 'off')
  const off = await reply($, REPLY)
  expect((await off.find({ type: 'Text' }))?.text).toBe('engine')
  await off.unmount()
  await command($, 'on')
  const back = await reply($, REPLY)
  expect((await back.findAll({ type: 'Text' })).some(t => t.text === 'PH-12')).toBe(true)
  await back.unmount()
})

test('texts shown under the plugin name do not repeat it', async ($, on) => {
  const seen = world(on)
  await start($)
  await command($, 'selftest')
  await (await reply($, REPLY)).unmount()
  const texts = [...seen.toasts, ...seen.statuses, (await command($, '')).text, (await command($, 'on')).text]
  expect(texts.length).toBe(4)
  for (const text of texts) expect(/^(?:🔴 )?semantic-colors/.test(String(text))).toBe(false)
})

test('the sample command prints every rule and its row is drawn in colour', async ($, on) => {
  world(on)
  await start($)
  const result = await command($, 'sample')
  expect(result.text).toBe(SAMPLE)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'CommandOutput',
    props: { command: PLUGIN, args: 'sample', text: `${PLUGIN}: ${SAMPLE}`, isErrored: false },
  })
  const colors = new Set((await ui.findAll({ type: 'Text' })).map(t => t.props.color))
  for (const color of [PALETTE.red, PALETTE.green, PALETTE.purple, PALETTE.cyan, PALETTE.yellow, PALETTE.accent]) expect(colors.has(color)).toBe(true)
  // The name the engine puts before the row's text is not part of the sample: its first line is still an accent line.
  const first = (await ui.findAll({ type: 'Text' })).find(t => t.props.color === PALETTE.accent)
  expect(first?.text.startsWith('result:')).toBe(true)
  await ui.unmount()
})

test('a session starts with what earlier sessions stored: off stays off, the last failure is shown', async ($, on) => {
  const failure = { at: '2026-11-01T10:00:00.000Z', kind: 'threw', reason: 'Markdown refused' }
  world(on, { store: { enabled: false, lastFailure: failure } })
  await start($)
  const ui = await reply($, REPLY)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
  const status = (await command($, '')).text
  expect(status).toContain('off (/semantic-colors on)')
  expect(status).toContain('last failure: 2026-11-01T10:00:00.000Z · threw: Markdown refused')
})

test('off and a failure are written under their own keys', async ($, on) => {
  const seen = world(on)
  await start($)
  await command($, 'off')
  expect(seen.store.get('enabled')).toBe(false)
  await command($, 'selftest')
  await command($, 'on')
  await (await reply($, REPLY)).unmount()
  expect(seen.store.get('enabled')).toBe(true)
  expect(seen.store.get('lastFailure')).toMatchObject({ kind: 'threw' })
  expect([...seen.store.keys()].sort()).toEqual(['enabled', 'lastFailure'])
})
