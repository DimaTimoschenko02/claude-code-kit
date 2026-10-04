// Keeps an idle session's prompt cache warm while the owner is away and the last reply waits for them: a tool-less fork
// of the session's own transcript every TTL − 10 minutes reads the cached prefix, which renews its lifetime. The window
// runs from the reply; the owner's next message ends it. `/warm` picks the window and mode per session, kept in $.store
// by session id, so a respawn or resume keeps them.
//
// The status line shows the cache's real end, warmed or not — the owner reads it to decide whether to come back before
// the cache dies — and carries stop-point's part on the same line: `кэш до 20:15 · точка 19:42`. stop-point's own
// `$.ui.status` calls pass through this module's `ui.status` hook, which takes their text and clears stop-point's own
// row; without this mod loaded stop-point's row shows as it is.
import type { EngineInterface, Register } from 'claude-code'

import type { SessionWarm } from '../types'
import type { ReplyKind } from './logic'
import {
  MODE_TEXT,
  aliveUntil,
  classify,
  effective,
  hhmm,
  hoursText,
  nextWarm,
  parse,
  parseTzOffset,
  shouldWarm,
  stepMs,
  tokensText,
} from './logic'

type Engine = EngineInterface

export const COMMAND = 'warm'
/** The plugin whose status shares this mod's line. */
export const POINT_PLUGIN = 'stop-point'
const SESSION = 'session:'
const DEFAULT = 'default'
const TTL_MS = 60 * 86_400_000
/** The fork's own question: the shortest answer the model gives, so a warm costs the cache read and little else. */
const FORK_PROMPT = 'Cache keep-alive ping. Reply with the single word: ok'

type Config = { defaultHours: number; ttlMin: number }
let cfg: Config = { defaultHours: 2, ttlMin: 60 }
let tzOffsetMin = 0
let sid = ''
/** The reply the window runs from, or null while the owner is here or nothing is armed. */
let replyAt: number | null = null
/** The last main-thread reply and what it left the owner with: a `/warm` typed later arms from it. */
let lastReplyAt: number | null = null
let lastKind: ReplyKind = 'other'
let isTurnRunning = false
let timer: { cancel: () => void } | null = null
/** When the armed timer fires the next warm; null while none is due. `/warm` shows it, so the owner sees the mod alive. */
let nextAt: number | null = null
let warms = 0
/** The last fork of this window and what it read, the proof that the warm reached the cache. */
let lastWarm: { at: number; cacheRead?: number; reason?: string } | null = null
/** The last moment a request renewed the cache: a reply, a warm that read it, a turn that started. */
let refreshedAt: number | null = null
/** The end of the warmed window while warms are planned and none has failed; null otherwise. */
let windowUntil: number | null = null
/** Clears the cache part when the cache lapses; `lapseAt` is the moment it is armed for. */
let lapseTimer: { cancel: () => void } | null = null
let lapseAt: number | null = null
/** stop-point's part of the line, as its last `$.ui.status` call gave it. */
let pointText: string | undefined
/** The line as last set, so an unchanged one is not set again. */
let shown: string | undefined

function isSessionWarm(v: unknown): v is SessionWarm {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (o.mode === 'auto' || o.mode === 'on' || o.mode === 'off') && typeof o.at === 'number'
}

async function own($: Engine): Promise<SessionWarm | undefined> {
  const v = await $.store.get(`${SESSION}${sid}`)
  return isSessionWarm(v) ? v : undefined
}

async function defaultHours($: Engine): Promise<number> {
  const v = await $.store.get(DEFAULT)
  return typeof v === 'number' && v > 0 ? v : cfg.defaultHours
}

async function settings($: Engine) {
  return effective(await own($), await defaultHours($))
}

/** The cache's end as the line shows it, or null when nothing renewed it in this process. */
function cacheUntil(): number | null {
  if (refreshedAt === null) return null
  const fromLast = refreshedAt + cfg.ttlMin * 60_000
  return windowUntil !== null && windowUntil > fromLast ? windowUntil : fromLast
}

