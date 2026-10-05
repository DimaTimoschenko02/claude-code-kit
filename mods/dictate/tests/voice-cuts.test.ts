import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, PromptEditInput, PromptSubmitInput } from 'claude-code'

// Claude Code's voice mode (tap) stops a recording 120 s after the tap and 15 s
// after the last word, and submits what it heard. These tests replay that on
// the prompt box: voice mode writes its interim transcript there while it
// records, and the submit clears it.

const ME = { kind: 'composer' } as const
const PRESENTATION = { isFullscreen: true, columns: 120 }
const SEC = 1000
const HELD = (n: number) =>
  `📥 в пачке ${n} — «всё» или /pack, чтобы отправить; /pack cancel — сбросить`
// Chunk 5 of the same pack, cut mid-sentence.
const CHUNK_5 =
  'Модули, контроллеры. Ну, к модулям, контроллерам вроде вопросов нету. К сервисам. ' +
  'Вот знаешь, чего не хватает, в принципе, у тебя в коде, это более полноценных названий переменных. ' +
  'Например, вот функция create в tag-сервисе. Там мы делаем trim name, а делаем lower, lowercase color, ' +
  'и тому подобное. Можно было бы это назвать как-то normalized name, типа color to lowercase, то есть, ну, ' +
  'в таких моментах это понятно, тут пять слов во всей строчке,'
const CUT_MARK = ' ⟨запись оборвалась здесь — следующее сообщение может повторять конец⟩'

// The owner's first chunk of 2026-10-05, cut by the 2-minute cap mid-sentence.
const CAPPED =
  'То есть, смысл в том, что по всему проекту у нас были универсальные фильтры. ' +
  'Потому что вот такие вот костыли, как tag,'

type World = {
  clock: MockClock
  draft: string
  reads: number
  played: string[]
  spoken: { text: string; voice?: string }[]
  submitted: PromptSubmitInput[]
}

function world(on: On): World {
  const w: World = {
    clock: mock.clock(on, { now: 1_700_000_000_000 }),
    draft: '',
    reads: 0,
    played: [],
    spoken: [],
    submitted: [],
  }
  mock.env(on, { HOME: '/home/fake' })
  on('fs.stat', ($, e) => ({ deny: `ENOENT: ${e.path}` }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.read', () => {
    w.reads += 1
    return { value: { text: w.draft, cursor: w.draft.length } }
  })
  on('audio.play', ($, e) => {
    if (e.clip.asset !== undefined) w.played.push(e.clip.asset)
    return { value: undefined }
  })
  on('audio.speak', ($, e) => {
    w.spoken.push({ text: e.text, voice: e.voice })
    return { value: { via: 'system' as const } }
  })
  on('prompt.edit', ($, e) => ({
    text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end),
    cursor: e.start + e.inputText.length,
  }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'beneath' })
  })
  on('prompt.submit', ($, e) => {
    w.submitted.push(e)
    return { text: e.text, context: e.context }
  })
  return w
}

const ABOVE_PROMPT = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

/** The band above the prompt as text lines, [] when the mod draws nothing. */
async function bandLines($: Engine): Promise<string[]> {
  const ui = await $.ui.mount({ plugin: 'dictate', surface: 'terminal', component: 'AbovePrompt', props: ABOVE_PROMPT })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return texts.map(t => String(t.text)).filter(t => t !== 'beneath')
}

const run = ($: Engine, args = '') =>
  $.command.run({ command: 'pack', args, origin: ME, presentation: PRESENTATION })

/** Voice mode writing `text` into the box word by word over `ms`. */
async function dictate(w: World, text: string, ms: number): Promise<void> {
  const words = text.split(' ')
  const step = ms / words.length
  for (let i = 1; i <= words.length; i++) {
    w.draft = words.slice(0, i).join(' ')
    await w.clock.advance(step)
  }
}

/** Voice mode finishing: the box clears and the transcript is submitted. */
async function send($: Engine, w: World, text: string) {
  const out = await $.prompt.submit({ text, wait: false, origin: ME })
  w.draft = ''
  await w.clock.settle()
  return out
}

