import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { CommandSpec, On, PromptSubmitAttachment, PromptSubmitInput } from 'claude-code'

const HOME = '/home/dima'
const TERMS_PATH = `${HOME}/.claude/dictate-terms.json`
const TERMS = JSON.stringify({
  'точка основного': 'точка останова',
  'точку основного': 'точку останова',
})
const ME = { kind: 'composer' } as const
const PRESENTATION = { isFullscreen: true, columns: 120 }
const HOUR = 60 * 60 * 1000
const HELD = (n: number) =>
  `📥 в пачке ${n} — «всё» или /pack, чтобы отправить; /pack cancel — сбросить`
const BAND = 'пачка: 2 · всё — отправить · /pack cancel'

type File = { text: string; mtimeMs: number }
type World = {
  clock: MockClock
  files: Map<string, File>
  submitted: PromptSubmitInput[]
  registered: CommandSpec[]
  toasts: string[]
  reads: number
}

/** The engine beneath the plugin: clock, env, files, toasts, the prompt queue. */
function world(on: On, files: Record<string, string> = { [TERMS_PATH]: TERMS }): World {
  const w: World = {
    clock: mock.clock(on, { now: 1_700_000_000_000 }),
    files: new Map(Object.entries(files).map(([path, text]) => [path, { text, mtimeMs: 1 }])),
    submitted: [],
    registered: [],
    toasts: [],
    reads: 0,
  }
  mock.env(on, { HOME })
  on('fs.stat', ($, e) => {
    const file = w.files.get(e.path)
    if (file === undefined) return { deny: `ENOENT: ${e.path}` }
    return { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const file = w.files.get(e.path)
    if (file === undefined) return { deny: `ENOENT: ${e.path}` }
    w.reads += 1
    return { value: file.text }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('command.register', ($, e) => {
    w.registered.push(e)
    return { value: { command: e.name } }
  })
  on('prompt.submit', ($, e) => {
    w.submitted.push(e)
    return { text: e.text, context: e.context }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'beneath' })
  })
  return w
}

const say = (
  $: Engine,
  text: string,
  extra: { turnId?: string; attachments?: PromptSubmitAttachment[] } = {},
) => $.prompt.submit({ text, wait: false, origin: ME, ...extra })

const run = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: ME, presentation: PRESENTATION })

const ABOVE_PROMPT = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

