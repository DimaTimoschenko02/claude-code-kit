import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, PromptEditInput, PromptSubmitInput } from 'claude-code'

// Claude Code's voice mode (tap) stops a recording 120 s after the tap and 15 s
// after the last word, and submits what it heard. These tests replay that on
// the prompt box: voice mode writes its interim transcript there while it
// records, the submit clears it, and a prompt a hook dropped lands back in it
// (after the draft on a new line, as the engine's 2.1.296 REPL does).

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
  playedAt: number[]
  spoken: { text: string; voice?: string }[]
  submitted: PromptSubmitInput[]
  fills: string[]
  /** ~/.claude/state/dictate/voice.log as the mod left it. */
  log: string
}

const LOG = '/home/fake/.claude/state/dictate/voice.log'

function world(on: On): World {
  const w: World = {
    clock: mock.clock(on, { now: 1_700_000_000_000 }),
    draft: '',
    reads: 0,
    played: [],
    playedAt: [],
    spoken: [],
    submitted: [],
    fills: [],
    log: '',
  }
  mock.env(on, { HOME: '/home/fake' })
  on('fs.stat', ($, e) => ({ deny: `ENOENT: ${e.path}` }))
  on('fs.read', ($, e) => (e.path === LOG && w.log !== '' ? { value: w.log } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', ($, e) => {
    if (e.path !== LOG) return { deny: `unexpected write: ${e.path}` }
    w.log = e.text
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '+0300\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: 'ada8bcdd-0000-4000-8000-000000000000' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.read', () => {
    w.reads += 1
    return { value: { text: w.draft, cursor: w.draft.length } }
  })
  on('audio.play', ($, e) => {
    if (e.clip.asset !== undefined) w.played.push(e.clip.asset)
    w.playedAt.push(w.clock.now())
    return { value: undefined }
  })
  on('audio.speak', ($, e) => {
    w.spoken.push({ text: e.text, voice: e.voice })
    return { value: { via: 'system' as const } }
  })
  on('prompt.fill', ($, e) => {
    w.fills.push(e.text)
    w.draft = e.mode === 'replace' ? e.text : `${w.draft}${e.text}`
    return { isFilled: true }
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

/**
 * A first recording after an idle spell: voice mode buffers the audio while it
 * connects (`[voice] startRecording: buffering audio while WebSocket connects`)
 * and the box stays empty; once connected it shows everything said so far at
 * once, then goes on word by word. Its 120 s cap counts from the tap.
 */
async function dictateAfterSlowConnect(w: World, text: string, connectMs: number, totalMs: number): Promise<void> {
  const words = text.split(' ')
  const perWord = totalMs / words.length
  await w.clock.advance(connectMs)
  const said = Math.floor(connectMs / perWord)
  w.draft = words.slice(0, said).join(' ')
  for (let i = said + 1; i <= words.length; i++) {
    await w.clock.advance(perWord)
    w.draft = words.slice(0, i).join(' ')
  }
}

const logLines = (w: World) => w.log.split('\n').filter(line => line !== '')

/** The engine putting a dropped prompt back in the box (REPL `hI`/`gI`). */
const land = (draft: string, text: string) => (draft.trim() === '' ? text : `${draft}\n${text}`)

/**
 * Voice mode finishing: the box clears and the transcript is submitted; a drop
 * lands back in the box, after whatever `typedMeanwhile` is there by then.
 */
async function send($: Engine, w: World, text: string, typedMeanwhile = '') {
  w.draft = ''
  const out = await $.prompt.submit({ text, wait: false, origin: ME })
  if (out.drop !== undefined) w.draft = land(typedMeanwhile, text)
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
    expect(await bandLines($)).toEqual([
      'пачка: 2 · всё — отправить · /pack cancel',
      '✓ в пачке, конец: Функция create в tag-сервисе. Дальше.',
    ])

    await dictate(w, CAPPED, 119 * SEC)
    await send($, w, CAPPED)
    expect(await bandLines($)).toHaveLength(2)
    await send($, w, 'всё')
    expect(await bandLines($)).toEqual([])
  })
  test('a held chunk leaves the box empty for the next recording, its end shown above', async ($, on) => {
    const w = world(on)
    await run($)
    await dictate(w, CAPPED, 119 * SEC)
    await send($, w, CAPPED)
    expect(w.draft).toBe('')
    expect((await bandLines($))[1]).toBe(`✂ запись оборвалась (лимит 2 мин), конец: ${CAPPED}`)

    const own = 'Контроллер модуль, ну, окей. Дальше смотрим сервисы.'
    await dictate(w, own, 20 * SEC)
    await send($, w, own)
    expect(w.draft).toBe('')
    expect((await bandLines($))[1]).toBe(`✓ в пачке, конец: ${own}`)
  })

  test('a note typed into the box before the chunk landed stays', async ($, on) => {
    const w = world(on)
    await run($)
    await dictate(w, CHUNK_5, 119 * SEC)
    await send($, w, CHUNK_5, 'и ещё про color')
    expect(w.draft).toBe('и ещё про color')
  })

  test('the release word on an empty pack does not stay in the box', async ($, on) => {
    const w = world(on)
    await run($)
    expect(await send($, w, 'всё')).toEqual({ drop: 'пачка пуста — выключена' })
    expect(w.draft).toBe('')
  })

  test('a chunk left in the box and sent again is not held twice (the 7-message pack of 2026-10-12)', async ($, on) => {
    const w = world(on)
    await run($)
    await dictate(w, CHUNK_5, 119 * SEC)
    await send($, w, CHUNK_5)
    // The old box text sent again, alone and with a new recording after it.
    expect((await send($, w, CHUNK_5)).drop).toBe(`${HELD(1)} · это уже было в пачке — не добавлено`)
    await send($, w, `${CHUNK_5} И в контроллерах то же самое.`)
    expect((await bandLines($))[1]).toBe('✓ в пачке, конец: И в контроллерах то же самое.')
    const released = await send($, w, 'всё')
    expect(released.text).toBe(
      'Пачка из 2 сообщений, надиктованных подряд — одна задача:\n\n' +
        `1. ${CHUNK_5}${CUT_MARK}\n\n` +
        '2. И в контроллерах то же самое.',
    )
  })

  test('an earlier chunk sent again is not held twice either', async ($, on) => {
    const w = world(on)
    await run($)
    const first = 'Смотрим на helper tag SQL. Вот нахуя нам этот helper.'
    await send($, w, first)
    await send($, w, 'Контроллер модуль, ну, окей. Дальше смотрим сервисы.')
    expect((await send($, w, first)).drop).toBe(`${HELD(2)} · это уже было в пачке — не добавлено`)
    expect((await bandLines($))[1]).toBe('✓ в пачке, конец: Контроллер модуль, ну, окей. Дальше смотрим сервисы.')
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

  // 2026-10-19: the first chunk of a pack ran into the 2-minute cap with no
  // warning and no cut beep, and was held as the owner's own stop; the next
  // chunks of the same pack warned. The cap counts from the tap, the mod
  // counted from the first text the box showed.
  test('a first recording after a slow connect still warns ~15 s before the cap and reads as the cap', async ($, on) => {
    const w = world(on)
    await run($)
    const talk = `${'Так, смотри, по задачам в базе: тип, слой, кто просил и зачем. '.repeat(21)}и вот`
    const tap = w.clock.now()
    await dictateAfterSlowConnect(w, talk, 13 * SEC, 119 * SEC)
    expect(w.played[0]).toBe('sounds/warn.wav')
    const lead = 120 * SEC - ((w.playedAt[0] ?? Infinity) - tap)
    expect(lead).toBeGreaterThanOrEqual(10 * SEC)
    expect(lead).toBeLessThanOrEqual(20 * SEC)
    await w.clock.advance(1 * SEC)
    const out = await send($, w, talk)
    expect(out.drop).toBe(`${HELD(1)} · ✂ запись оборвалась (лимит 2 мин) — где, видно над полем ввода`)
    expect(w.played).toEqual(['sounds/warn.wav', 'sounds/cut.wav'])
  })

  test('a key typed and erased before the tap does not silence the next recording', async ($, on) => {
    const w = world(on)
    await run($)
    const editor = $.prompt as unknown as { edit: (e: PromptEditInput) => Promise<unknown> }
    await editor.edit({ origin: ME, key: { key: 'ф' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'ф' })
    w.draft = 'ф'
    await w.clock.advance(2 * SEC)
    await editor.edit({ origin: ME, key: { key: 'backspace' }, text: 'ф', cursor: 1, start: 0, end: 1, inputText: '' })
    w.draft = ''
    await w.clock.advance(2 * SEC)
    await dictate(w, CAPPED, 119 * SEC)
    expect(w.played).toEqual(['sounds/warn.wav'])
    expect((await send($, w, CAPPED)).drop).toContain('✂ запись оборвалась')
  })

  test('every warning and held chunk is a line in the voice log, shown by /pack log', async ($, on) => {
    const w = world(on)
    expect((await run($, 'log')).text).toBe('журнал записей пуст: ~/.claude/state/dictate/voice.log')
    await run($)
    await dictate(w, CAPPED, 119 * SEC)
    await send($, w, CAPPED)
    const own = 'Контроллер модуль, ну, окей. Дальше смотрим сервисы.'
    await dictate(w, own, 20 * SEC)
    await send($, w, own)
    await send($, w, `${'слово '.repeat(120)}как tag,`)
    const lines = logLines(w)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toMatch(/^2023-11-15 01:\d\d:\d\d ada8bcdd warn played · 10[3-4] s since the speech began$/)
    expect(lines[1]).toMatch(/ ada8bcdd chunk 1: cap, 119 chars · 11[89] s since the speech began, still \d s · warned$/)
    expect(lines[2]).toMatch(/ chunk 2: own, 52 chars · 2\d s since the speech began, still \d s · no warning$/)
    expect(lines[3]).toMatch(/ chunk 3: cap, 728 chars · the box never showed it, judged by its end$/)
    const shown = (await run($, 'log')).text ?? ''
    expect(shown.split('\n')).toEqual([
      'журнал записей (~/.claude/state/dictate/voice.log), последние 4:',
      ...lines,
    ])
  })
})