describe('voice cuts in a pack', () => {
  test('two minutes of talk: a double beep before the cap, one beep at it, no words', async ($, on) => {
    const w = world(on)
    await run($)
    await dictate(w, CAPPED, 100 * SEC)
    expect(w.played).toEqual([])
    await dictate(w, CAPPED, 20 * SEC)
    expect(w.played).toEqual(['sounds/warn.wav'])

    const out = await send($, w, CAPPED)
    expect(out).toEqual({ drop: `${HELD(1)} · ✂ запись оборвалась (лимит 2 мин) — где, видно над полем ввода` })
    expect(w.played).toEqual(['sounds/warn.wav', 'sounds/cut.wav'])
    expect(w.spoken).toEqual([])
    expect(await bandLines($)).toEqual([
      'пачка: 1 · всё — отправить · /pack cancel',
      `✂ запись оборвалась (лимит 2 мин), конец: ${CAPPED}`,
    ])
  })

  test('the capped chunk is marked in the pack so the model expects the repeat', async ($, on) => {
    const w = world(on)
    await run($)
    await dictate(w, CAPPED, 119 * SEC)
    await send($, w, CAPPED)
    await dictate(w, 'Бля, я хз, в каком моменте прервалось. Про фильтры повторю.', 20 * SEC)
    await send($, w, 'Бля, я хз, в каком моменте прервалось. Про фильтры повторю.')
    const released = await send($, w, 'всё')
    expect(released.text).toBe(
      'Пачка из 2 сообщений, надиктованных подряд — одна задача:\n\n' +
        `1. ${CAPPED}${CUT_MARK}\n\n` +
        '2. Бля, я хз, в каком моменте прервалось. Про фильтры повторю.',
    )
  })

  test('a 15-second pause that stopped the recording beeps and shows, not marked', async ($, on) => {
    const w = world(on)
    await run($)
    const text = 'Смотрим на helper tag SQL. Вот нахуя нам этот helper.'
    await dictate(w, text, 30 * SEC)
    await w.clock.advance(15 * SEC)
    const out = await send($, w, text)
    expect(out).toEqual({ drop: `${HELD(1)} · ⏸ запись встала на паузе — где, видно над полем ввода` })
    expect(w.spoken).toEqual([])
    expect(w.played).toEqual(['sounds/cut.wav'])
    expect((await bandLines($))[1]).toBe(`⏸ запись встала на паузе 15 с, конец: ${text}`)
    const released = await send($, w, 'всё')
    expect(released.text).toBe(text)
  })

  test('his own tap mid-flow stays silent', async ($, on) => {
    const w = world(on)
    await run($)
    const text = 'Контроллер модуль, ну, окей. Дальше смотрим'
    await dictate(w, text, 40 * SEC)
    expect(await send($, w, text)).toEqual({ drop: HELD(1) })
    expect(w.played).toEqual([])
    expect(w.spoken).toEqual([])
  })

  test('a typed draft sent after a long look is his own send', async ($, on) => {
    const w = world(on)
    await run($)
    // prompt.edit is the engine's own event: the test engine runs it, its type does not list it.
    const editor = $.prompt as unknown as { edit: (e: PromptEditInput) => Promise<unknown> }
    await editor.edit({ origin: ME, key: { key: 'к' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'к' })
    await dictate(w, 'коротко руками', 3 * SEC)
    await w.clock.advance(140 * SEC)
    expect(await send($, w, 'коротко руками')).toEqual({ drop: HELD(1) })
    expect(w.spoken).toEqual([])
  })

  test('a long chunk the box never showed falls back to how it ends', async ($, on) => {
    const w = world(on)
    await run($)
    const long = `${'слово '.repeat(120)}как tag,`
    expect((await send($, w, long)).drop).toContain('✂ запись оборвалась')
    const [, line] = await bandLines($)
    expect(line).toBe(`✂ запись оборвалась (лимит 2 мин), конец: …${long.slice(-320).trimStart()}`)
    expect((await send($, w, `${'слово '.repeat(120)}конец.`)).drop).toBe(HELD(2))
    expect((await send($, w, 'короткое без точки')).drop).toBe(HELD(3))
  })

  test('the box is read only while a pack is open', async ($, on) => {
    const w = world(on)
    await w.clock.advance(10 * SEC)
    expect(w.reads).toBe(0)
    await run($)
    await w.clock.advance(3 * SEC)
    expect(w.reads).toBe(3)
    await run($, 'cancel')
    await w.clock.advance(10 * SEC)
    expect(w.reads).toBe(3)
    await dictate(w, CAPPED, 125 * SEC)
    await send($, w, CAPPED)
    expect(w.played).toEqual([])
    expect(w.spoken).toEqual([])
  })

  test('the band keeps the last sentences of a long cut chunk until the next chunk', async ($, on) => {
    const w = world(on)
    await run($)
    await dictate(w, CHUNK_5, 119 * SEC)
    await send($, w, CHUNK_5)
    const [, line] = await bandLines($)
    const label = '✂ запись оборвалась (лимит 2 мин), конец: '
    expect(line?.startsWith(`${label}…Например, вот функция create в tag-сервисе. Там мы делаем trim name`)).toBe(true)
    expect(line?.endsWith('тут пять слов во всей строчке,')).toBe(true)
    expect((line ?? '').length - label.length).toBeLessThanOrEqual(321)

    await dictate(w, 'Функция create в tag-сервисе. Дальше.', 10 * SEC)
    await send($, w, 'Функция create в tag-сервисе. Дальше.')
    expect(await bandLines($)).toEqual(['пачка: 2 · всё — отправить · /pack cancel'])

    await dictate(w, CAPPED, 119 * SEC)
    await send($, w, CAPPED)
    expect(await bandLines($)).toHaveLength(2)
    await send($, w, 'всё')
    expect(await bandLines($)).toEqual([])
  })
  test('the excerpt is the last three sentences, whole ones only within 320 chars', async ($, on) => {
    const w = world(on)
    await run($)
    const label = '✂ запись оборвалась (лимит 2 мин), конец: '
    const short = `${'Раз. Два. Три. '.repeat(40)}Четыре. Пять, шесть`
    await send($, w, short)
    expect((await bandLines($))[1]).toBe(`${label}…Три. Четыре. Пять, шесть`)
    const long = `${'а'.repeat(300)}. ${'б'.repeat(100)}. ${'в '.repeat(60)}и вот,`
    await send($, w, long)
    expect((await bandLines($))[1]).toBe(`${label}…${'б'.repeat(100)}. ${'в '.repeat(60)}и вот,`)
  })
})
