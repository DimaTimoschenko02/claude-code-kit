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

type World = {
  store: Map<string, unknown>
  forks: number
  /** Files the mod wrote, by path. */
  files: Map<string, string>
  /** What the next forks answer, in order; an empty list answers with a cache read. */
  forkAnswers: unknown[]
  /** Every line cache-warm set, in order. */
  statuses: (string | undefined)[]
  /** The row each plugin holds on screen now: the engine keeps one per plugin. */
  rows: Map<string, string | undefined>
  sid: { value: string }
  clock: ReturnType<typeof mock.clock>
}

/** What the status bar shows: every plugin's row that is set. */
const onScreen = (w: World) => [...w.rows.values()].filter(t => t !== undefined)

function world(on: On): World {
  const w: World = {
    store: new Map(),
    forks: 0,
    files: new Map(),
    forkAnswers: [],
    statuses: [],
    rows: new Map(),
    sid: { value: 'sess-1' },
    clock: mock.clock(on, { now: T0 }),
  }
  mock.env(on, { HOME: '/home/fake' })
  on('fs.read', (_$, e) => ({ value: w.files.get(e.path) ?? '' }))
  on('fs.write', (_$, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
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
    const planned = w.forkAnswers.shift()
    if (planned !== undefined) return { value: planned } as never
    return {
      value: {
        isAnswered: true,
        text: 'ok',
        usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 180_000, cache_creation_input_tokens: 0 },
      },
    } as never
  })
  on('ui.status', (_$, e, next) => {
    if (next.origin.plugin === 'cache-warm') w.statuses.push(e.text)
    w.rows.set(next.origin.plugin, e.text)
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
    expect(w.statuses.at(-1)).toBe('🔥 кэш до 15:40')
    await w.clock.advance(49 * MIN)
    expect(w.forks).toBe(0)
    await w.clock.advance(1 * MIN)
    expect(w.forks).toBe(1)
    await w.clock.advance(50 * MIN)
    expect(w.forks).toBe(2)
    // The last warm is done: no warm left to keep it, the time is the cache's own expiry.
    expect(w.statuses.at(-1)).toBe('кэш до 15:40')
    await w.clock.advance(59 * MIN)
    expect(w.statuses.at(-1)).toBe('кэш до 15:40')
    await w.clock.advance(1 * MIN)
    expect(w.statuses.at(-1)).toBeUndefined()
    await w.clock.advance(120 * MIN)
    expect(w.forks).toBe(2)
  })

  test('/warm says when the next warm runs and what the last one read, so the owner sees the mod alive', async ($, on) => {
    const w = world(on)
    await start($)
    await reply($, WAITS)
    // Reply at 13:00 owner time: warms at 13:50 and 14:40, cache alive until 15:40.
    let text = textOf(await warm($, ''))
    expect(text).toContain('Греет: следующий прогрев в 13:50 (через 50 мин), кэш жив до 15:40.')
    expect(text).toContain('Прогревов в этом окне ещё не было.')
    await w.clock.advance(20 * MIN)
    expect(textOf(await warm($, ''))).toContain('следующий прогрев в 13:50 (через 30 мин)')
    await w.clock.advance(30 * MIN)
    text = textOf(await warm($, ''))
    expect(text).toContain('следующий прогрев в 14:40 (через 50 мин)')
    expect(text).toContain('Прогревов в этом окне: 1, последний в 13:50 — 180 000 токенов из кэша.')
    await w.clock.advance(50 * MIN)
    text = textOf(await warm($, ''))
    expect(text).toContain('Греет: прогревы этого окна сделаны, кэш жив до 15:40.')
    expect(text).toContain('Прогревов в этом окне: 2, последний в 14:40')
    await w.clock.advance(60 * MIN)
    expect(textOf(await warm($, ''))).toContain('Сейчас не греет: кэш последнего ответа уже истёк')
  })

  test('/warm after a reply that waits for nothing says why it is cold', async ($, on) => {
    world(on)
    await start($)
    await reply($, NOTHING)
    expect(textOf(await warm($, ''))).toContain('Сейчас не греет: последний ответ не ждёт тебя')
  })

  test('a result-only reply stays cold until /warm on; once its cache lapsed there is nothing to keep', async ($, on) => {
    const w = world(on)
    await start($)
    await reply($, NOTHING)
    await w.clock.advance(30 * MIN)
    expect(w.forks).toBe(0)
    expect(textOf(await warm($, 'on'))).toContain('следующий прогрев в 13:50')
    await w.clock.advance(20 * MIN)
    expect(w.forks).toBe(1)

    await reply($, NOTHING)
    await warm($, 'auto')
    await w.clock.advance(61 * MIN)
    // The reply's cache died a minute ago: `/warm on` now would only rewrite it, so nothing is planned.
    expect(textOf(await warm($, 'on'))).toContain('кэш последнего ответа уже истёк, держать нечего')
    await w.clock.advance(120 * MIN)
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
    // The warm at 13:50 renewed the cache for an hour; the window's later warms are off.
    expect(w.statuses.at(-1)).toBe('кэш до 14:50')
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

describe('status line', () => {
  test('a result-only reply in auto mode is not warmed, yet the line says the cache lives an hour after it', async ($, on) => {
    const w = world(on)
    await start($)
    await reply($, NOTHING)
    // Not warmed: no fire, so the hour after the reply does not read as the 2 h window gone wrong.
    expect(w.statuses.at(-1)).toBe('кэш до 14:00')
    await reply($, MID_WORK)
    expect(w.statuses.at(-1)).toBe('кэш до 14:00')
    await w.clock.advance(59 * MIN)
    expect(w.statuses.at(-1)).toBe('кэш до 14:00')
    await w.clock.advance(1 * MIN)
    expect(w.statuses.at(-1)).toBeUndefined()
    expect(w.forks).toBe(0)
  })

  test('a running turn keeps the line instead of blanking it, a TTL from its start, renewed while it runs', async ($, on) => {
    const w = world(on)
    await start($)
    await reply($, NOTHING)
    await w.clock.advance(30 * MIN)
    await $.prompt.submit({ text: 'дальше', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'дальше', turnId: 't2' } as never)
    expect(w.statuses.at(-1)).toBe('кэш до 14:30')
    // A turn longer than the TTL still sends requests: the cache part does not go mid-turn.
    await w.clock.advance(70 * MIN)
    expect(w.statuses.at(-1)).toBe('кэш до 15:30')
    // Nothing blank since the first reply (the one before it is the empty line set at start).
    expect(w.statuses.slice(1)).not.toContain(undefined)
  })

  test('/warm off after a reply that was warmed shows the cache the last warm bought', async ($, on) => {
    const w = world(on)
    await start($)
    await reply($, WAITS)
    await w.clock.advance(50 * MIN)
    expect(w.forks).toBe(1)
    await warm($, 'off')
    expect(w.statuses.at(-1)).toBe('кэш до 14:50')
  })

  test(
    'with stop-point loaded both parts share one line and stop-point keeps no row of its own',
    {
      plugins: [
        {
          name: 'stop-point',
          register(on) {
            on('turn.complete', async ($, e, next) => {
              const r = await next(e)
              if (e.agentId === undefined) $.ui.status(`точка ${e.answer.length > 50 ? '13:00' : '12:00'}`)
              return r
            })
            on('prompt.submit', ($, e, next) => {
              if (e.text === 'compact') $.ui.status('точка пишется…')
              if (e.text === 'gone') $.ui.status(undefined)
              return next(e)
            })
          },
        },
      ],
    },
    async ($, on) => {
      const w = world(on)
      await start($)
      await reply($, WAITS)
      expect(onScreen(w)).toEqual(['🔥 кэш до 15:40 · точка 13:00'])
      expect(w.rows.get('stop-point')).toBeUndefined()
      await $.prompt.submit({ text: 'compact', wait: false, origin: { kind: 'composer' } })
      expect(onScreen(w)).toEqual(['кэш до 14:00 · точка пишется…'])
      // The cache lapsed: the point stays alone on the line.
      await w.clock.advance(60 * MIN)
      expect(onScreen(w)).toEqual(['точка пишется…'])
      await $.prompt.submit({ text: 'gone', wait: false, origin: { kind: 'composer' } })
      expect(onScreen(w)).toEqual([])
    },
  )

  test('without stop-point (not loaded or stood down) the line is the cache alone', async ($, on) => {
    const w = world(on)
    await start($)
    await reply($, WAITS)
    expect(onScreen(w)).toEqual(['🔥 кэш до 15:40'])
  })
})

/**
 * A closed lid: the process stops, so no timer fires until it opens. A stand-in plugin holds every clock wait that
 * comes due while the lid is closed and lets it go when the lid opens, at whatever the wall clock says then. It runs
 * in its own environment, so the test moves the lid through its command.
 */
const LID_PLUGIN = {
  name: 'lid',
  register(on: On) {
    let isClosed = false
    const waiters: (() => void)[] = []
    on('command.run', { command: 'lid' }, (_$, e) => {
      isClosed = e.args === 'close'
      if (!isClosed) for (const wake of waiters.splice(0)) wake()
      return { text: e.args }
    })
    const hold = async <T>(r: T): Promise<T> => {
      while (isClosed) await new Promise<void>(resolve => waiters.push(resolve))
      return r
    }
    on('clock.every', async (_$, e, next) => hold(await next(e)))
    on('clock.after', async (_$, e, next) => hold(await next(e)))
  },
}
const moveLid = ($: Engine, args: 'close' | 'open') =>
  $.command.run({ command: 'lid', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
/** The Mac sleeps for `ms`: the wall clock moves, no timer runs; then the lid opens. */
async function sleepFor($: Engine, w: World, ms: number): Promise<void> {
  await moveLid($, 'close')
  await w.clock.advance(ms)
  await moveLid($, 'open')
  await w.clock.settle()
}
const LOG = '/home/fake/.claude/state/cache-warm/warms.log'
const logLines = (w: World) => (w.files.get(LOG) ?? '').trim().split('\n').filter(l => l !== '')

describe('a sleeping Mac and the warm log', () => {
  test('the lid closed over the warm and the expiry: no fork on a dead cache, the miss is logged, the line and /warm say so', { plugins: [LID_PLUGIN] }, async ($, on) => {
    const w = world(on)
    await start($)
    // The incident: a waiting reply, the owner awake 35 min more, then the lid shut until after the cache expired.
    await reply($, WAITS)
    expect(w.statuses.at(-1)).toBe('🔥 кэш до 15:40')
    await w.clock.advance(35 * MIN)
    await sleepFor($, w, 29 * MIN)
    expect(w.forks).toBe(0)
    // The cache died at 14:00 while the lid was shut: the line no longer promises 15:40.
    expect(w.statuses.at(-1)).toBeUndefined()
    expect(logLines(w)).toEqual([
      '2026-10-04 13:00 sess-1 armed: reply waits, mode auto, window 2 ч, first warm 13:50',
      '2026-10-04 14:04 sess-1 warm missed: due 13:50, cache expired 14:00, process paused 13:35–14:04 (Mac asleep); window ended',
    ])
    const text = textOf(await warm($, ''))
    expect(text).toContain('Прогрев в 13:50 пропущен: Mac спал (процесс стоял) с 13:35 до 14:04, кэш истёк в 14:00.')
    expect(text).toContain('Журнал прогревов (все сессии, строка на попытку): ~/.claude/state/cache-warm/warms.log')
    await w.clock.advance(120 * MIN)
    expect(w.forks).toBe(0)
  })

  test('a short nap past the due moment: the warm goes out late on waking while the cache lives, and the window goes on', { plugins: [LID_PLUGIN] }, async ($, on) => {
    const w = world(on)
    await start($)
    await reply($, WAITS)
    await w.clock.advance(45 * MIN)
    await sleepFor($, w, 10 * MIN)
    expect(w.forks).toBe(1)
    expect(logLines(w).at(-1)).toBe('2026-10-04 13:55 sess-1 warm 1 ok: read 180000 from cache, wrote 0, in 3, out 1, 5 мин late')
    expect(textOf(await warm($, ''))).toContain('последний в 13:55 — 180 000 токенов из кэша (опоздал на 5 мин)')
    // The grid stays the reply's: the next warm at 14:40.
    await w.clock.advance(45 * MIN)
    expect(w.forks).toBe(2)
    expect(w.statuses.at(-1)).toBe('кэш до 15:40')
  })

  test('every attempt is one line: a refused warm is retried in 2 min, a cold one says it rewrote the cache', async ($, on) => {
    const w = world(on)
    await start($)
    w.forkAnswers.push(
      { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { isAnswered: true, text: 'ok', usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 26_540, cache_creation_input_tokens: 139_564 } },
    )
    await reply($, WAITS)
    await w.clock.advance(50 * MIN)
    expect(w.forks).toBe(1)
    expect(textOf(await warm($, ''))).toContain('не удался: api-error 529 overloaded')
    await w.clock.advance(2 * MIN)
    expect(w.forks).toBe(2)
    expect(logLines(w).slice(1)).toEqual([
      '2026-10-04 13:50 sess-1 warm failed: api-error 529 overloaded, retry 13:52',
      '2026-10-04 13:52 sess-1 warm 1 cold: read 26540 from cache, wrote 139564, in 3, out 1',
    ])
    expect(textOf(await warm($, ''))).toContain('кэш уже истёк, записан заново: 139 564 токенов')
  })

  test('/warm while warming says the warms stop while the Mac sleeps', async ($, on) => {
    world(on)
    await start($)
    await reply($, WAITS)
    expect(textOf(await warm($, ''))).toContain('Греет, только пока Mac не спит')
  })
})
