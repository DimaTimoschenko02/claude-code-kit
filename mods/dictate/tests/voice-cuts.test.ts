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
  installedVoices: Set<string>
}

function world(on: On): World {
  const w: World = {
    clock: mock.clock(on, { now: 1_700_000_000_000 }),
    draft: '',
    reads: 0,
    played: [],
    spoken: [],
    submitted: [],
    installedVoices: new Set(['Milena']),
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
    if (e.voice !== undefined && !w.installedVoices.has(e.voice)) return { deny: `no voice ${e.voice}` }
    w.spoken.push({ text: e.text, voice: e.voice })
    return { value: { via: 'system' as const } }
  })
  on('prompt.edit', ($, e) => ({
    text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end),
    cursor: e.start + e.inputText.length,
  }))
  on('prompt.submit', ($, e) => {
    w.submitted.push(e)
    return { text: e.text, context: e.context }
  })
  return w
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
  test('two minutes of talk: a chime before the cap, then a tone and the last words aloud', async ($, on) => {
    const w = world(on)
    await run($)
    await dictate(w, CAPPED, 100 * SEC)
    expect(w.played).toEqual([])
    await dictate(w, CAPPED, 20 * SEC)
    expect(w.played).toEqual(['sounds/warn.wav'])

    const out = await send($, w, CAPPED)
    expect(out).toEqual({
      drop: `${HELD(1)} · ✂ запись оборвалась (лимит 2 мин) на «…вот такие вот костыли как tag» — продолжай с этого места`,
    })
    expect(w.played).toEqual(['sounds/warn.wav', 'sounds/cut.wav'])
    expect(w.spoken).toEqual([{ text: 'Обрыв. Конец: вот такие вот костыли как tag', voice: 'Milena' }])
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

  test('a 15-second pause that stopped the recording is announced, not marked', async ($, on) => {
    const w = world(on)
    await run($)
    const text = 'Смотрим на helper tag SQL. Вот нахуя нам этот helper.'
    await dictate(w, text, 30 * SEC)
    await w.clock.advance(15 * SEC)
    const out = await send($, w, text)
    expect(out).toEqual({
      drop: `${HELD(1)} · ⏸ запись остановилась на паузе на «…SQL Вот нахуя нам этот helper» — продолжай с этого места`,
    })
    expect(w.spoken.map(s => s.text)).toEqual(['Пауза, запись стоп. Конец: SQL Вот нахуя нам этот helper'])
    expect(w.played).toEqual(['sounds/cut.wav'])
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

  test('speech falls back to the default voice when Milena is missing', async ($, on) => {
    const w = world(on)
    w.installedVoices.clear()
    await run($)
    await dictate(w, CAPPED, 119 * SEC)
    await send($, w, CAPPED)
    expect(w.spoken).toEqual([{ text: 'Обрыв. Конец: вот такие вот костыли как tag', voice: undefined }])
  })
})