describe('batch', () => {
  test('/pack toggles on with one line and no model turn, off again when empty', async ($, on) => {
    const w = world(on)
    const on1 = await run($, 'pack')
    expect(on1.text).toContain('пачка включена')
    expect(w.submitted).toHaveLength(0)
    const off = await run($, 'pack')
    expect(off.text).toBe('пачка пуста — выключена')
    const passed = await say($, 'обычный промпт')
    expect(passed.text).toBe('обычный промпт')
    expect(w.submitted).toHaveLength(1)
  })

  test('/pack registers immediate at session start', async ($, on) => {
    const w = world(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    expect(w.registered).toContainEqual(expect.objectContaining({ name: 'pack', immediate: true }))
  })

  test('/batch is left to the built-in, bare or with cancel', async ($, on) => {
    world(on)
    const reached: string[] = []
    on('command.run', { command: 'batch' }, ($, e) => {
      reached.push(e.args)
      return { text: 'built-in batch' }
    })
    expect((await run($, 'batch')).text).toBe('built-in batch')
    expect((await run($, 'batch', 'cancel')).text).toBe('built-in batch')
    expect(reached).toEqual(['', 'cancel'])
    expect((await say($, 'не держится')).text).toBe('не держится')
  })

  test('three prompts are held with the right counts, mid-turn too', async ($, on) => {
    const w = world(on)
    await run($, 'pack')
    expect(await say($, 'не начинай, пока не скажу')).toEqual({ drop: HELD(1) })
    expect(await say($, 'второе', { turnId: 'turn-7' })).toEqual({ drop: HELD(2) })
    expect(await say($, 'третье')).toEqual({ drop: HELD(3) })
    expect(w.submitted).toHaveLength(0)
  })

  test('a release word sends one numbered prompt and turns batching off', async ($, on) => {
    const w = world(on)
    await run($, 'pack')
    await say($, 'первое')
    await say($, 'второе')
    await say($, 'третье')
    const released = await say($, 'Всё!')
    const expected =
      'Пачка из 3 сообщений, надиктованных подряд — одна задача:\n\n1. первое\n\n2. второе\n\n3. третье'
    expect(released.text).toBe(expected)
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]?.text).toBe(expected)
    expect(w.submitted[0]?.origin).toEqual(ME)
    expect((await say($, 'после')).text).toBe('после')
  })

  test('every release word, with punctuation, case-insensitive', async ($, on) => {
    const w = world(on)
    for (const word of ['всё', 'Все.', 'ГОТОВО', 'отправляй!', 'поехали)', 'Go']) {
      await run($, 'pack')
      await say($, 'текст')
      expect((await say($, word)).text).toBe('текст')
    }
    expect(w.submitted).toHaveLength(6)
    await run($, 'pack')
    expect(await say($, 'всё, но не совсем')).toEqual({ drop: HELD(1) })
  })

  test('/pack again sends the batch as a prompt of its own', async ($, on) => {
    const w = world(on)
    await run($, 'pack')
    await say($, 'первое')
    await say($, 'второе')
    const out = await run($, 'pack')
    expect(out.text).toBe('📤 пачка из 2 сообщ. отправлена')
    await w.clock.settle()
    expect(w.toasts).toEqual([])
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]?.text).toBe(
      'Пачка из 2 сообщений, надиктованных подряд — одна задача:\n\n1. первое\n\n2. второе',
    )
    expect(w.submitted[0]?.origin).toEqual({ kind: 'plugin', name: 'dictate', asUser: true })
    expect((await say($, 'после')).text).toBe('после')
  })

  test('a batch of one goes as the message itself', async ($, on) => {
    const w = world(on)
    await run($, 'pack')
    await say($, 'одно')
    expect((await say($, 'готово')).text).toBe('одно')
    expect(w.submitted).toHaveLength(1)
  })

  test('/pack cancel discards the batch', async ($, on) => {
    const w = world(on)
    await run($, 'pack')
    await say($, 'раз')
    await say($, 'два')
    expect((await run($, 'pack', 'cancel')).text).toBe('🗑 пачка сброшена (2 сообщ.)')
    expect((await say($, 'три')).text).toBe('три')
    expect(w.submitted.map(p => p.text)).toEqual(['три'])
    expect((await run($, 'pack', 'cancel')).text).toBe('пачки нет — сбрасывать нечего')
  })

  test('a prompt with an attachment passes as is, with a toast, batch stays open', async ($, on) => {
    const w = world(on)
    await run($, 'pack')
    await say($, 'раз')
    const out = await say($, 'смотри скрин', { attachments: [{ type: 'image', mediaType: 'image/png' }] })
    expect(out.text).toBe('смотри скрин')
    expect(w.submitted).toHaveLength(1)
    expect(w.toasts.some(t => t.includes('пачка ещё открыта (1)'))).toBe(true)
    expect(await say($, 'два')).toEqual({ drop: HELD(2) })
  })

  test('prompts from plugins, notifications and peers are not held', async ($, on) => {
    const w = world(on)
    await run($, 'pack')
    const other = await $.prompt.submit({
      text: 'from another plugin',
      wait: false,
      origin: { kind: 'plugin', name: 'other' },
    })
    expect(other.text).toBe('from another plugin')
    await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' } })
    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'peer' }, turnId: 't' })
    expect(w.submitted).toHaveLength(3)
    expect(await say($, 'моё')).toEqual({ drop: HELD(1) })
  })

  test('a batch older than 12 h is discarded with a toast', async ($, on) => {
    const w = world(on)
    await run($, 'pack')
    await say($, 'старое')
    // The open pack reads the prompt box every second: move in hours, under the mock clock's 10 000 waits.
    for (let hour = 0; hour < 12; hour++) await w.clock.advance(HOUR)
    await w.clock.advance(1)
    expect((await say($, 'новое')).text).toBe('новое')
    expect(w.toasts.some(t => t.includes('старше 12 ч'))).toBe(true)
  })
})

