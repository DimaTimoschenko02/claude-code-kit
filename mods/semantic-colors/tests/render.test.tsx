import type { On, PromptComposeInput, RenderSurface } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { INSTRUCTION, INSTRUCTION_ID } from '../hooks/instruction'
import { PALETTE } from '../hooks/rules'
import { SAMPLE } from '../hooks/sample'

const PLUGIN = 'semantic-colors'
const WARNING = 'render hook broken, falling back to stock rendering — /semantic-colors for details'
const REPLY = 'result: PH-12 собран\n\nСначала {-тесты упали на парсере-}, после фикса {+все 40 тестов прошли+}. {!Глянь diff перед мержем!}'
const REPLY_STRIPPED = 'result: PH-12 собран\n\nСначала тесты упали на парсере, после фикса все 40 тестов прошли. Глянь diff перед мержем'

const TURN = { reason: 'answer', answer: 'Готово, тесты passed.', durationMs: 1000, isAborted: false, turnId: 't1' } as const

// The whole input the engine composes with: with a part of it the test engine skips the mod's hook.
const COMPOSE: PromptComposeInput = { model: 'claude-test', promptModel: 'claude-test', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] }
const ENGINE_SECTIONS = [
  { id: 'intro', text: 'You are Claude Code.', scope: 'shared' },
  { id: 'memory', text: 'project memory', scope: 'session' },
] as const

type World = { toasts: string[]; statuses: (string | undefined)[]; store: Map<string, unknown>; drawn: Record<string, unknown>[] }

// The engine beneath the mod: a store in memory, a toast and status log, and the engine's own drawing as one Text.
function world(on: On, options: { surfaces?: readonly RenderSurface[]; store?: Record<string, unknown> } = {}): World {
  const seen: World = { toasts: [], statuses: [], store: new Map(Object.entries(options.store ?? {})), drawn: [] }
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
    // What the engine was handed to draw, as the mod left it.
    seen.drawn.push({ ...(e.props as Record<string, unknown>) })
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: 'Готово.' }))
  on('prompt.compose', () => ({ sections: ENGINE_SECTIONS }))
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

test('a reply with marks is drawn in colours on the terminal: each whole phrase, no mark characters', async ($, on) => {
  world(on)
  await start($)
  const ui = await reply($, REPLY)
  const texts = await ui.findAll({ type: 'Text' })
  const run = (text: string) => texts.find(t => t.text === text)
  expect(run('PH-12')?.props.color).toBe(PALETTE.purple)
  expect(run('тесты упали на парсере')?.props.color).toBe(PALETTE.red)
  expect(run('все 40 тестов прошли')?.props.color).toBe(PALETTE.green)
  expect(run('Глянь diff перед мержем')?.props.color).toBe(PALETTE.yellow)
  expect(run('●')?.props.color).toBe('text')
  expect(texts.some(t => t.text === 'engine')).toBe(false)
  expect(texts.some(t => /\{[+!-]|[+!-]\}/.test(t.text))).toBe(false)
  await ui.unmount()
})

test('where the mod does not draw, the engine is handed the text with the marks taken out', async ($, on) => {
  const seen = world(on)
  await start($)
  for (const ui of [await reply($, REPLY, 'desktop'), await reply($, REPLY, 'terminal', { isSummary: true })]) {
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
    await ui.unmount()
  }
  expect(seen.drawn.map(p => p.text)).toEqual([REPLY_STRIPPED, REPLY_STRIPPED])
  // isSummary rides along unchanged: a rewrite that drops it is refused.
  expect(seen.drawn[1]?.isSummary).toBe(true)
  expect(seen.drawn[0]).not.toHaveProperty('isSummary')
})

test('a reply with nothing to colour and an engine notice are handed on as they are', async ($, on) => {
  const seen = world(on)
  await start($)
  for (const ui of [await reply($, 'Обычный ответ без сигналов.'), await reply($, 'API Error: 500 {-x-}')]) {
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
    await ui.unmount()
  }
  expect(seen.drawn.map(p => p.text)).toEqual(['Обычный ответ без сигналов.', 'API Error: 500 {-x-}'])
})

test('a reply whose only marks are in a table goes to the engine stripped', async ($, on) => {
  const seen = world(on)
  await start($)
  const ui = await reply($, '| задача | статус |\n|---|---|\n| KN-3 | {-упал-} |')
  await ui.unmount()
  expect(seen.drawn.map(p => p.text)).toEqual(['| задача | статус |\n|---|---|\n| KN-3 | упал |'])
})

test('a code fence in a coloured reply is drawn by the Markdown element, its marks untouched', async ($, on) => {
  world(on)
  await start($)
  const ui = await reply($, '{-Упал тест-}:\n\n```\necho "{+x+}"\n```')
  const markdown = await ui.find({ type: 'Markdown' })
  expect(markdown?.props.text).toBe('```\necho "{+x+}"\n```')
  await ui.unmount()
})

