import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { aliveUntil, classify, hoursText, nextWarm, parse } from '../hooks/logic'

const MIN = 60_000
// 10:00 UTC; `date +%z` answers +0300, so the owner's clock reads 13:00.
const T0 = Date.UTC(2026, 9, 4, 10, 0)

const WAITS = [
  '### Ждёт тебя',
  '- **респавн** — `claude respawn ab12cd34`, чтобы мод загрузился',
  '',
  '### Сделано',
  '- **мод** — собран, тесты зелёные',
  '',
  '---',
  'result: мод собран и подключён',
].join('\n')
const NOTHING = ['**Ждёт тебя:** от тебя ничего.', '', '### Сделано', '- **PH-95** — на стенде', '', '---', 'result: PH-95 на стенде'].join('\n')
const NEEDS_INPUT = 'Упёрся в доступ.\n\nneeds input: дай токен GitHub с правом repo'
const MID_WORK = 'Тесты прошли, дальше подключаю мод в settings.'

type World = { store: Map<string, unknown>; forks: number; statuses: (string | undefined)[]; sid: { value: string }; clock: ReturnType<typeof mock.clock> }

function world(on: On): World {
  const w: World = { store: new Map(), forks: 0, statuses: [], sid: { value: 'sess-1' }, clock: mock.clock(on, { now: T0 }) }
  on('store.get', (_$, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_$, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('session.id', () => ({ value: w.sid.value }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '+0300\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('model.fork', () => {
    w.forks++
    return {
      value: {
        isAnswered: true,
        text: 'ok',
        usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 180_000, cache_creation_input_tokens: 0 },
      },
    } as never
  })
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  return w
}

const start = ($: Engine) => $.session.start({ cwd: '/home/fake/proj', surface: 'terminal', isInteractive: true })
const reply = async ($: Engine, answer: string) => {
  await $.turn.start({ text: 'x', turnId: 't' } as never)
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
}
const warm = ($: Engine, args: string) =>
  $.command.run({ command: 'warm', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
const textOf = (r: unknown) => (r as { text: string }).text

describe('logic', () => {
  test('a reply that waits for the owner or asks for input warms; a result or mid-work line does not', () => {
    expect(classify(WAITS)).toBe('waits')
    expect(classify(NEEDS_INPUT)).toBe('needs-input')
    expect(classify(NOTHING)).toBe('result')
    expect(classify('**Ждёт тебя:** от тебя ничего.\n\nПродолжаю.')).toBe('nothing-waits')
    expect(classify(MID_WORK)).toBe('other')
  })

  test('a 2 h window on a 60 min cache: warms at 50 and 100 min, alive until 160 min', () => {
    expect(nextWarm(0, 0, 2, 60)).toBe(50 * MIN)
    expect(nextWarm(0, 50 * MIN, 2, 60)).toBe(100 * MIN)
    expect(nextWarm(0, 100 * MIN, 2, 60)).toBeNull()
    expect(aliveUntil(0, 2, 60)).toBe(160 * MIN)
    // A 5 min cache costs more to warm than to rewrite.
    expect(nextWarm(0, 0, 2, 5)).toBeNull()
  })

  test('the command reads hours, minutes, modes and the default in both languages', () => {
    expect(parse('')).toEqual({ kind: 'status' })
    expect(parse('3')).toEqual({ kind: 'hours', hours: 3 })
    expect(parse('90 мин')).toEqual({ kind: 'hours', hours: 1.5 })
    expect(parse('стоп')).toEqual({ kind: 'mode', mode: 'off' })
    expect(parse('всегда')).toEqual({ kind: 'mode', mode: 'on' })
    expect(parse('default 4h')).toEqual({ kind: 'default', hours: 4 })
    expect(parse('1h 30m')).toEqual({ kind: 'hours', hours: 1.5 })
    expect(parse('2ч15м')).toEqual({ kind: 'hours', hours: 2.25 })
    expect(parse('2 hours 10 minutes')).toEqual({ kind: 'hours', hours: 2 + 10 / 60 })
    expect(parse('default 1h 45m')).toEqual({ kind: 'default', hours: 1.75 })
    // Hours past a day, a unit dropped after the first part, words: no guess.
    expect(parse('30').kind).toBe('error')
    expect(parse('1h 30').kind).toBe('error')
    expect(parse('1h abc').kind).toBe('error')
    expect([hoursText(2), hoursText(1.5), hoursText(0.75)]).toEqual(['2 ч', '1 ч 30 мин', '45 мин'])
  })
})

describe('session', () => {
  test('a waiting reply forks at 50 and 100 min and stops; the status says until when', async ($, on) => {
    const w = world(on)
    await start($)
    await reply($, WAITS)
    expect(w.statuses.at(-1)).toBe('кэш до 15:40')
    await w.clock.advance(49 * MIN)
    expect(w.forks).toBe(0)
    await w.clock.advance(1 * MIN)
    expect(w.forks).toBe(1)
    await w.clock.advance(50 * MIN)
    expect(w.forks).toBe(2)
    await w.clock.advance(59 * MIN)
    expect(w.statuses.at(-1)).toBe('кэш до 15:40')
    await w.clock.advance(1 * MIN)
    expect(w.statuses.at(-1)).toBeUndefined()
    await w.clock.advance(120 * MIN)
    expect(w.forks).toBe(2)
  })

  test('a result-only reply stays cold until /warm on', async ($, on) => {
    const w = world(on)
    await start($)
    await reply($, NOTHING)
    await w.clock.advance(60 * MIN)
    expect(w.forks).toBe(0)
    // The reply is 60 min old: the next warm on its 50 min grid is at 100 min.
    expect(textOf(await warm($, 'on'))).toContain('после каждого ответа')
    await w.clock.advance(40 * MIN)
    expect(w.forks).toBe(1)
  })

  test("the owner's message ends the window; a slash command does not", async ($, on) => {
    const w = world(on)
    await start($)
    await reply($, WAITS)
    await $.prompt.submit({ text: '/warm', wait: false, origin: { kind: 'composer' } })
    await warm($, '')
    await w.clock.advance(50 * MIN)
    expect(w.forks).toBe(1)
    await $.prompt.submit({ text: 'дальше', wait: false, origin: { kind: 'composer' } })
    expect(w.statuses.at(-1)).toBeUndefined()
    await w.clock.advance(100 * MIN)
    expect(w.forks).toBe(1)
  })

  test("a session's own window survives its restart; another session takes the default", async ($, on) => {
    const w = world(on)
    await start($)
    expect(textOf(await warm($, '3'))).toContain('окно 3 ч (своё у этой сессии)')
    expect(textOf(await warm($, '1h 30m'))).toContain('окно 1 ч 30 мин (своё у этой сессии)')
    expect(textOf(await warm($, '40m'))).toContain('прогревов не будет')
    await warm($, '3')

    w.sid.value = 'sess-2'
    await start($)
    expect(textOf(await warm($, ''))).toContain('окно 2 ч (по умолчанию)')
    expect(textOf(await warm($, 'default 4'))).toContain('По умолчанию для новых сессий: 4 ч.')
    expect(textOf(await warm($, ''))).toContain('окно 4 ч (по умолчанию)')

    w.sid.value = 'sess-1'
    await start($)
    expect(textOf(await warm($, ''))).toContain('окно 3 ч (своё у этой сессии)')
    await reply($, WAITS)
    // 3 h on a 50 min grid: warms at 50, 100, 150 min.
    await w.clock.advance(200 * MIN)
    expect(w.forks).toBe(3)
  })

  test('/warm off keeps a waiting reply cold', async ($, on) => {
    const w = world(on)
    await start($)
    await warm($, 'off')
    await reply($, WAITS)
    await w.clock.advance(120 * MIN)
    expect(w.forks).toBe(0)
  })
})