describe('terms', () => {
  test('replaces whole phrases case-insensitively and names the fixes in context', async ($, on) => {
    const w = world(on)
    const out = await say($, 'Точка основного не сработала, поставь точку основного снова')
    expect(out.text).toBe('Точка останова не сработала, поставь точку останова снова')
    expect(w.submitted[0]?.context).toEqual([
      'dictation fixes: Точка основного → Точка останова; точку основного → точку останова',
    ])
  })

  test('leaves words that only contain the phrase, and adds no context without fixes', async ($, on) => {
    const w = world(on)
    const out = await say($, 'запяточка основного плана и просто текст')
    expect(out.text).toBe('запяточка основного плана и просто текст')
    expect(w.submitted[0]?.context).toBeUndefined()
  })

  test('fixes held messages when the batch is released', async ($, on) => {
    const w = world(on)
    await run($, 'pack')
    await say($, 'запиши точку основного')
    await say($, 'и продолжай')
    await say($, 'всё')
    expect(w.submitted[0]?.text).toContain('1. запиши точку останова')
    expect(w.submitted[0]?.context).toEqual(['dictation fixes: точку основного → точку останова'])
  })

  test('re-reads the file only when its mtime changes', async ($, on) => {
    const w = world(on)
    await say($, 'точка основного')
    await say($, 'точка основного')
    expect(w.reads).toBe(1)
    w.files.set(TERMS_PATH, { text: JSON.stringify({ 'кот лин': 'Kotlin' }), mtimeMs: 2 })
    expect((await say($, 'пиши на кот лин')).text).toBe('пиши на Kotlin')
    expect((await say($, 'точка основного')).text).toBe('точка основного')
    expect(w.reads).toBe(2)
  })

  test('no file: prompts pass untouched', async ($, on) => {
    const w = world(on, {})
    expect((await say($, 'точка основного')).text).toBe('точка основного')
    expect(w.submitted[0]?.context).toBeUndefined()
  })
})

describe('band', () => {
  test('draws the batch on terminal and desktop, defers when off', async ($, on) => {
    world(on)
    for (const surface of ['terminal', 'desktop'] as const) {
      const off = await $.ui.mount({ plugin: 'dictate', surface, component: 'AbovePrompt', props: ABOVE_PROMPT })
      expect(await off.find({ type: 'Text', text: 'beneath' })).toBeDefined()
      expect(await off.find({ type: 'Text', text: /пачка/ })).toBeUndefined()
      await off.unmount()

      await run($, 'pack')
      await say($, 'раз')
      const ui = await $.ui.mount({ plugin: 'dictate', surface, component: 'AbovePrompt', props: ABOVE_PROMPT })
      expect((await ui.find({ type: 'Text', text: /пачка: 1/ }))?.text).toBe(
        'пачка: 1 · всё — отправить · /pack cancel',
      )
      await say($, 'два')
      expect((await ui.find({ type: 'Text', text: /пачка/ }))?.text).toBe(BAND)
      expect(await ui.find({ type: 'Text', text: 'beneath' })).toBeUndefined()
      await ui.redraw({ ...ABOVE_PROMPT, hasSurvey: true })
      expect(await ui.find({ type: 'Text', text: 'beneath' })).toBeDefined()
      await ui.unmount()
      await run($, 'pack', 'cancel')
    }
  })
})