test('a simulated throw: stock drawing without marks, one warning toast, a red status, and stock from then on', async ($, on) => {
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
  expect(seen.drawn.map(p => p.text)).toEqual([REPLY_STRIPPED, REPLY_STRIPPED])

  const status = await command($, '')
  expect(status.text).toContain('BROKEN, stock rendering, marks hidden: threw: simulated by /semantic-colors selftest')

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
  expect((await command($, '')).text).toContain('refused')
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

test('off draws stock with the marks hidden and is kept in the store; on brings colours back', async ($, on) => {
  const seen = world(on)
  await start($)
  expect((await command($, 'off')).text).toContain('new conversations')
  const off = await reply($, REPLY)
  expect((await off.find({ type: 'Text' }))?.text).toBe('engine')
  await off.unmount()
  expect(seen.drawn.map(p => p.text)).toEqual([REPLY_STRIPPED])
  await command($, 'on')
  const back = await reply($, REPLY)
  expect((await back.findAll({ type: 'Text' })).some(t => t.text === 'PH-12')).toBe(true)
  await back.unmount()
})

test('the system prompt gets the marks section last, as session text, on a terminal', async ($, on) => {
  world(on)
  await start($)
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections.map(s => s.id)).toEqual(['intro', 'memory', INSTRUCTION_ID])
  expect(sections.at(-1)).toEqual({ id: INSTRUCTION_ID, scope: 'session', text: INSTRUCTION })
  expect(INSTRUCTION).toContain('{+text+} green')
})

test('no marks section with print, teammate or bare, without a terminal, or when off', async ($, on) => {
  world(on)
  await start($)
  const ids = async (input: PromptComposeInput) => (await $.prompt.compose(input)).sections.map(s => s.id)
  for (const trait of ['print', 'teammate', 'bare'] as const) expect(await ids({ ...COMPOSE, traits: [trait] })).toEqual(['intro', 'memory'])
  expect(await ids({ ...COMPOSE, surfaces: [] })).toEqual(['intro', 'memory'])
  expect(await ids({ ...COMPOSE, surfaces: ['desktop'] })).toEqual(['intro', 'memory'])
  expect(await ids({ ...COMPOSE, traits: ['skills', 'lean'] })).toEqual(['intro', 'memory', INSTRUCTION_ID])
  await command($, 'off')
  expect(await ids(COMPOSE)).toEqual(['intro', 'memory'])
})

test('a session that starts off adds no marks section', async ($, on) => {
  world(on, { store: { enabled: false } })
  await start($)
  expect((await $.prompt.compose(COMPOSE)).sections.map(s => s.id)).toEqual(['intro', 'memory'])
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

test('the status names the marks, the rules and when on/off reaches the model', async ($, on) => {
  world(on)
  await start($)
  const status = (await command($, '')).text
  expect(status).toContain('{+…+} good · {-…-} bad · {!…!} act')
  expect(status).toContain('rules: task, url, path')
  expect(status).toContain('only for new conversations')
})

test('the sample command prints every mark and its row is drawn in colour, its table stripped', async ($, on) => {
  const seen = world(on)
  await start($)
  const result = await command($, 'sample')
  expect(result.text).toBe(SAMPLE)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'CommandOutput',
    props: { command: PLUGIN, args: 'sample', text: `${PLUGIN}: ${SAMPLE}`, isErrored: false },
  })
  const texts = await ui.findAll({ type: 'Text' })
  const colors = new Set(texts.map(t => t.props.color))
  for (const color of [PALETTE.red, PALETTE.green, PALETTE.yellow, PALETTE.purple, PALETTE.cyan, PALETTE.accent]) expect(colors.has(color)).toBe(true)
  // The name the engine puts before the row's text is not part of the sample: its first line is still an accent line.
  expect(texts.find(t => t.props.color === PALETTE.accent)?.text.startsWith('result:')).toBe(true)
  const markdown = (await ui.findAll({ type: 'Markdown' })).map(m => String(m.props.text)).join('\n')
  expect(markdown).toContain('| KN-3 | в таблице метка снимается, цвет нет |')
  await ui.unmount()
  // On a surface the mod does not draw, the sample reaches the engine without its marks.
  const desktop = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'CommandOutput',
    props: { command: PLUGIN, args: 'sample', text: `${PLUGIN}: ${SAMPLE}`, isErrored: false },
  })
  await desktop.unmount()
  const handed = String(seen.drawn.at(-1)?.text)
  expect(handed).toContain('все 14 миграций прошли, сервис поднялся')
  expect(handed).not.toContain('{+все')
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
