import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { storeProblem } from '../hooks/register'

const MIN = 60_000
const T0 = new Date(2026, 9, 4, 13, 0).getTime()
const FILE = String.raw`C:\Users\fake\.claude\plugins\store\cache-warm_inline-0123456789ab.json`
// What the engine answers when a crash left the store file half-written: every call, keys included.
const REFUSAL = `cache-warm@inline: store file ${FILE} is malformed (JSON Parse error: Unexpected EOF)`

const WAITS = ['### Ждёт тебя', '- **респавн** — `claude respawn ab12cd34`', '', '---', 'result: мод собран'].join('\n')

type World = {
  broken: boolean
  store: Map<string, unknown>
  forks: number
  statuses: (string | undefined)[]
  debug: string[]
  sid: { value: string }
  clock: ReturnType<typeof mock.clock>
}

function world(on: On): World {
  const w: World = {
    broken: true,
    store: new Map(),
    forks: 0,
    statuses: [],
    debug: [],
    sid: { value: 'sess-1' },
    clock: mock.clock(on, { now: T0 }),
  }
  mock.env(on, { HOME: '/home/fake' })
  on('fs.read', () => ({ value: '' }))
  on('fs.write', () => ({ value: undefined }))
  on('store.get', (_$, e) => (w.broken ? { deny: REFUSAL } : { value: w.store.get(e.key) }))
  on('store.set', (_$, e) => {
    if (w.broken) return { deny: REFUSAL }
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    if (w.broken) return { deny: REFUSAL }
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => (w.broken ? { deny: REFUSAL } : { value: [...w.store.keys()] }))
  on('session.id', () => ({ value: w.sid.value }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('process.run', () => ({ deny: 'no processes in this world' }))
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
  on('ui.status', (_$, e, next) => {
    if (next.origin.plugin === 'cache-warm') w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    w.debug.push(e.text)
    return { value: undefined }
  })
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

describe('a store the engine cannot read', () => {
  test('costs only the saving: the session starts, a waiting reply still warms at 50 and 100 min', async ($, on) => {
    const w = world(on)
    await start($)
    // The start draws the line even with the store refusing (a reload must replace the old instance's line).
    expect(w.statuses).toHaveLength(1)
    await reply($, WAITS)
    expect(w.statuses.at(-1)).toBe('🔥 кэш до 15:40')
    await w.clock.advance(50 * MIN)
    expect(w.forks).toBe(1)
    await w.clock.advance(50 * MIN)
    expect(w.forks).toBe(2)
    expect(w.debug.some(l => l.startsWith('cache-warm: store refused, choices live in memory only:'))).toBe(true)
    expect(w.debug.some(l => l.includes('hook skipped'))).toBe(false)
  })

  test('/warm 3 and /warm off still hold for this session, and /warm names the file to move aside', async ($, on) => {
    const w = world(on)
    await start($)
    const text = textOf(await warm($, '3'))
    expect(text).toContain('окно 3 ч (своё у этой сессии)')
    expect(text).toContain(`хранилище не читается — отодвинь файл: ${FILE}`)
    await warm($, 'off')
    await reply($, WAITS)
    await w.clock.advance(120 * MIN)
    expect(w.forks).toBe(0)
  })

  test('once the store reads again, the warning goes and the choice is saved', async ($, on) => {
    const w = world(on)
    await start($)
    expect(textOf(await warm($, ''))).toContain('хранилище не читается')
    w.broken = false
    const text = textOf(await warm($, '3'))
    expect(text).not.toContain('хранилище не читается')
    expect(w.store.get('session:sess-1')).toMatchObject({ hours: 3 })
  })

  test('the warning names the file, or keeps any other failure short', () => {
    expect(storeProblem(new Error(REFUSAL))).toBe(FILE)
    expect(storeProblem(new Error('x'.repeat(500)))).toHaveLength(200)
  })
})