export function composeStatus(cache: string | undefined, point: string | undefined): string | undefined {
  const parts = [cache, point].filter((p): p is string => p !== undefined && p !== '')
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/** Sets the line from the cache's end and stop-point's part, and arms the clear for the moment the cache lapses. */
async function show($: Engine, force = false): Promise<void> {
  const now = await $.clock.now()
  const until = cacheUntil()
  const isAlive = until !== null && until > now
  const text = composeStatus(isAlive ? `кэш до ${hhmm(until, tzOffsetMin)}` : undefined, pointText)
  if (text !== shown || force) {
    shown = text
    void $.ui.status(text)
  }
  if (!isAlive) {
    lapseTimer?.cancel()
    lapseTimer = null
    lapseAt = null
  } else if (lapseAt !== until) {
    lapseTimer?.cancel()
    lapseAt = until
    lapseTimer = $.clock.after(until - now, () => void lapse($))
  }
}

/** The cache's end came: a running turn keeps renewing it with its requests; otherwise the cache part goes. */
async function lapse($: Engine): Promise<void> {
  lapseTimer = null
  lapseAt = null
  if (isTurnRunning) refreshedAt = await $.clock.now()
  await show($)
}

/** Ends the warm window: no more forks for it. The line keeps the cache's end that requests already bought. */
function disarm(): void {
  timer?.cancel()
  timer = null
  nextAt = null
  replyAt = null
  windowUntil = null
}

/** Arms, re-plans or disarms from the last reply, the session's mode and window; every change ends here. */
async function evaluate($: Engine): Promise<void> {
  const { mode } = await settings($)
  if (isTurnRunning) return
  if (lastReplyAt === null || stepMs(cfg.ttlMin) === null || !shouldWarm(mode, lastKind)) {
    disarm()
    await show($)
    return
  }
  timer?.cancel()
  timer = null
  if (replyAt !== lastReplyAt) {
    warms = 0
    lastWarm = null
  }
  replyAt = lastReplyAt
  await plan($)
}

/** Sets the timer for the next warm and the window's end the line shows. */
async function plan($: Engine): Promise<void> {
  if (replyAt === null) return
  const { hours } = await settings($)
  const now = await $.clock.now()
  windowUntil = lastWarm?.reason === undefined ? aliveUntil(replyAt, hours, cfg.ttlMin) : null
  const at = nextWarm(replyAt, now, hours, cfg.ttlMin)
  const from = replyAt
  nextAt = at
  if (at !== null) {
    timer = $.clock.after(Math.max(0, at - now), () => {
      void warm($, from)
    })
  }
  await show($)
}

async function warm($: Engine, from: number): Promise<void> {
  timer = null
  // The owner came back, or a newer reply re-armed: this tick belongs to a window that is over.
  if (replyAt !== from) return
  if (!isTurnRunning) {
    const at = await $.clock.now()
    const r = await $.model.fork({ prompt: FORK_PROMPT })
    if (r.isAnswered) {
      warms++
      lastWarm = { at, cacheRead: r.usage.cache_read_input_tokens }
      refreshedAt = at
      await $.ui.log(`cache-warm: warm ${warms}, ${r.usage.cache_read_input_tokens} tokens read from cache`, { to: 'debug' })
    } else {
      lastWarm = { at, reason: r.reason }
      await $.ui.log(`cache-warm: warm failed (${r.reason})`, { to: 'debug' })
      if (r.reason === 'nothing-to-fork') {
        disarm()
        await show($)
        return
      }
    }
  }
  if (replyAt === from) await plan($)
}

/** The next warm as the timer holds it: due, running now, overdue (the timer did not fire), or none left. */
function nextText(now: number): string {
  if (nextAt === null) return 'прогревы этого окна сделаны'
  if (nextAt > now) return `следующий прогрев в ${hhmm(nextAt, tzOffsetMin)} (через ${hoursText(Math.ceil((nextAt - now) / 60_000) / 60)})`
  if (timer === null) return 'прогрев идёт сейчас'
  return `прогрев опаздывает: был нужен в ${hhmm(nextAt, tzOffsetMin)}, таймер не сработал`
}

function warmsText(): string {
  if (lastWarm === null) return 'Прогревов в этом окне ещё не было.'
  const last =
    lastWarm.reason === undefined
      ? `${tokensText(lastWarm.cacheRead ?? 0)} токенов из кэша`
      : `не удался: ${lastWarm.reason}`
  return `Прогревов в этом окне: ${warms}, последний в ${hhmm(lastWarm.at, tzOffsetMin)} — ${last}.`
}

async function statusText($: Engine): Promise<string> {
  const s = await settings($)
  const def = await defaultHours($)
  const lines = [
    `Прогрев кэша: ${MODE_TEXT[s.mode]}, окно ${hoursText(s.hours)}${s.isOwn ? ' (своё у этой сессии)' : ' (по умолчанию)'}.`,
  ]
  const step = stepMs(cfg.ttlMin)
  if (step === null) lines.push(`Кэш живёт ${cfg.ttlMin} мин — греть дороже, чем переписать: прогрев не идёт.`)
  else if (s.hours * 3_600_000 <= step) {
    lines.push(`Окно не длиннее ${step / 60_000} мин: кэш и так живёт ${cfg.ttlMin} мин после ответа — прогревов не будет.`)
  } else {
    const now = await $.clock.now()
    const until = replyAt === null ? null : aliveUntil(replyAt, s.hours, cfg.ttlMin)
    if (until === null || until <= now) {
      const cache = cacheUntil()
      lines.push(
        (lastReplyAt !== null && !isTurnRunning && !shouldWarm(s.mode, lastKind)
          ? 'Сейчас не греет: последний ответ не ждёт тебя (`/warm on` — греть и такие).'
          : 'Сейчас не греет: ждёт следующего ответа.') +
          (cache !== null && cache > now ? ` Кэш жив до ${hhmm(cache, tzOffsetMin)}.` : ''),
      )
    } else {
      lines.push(`Греет: ${nextText(now)}, кэш жив до ${hhmm(until, tzOffsetMin)}.`)
      lines.push(warmsText())
    }
  }
  lines.push(`По умолчанию для новых сессий: ${hoursText(def)}.`)
  lines.push('`/warm 3` или `/warm 1h 30m` — окно этой сессии · `/warm off` · `/warm on` (после каждого ответа) · `/warm auto` · `/warm default 2`')
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  cfg = {
    defaultHours: typeof options.defaultHours === 'number' && options.defaultHours > 0 ? options.defaultHours : 2,
    ttlMin: typeof options.ttlMinutes === 'number' && options.ttlMinutes > 0 ? options.ttlMinutes : 60,
  }

  on('session.start', async ($, e, next) => {
    disarm()
    lastReplyAt = null
    refreshedAt = null
    isTurnRunning = false
    sid = await $.session.id()
    await $.command.register({
      name: COMMAND,
      description: 'Прогрев кэша сессии: статус, окно в часах, off / on / auto, default <часы>',
      argumentHint: '[часы | off | on | auto | default <часы>]',
      immediate: true,
    }).catch(err => $.ui.log(`cache-warm: /${COMMAND} not registered: ${String(err)}`, { to: 'debug' }))
    const zone = await $.process.run(['date', '+%z'], { timeoutMs: 5_000 }).catch(() => null)
    tzOffsetMin = parseTzOffset(zone?.stdout ?? '') ?? -new Date().getTimezoneOffset()

    // Choices of sessions long gone would pile up in the store.
    const now = await $.clock.now()
    for (const key of await $.store.keys()) {
      if (!key.startsWith(SESSION)) continue
      const v = await $.store.get(key)
      if (!isSessionWarm(v) || now - v.at > TTL_MS) await $.store.delete(key)
    }
    // After a reload the screen keeps the old instance's line, whatever this one last set.
    await show($, true)
    return next(e)
  })

  // A main-thread turn only: turn.start follows prompt.submit, which a subagent never passes. Its requests renew the
  // cache, so the line moves to a TTL from now instead of going blank while the turn runs.
  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    refreshedAt = await $.clock.now()
    await show($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    isTurnRunning = false
    sid = await $.session.id()
    lastReplyAt = await $.clock.now()
    refreshedAt = lastReplyAt
    lastKind = e.isAborted ? 'other' : classify(e.answer)
    await evaluate($)
    return r
  })

  // The owner is here: their message renews the cache with the turn it starts.
  on('prompt.submit', async ($, e, next) => {
    // A slash command is no turn of the model: `/warm on` must not end the window it sets.
    const isCommand = e.text.trimStart().startsWith('/')
    if ((e.origin.kind === 'composer' || e.origin.kind === 'bridge') && !isCommand) {
      disarm()
      lastReplyAt = null
      await show($)
    }
    return next(e)
  })

  // stop-point's line joins this one: its text is kept and its own row cleared. Our own calls pass through.
  on('ui.status', async ($, e, next) => {
    if (next.origin.plugin !== POINT_PLUGIN) return next(e)
    const r = await next({ ...e, text: undefined })
    pointText = e.text
    await show($)
    return r
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    sid = await $.session.id()
    const c = parse(e.args)
    if (c.kind === 'error') return { text: `${c.text}\n\n${await statusText($)}` }
    const now = await $.clock.now()
    const mine = await own($)
    if (c.kind === 'mode') {
      await $.store.set(`${SESSION}${sid}`, { ...mine, mode: c.mode, at: now })
    } else if (c.kind === 'hours') {
      await $.store.set(`${SESSION}${sid}`, { mode: mine?.mode ?? 'auto', hours: c.hours, at: now })
    } else if (c.kind === 'default') {
      await $.store.set(DEFAULT, c.hours)
    }
    if (!isTurnRunning) await evaluate($)
    return { text: await statusText($) }
  })
}
