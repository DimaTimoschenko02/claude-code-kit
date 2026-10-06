// Keeps an idle session's prompt cache warm while the owner is away and the last reply waits for them: a tool-less fork
// of the session's own transcript every TTL − 10 minutes reads the cached prefix, which renews its lifetime. The window
// runs from the reply; the owner's next message ends it. `/warm` picks the window and mode per session, kept in $.store
// by session id, so a respawn or resume keeps them.
//
// The status line shows the cache's real end, warmed or not — the owner reads it to decide whether to come back before
// the cache dies — and carries stop-point's part on the same line: `кэш до 20:15 · точка 19:42`. stop-point's own
// `$.ui.status` calls pass through this module's `ui.status` hook, which takes their text and clears stop-point's own
// row; without this mod loaded stop-point's row shows as it is.
//
// Time is read off the wall clock once a minute, never trusted to one long timer: a timer counts the process's awake
// time, and a Mac with its lid closed sends nothing at all. A warm whose moment passed while the cache still lives is
// sent late; one whose cache already expired is recorded as missed, not sent (a fork then rewrites the whole prefix).
// Every arming, warm, failure and miss is a line in ~/.claude/state/cache-warm/warms.log, so the owner can check later.
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { SessionWarm } from '../types'
import type { ReplyKind } from './logic'
import {
  MODE_TEXT,
  PAUSE_MS,
  RETRY_MS,
  TICK_MS,
  aliveUntil,
  classify,
  dueAction,
  effective,
  hhmm,
  hoursText,
  localStamp,
  nextWarm,
  parse,
  parseTzOffset,
  reachedCache,
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
/** The warm log, under $HOME; `/warm` names it in this spelling. */
export const LOG_PATH = '~/.claude/state/cache-warm/warms.log'
const LOG_KEEP = 2000

type Config = { defaultHours: number; ttlMin: number }
let cfg: Config = { defaultHours: 2, ttlMin: 60 }
let tzOffsetMin = 0
let sid = ''
/** $HOME, for the warm log; null when unknown (the log is then skipped, the warms are not). */
let home: string | null = null
/** The reply the window runs from, or null while the owner is here or nothing is armed. */
let replyAt: number | null = null
/** The last main-thread reply and what it left the owner with: a `/warm` typed later arms from it. */
let lastReplyAt: number | null = null
let lastKind: ReplyKind = 'other'
let isTurnRunning = false
/** When the next warm is due by the wall clock; null while none is. `/warm` shows it, so the owner sees the mod alive. */
let nextAt: number | null = null
let isWarmInFlight = false
let warms = 0
/** The last warm of this window: what it read and wrote, why it failed, or that it was missed and why. */
type LastWarm = {
  at: number
  cacheRead?: number
  cacheWrite?: number
  /** How long after its due moment it went out, when the process was paused in between. */
  lateMs?: number
  reason?: string
  missed?: { dueAt: number; expiredAt: number | null; pause: { from: number; to: number } | null }
}
let lastWarm: LastWarm | null = null
/** The last moment a request renewed the cache: a reply, a warm that read it, a turn that started. */
let refreshedAt: number | null = null
/** The end of the warmed window while warms are planned and none has failed; null otherwise. */
let windowUntil: number | null = null
/** The minute tick: runs while the line shows a live cache or a warm is planned. */
let tick: Timer | null = null
let lastTickAt: number | null = null
/** The last stretch the tick did not run (the process frozen, the Mac asleep), seen when it resumed. */
let lastPause: { from: number; to: number } | null = null
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

/** The cache's own end: a TTL after the last request that renewed it, or null when none did in this process. */
function cacheEnd(): number | null {
  return refreshedAt === null ? null : refreshedAt + cfg.ttlMin * 60_000
}

/** The cache's end as the line shows it: its own end, or the warmed window's while warms are planned. */
function cacheUntil(): number | null {
  const fromLast = cacheEnd()
  if (fromLast === null) return null
  return windowUntil !== null && windowUntil > fromLast ? windowUntil : fromLast
}

export function composeStatus(cache: string | undefined, point: string | undefined): string | undefined {
  const parts = [cache, point].filter((p): p is string => p !== undefined && p !== '')
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/** Sets the line from the cache's end and stop-point's part; keeps the minute tick running while there is time to watch. */
async function show($: Engine, force = false): Promise<void> {
  const now = await $.clock.now()
  const until = cacheUntil()
  const isAlive = until !== null && until > now
  // The fire says the time is the warmed window's, kept by warms still to come; plain, it is the cache's own expiry.
  const isWarming = nextAt !== null && windowUntil !== null
  const cache = isAlive ? `${isWarming ? '🔥 ' : ''}кэш до ${hhmm(until, tzOffsetMin)}` : undefined
  const text = composeStatus(cache, pointText)
  if (text !== shown || force) {
    shown = text
    void $.ui.status(text)
  }
  if (isAlive || nextAt !== null) {
    if (tick === null) {
      lastTickAt = now
      tick = $.clock.every(TICK_MS, () => void onTick($))
    }
  } else {
    tick?.cancel()
    tick = null
    lastTickAt = null
  }
}

/**
 * Once a minute by the wall clock: a running turn keeps renewing the cache with its requests; otherwise a due warm
 * goes out (late too, while the cache lives) or is recorded as missed, and the line follows the cache's real end.
 */
async function onTick($: Engine): Promise<void> {
  const now = await $.clock.now()
  if (lastTickAt !== null && now - lastTickAt > PAUSE_MS) lastPause = { from: lastTickAt, to: now }
  lastTickAt = now
  if (isTurnRunning) {
    const until = cacheUntil()
    if (until !== null && until <= now) refreshedAt = now
  } else if (!isWarmInFlight) {
    const action = dueAction(now, nextAt, cacheEnd())
    if (action === 'warm') await warm($, now)
    else if (action === 'missed') await missed($, now)
  }
  await show($)
}

/** One line in the warm log (and the debug log). The log is for the owner to check later; a warm never waits on it. */
async function record($: Engine, text: string): Promise<void> {
  $.ui.log(`cache-warm: ${text}`, { to: 'debug' })
  if (home === null) return
  try {
    const path = `${home}${LOG_PATH.slice(1)}`
    const line = `${localStamp(await $.clock.now(), tzOffsetMin)} ${sid.slice(0, 8)} ${text}`
    const old = await $.fs.read(path).catch(() => '')
    const lines = typeof old === 'string' && old !== '' ? old.replace(/\n$/, '').split('\n') : []
    lines.push(line)
    await $.fs.write(path, `${lines.slice(-LOG_KEEP).join('\n')}\n`)
  } catch {
    // an unwritable log must not stop the warms
  }
}

/** Ends the warm window: no more forks for it. The line keeps the cache's end that requests already bought. */
function disarm(): void {
  nextAt = null
  replyAt = null
  windowUntil = null
}

/** Arms, re-plans or disarms from the last reply, the session's mode and window; every change ends here. */
async function evaluate($: Engine): Promise<void> {
  const { mode, hours } = await settings($)
  if (isTurnRunning) return
  const end = cacheEnd()
  // A cache that already lapsed has nothing left to keep: a fork would rewrite the prefix, as the owner's message will.
  const isLapsed = end === null || end <= (await $.clock.now())
  if (lastReplyAt === null || stepMs(cfg.ttlMin) === null || !shouldWarm(mode, lastKind) || isLapsed) {
    disarm()
    await show($)
    return
  }
  const isNew = replyAt !== lastReplyAt
  if (isNew) {
    warms = 0
    lastWarm = null
  }
  replyAt = lastReplyAt
  await plan($)
  if (isNew && nextAt !== null) {
    await record($, `armed: reply ${lastKind}, mode ${mode}, window ${hoursText(hours)}, first warm ${hhmm(nextAt, tzOffsetMin)}`)
  }
}

/** Sets the next warm's moment and the window's end the line shows. */
async function plan($: Engine): Promise<void> {
  if (replyAt === null) return
  const { hours } = await settings($)
  const now = await $.clock.now()
  windowUntil = lastWarm?.reason === undefined && lastWarm?.missed === undefined ? aliveUntil(replyAt, hours, cfg.ttlMin) : null
  nextAt = nextWarm(replyAt, now, hours, cfg.ttlMin)
  await show($)
}

function lateText(ms: number): string {
  return ms >= 2 * 60_000 ? `, ${hoursText(Math.round(ms / 60_000) / 60)} late` : ''
}

async function warm($: Engine, now: number): Promise<void> {
  const from = replyAt
  const due = nextAt ?? now
  isWarmInFlight = true
  let r: Awaited<ReturnType<Engine['model']['fork']>> | null = null
  let thrown = ''
  try {
    r = await $.model.fork({ prompt: FORK_PROMPT })
  } catch (err) {
    thrown = String(err).slice(0, 200)
  } finally {
    isWarmInFlight = false
  }
  const usage = r !== null && 'usage' in r ? r.usage : undefined
  const lateMs = Math.max(0, now - due)
  if (usage !== undefined && (r?.isAnswered === true || reachedCache(usage))) {
    warms++
    refreshedAt = now
    lastWarm = { at: now, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens, lateMs }
    const cold = usage.cache_read_input_tokens < usage.cache_creation_input_tokens
    await record(
      $,
      `warm ${warms} ${cold ? 'cold' : 'ok'}: read ${usage.cache_read_input_tokens} from cache, wrote ${usage.cache_creation_input_tokens}, ` +
        `in ${usage.input_tokens}, out ${usage.output_tokens}${lateText(lateMs)}`,
    )
  } else {
    const reason =
      r === null
        ? `threw ${thrown}`
        : r.isAnswered
          ? 'no usage'
          : r.reason === 'api-error'
            ? `api-error ${r.status ?? 'no response'} ${r.error}`
            : r.reason
    lastWarm = { at: now, reason }
    if (r !== null && !r.isAnswered && r.reason === 'nothing-to-fork') {
      await record($, `warm failed: ${reason}, window ended`)
      disarm()
      return
    }
    if (replyAt !== from) return
    const end = cacheEnd()
    if (end !== null && now + RETRY_MS < end) {
      nextAt = now + RETRY_MS
      windowUntil = null
      await record($, `warm failed: ${reason}, retry ${hhmm(nextAt, tzOffsetMin)}`)
      return
    }
    await record($, `warm failed: ${reason}, no retry before the cache ends`)
  }
  // The owner came back, or a newer reply re-armed, while the fork ran: this window is over.
  if (replyAt === from) await plan($)
}

/** The due moment passed while the process did not run, and the cache died meanwhile: say so, warm no more. */
async function missed($: Engine, now: number): Promise<void> {
  const dueAt = nextAt ?? now
  const expiredAt = cacheEnd()
  const pause = lastPause !== null && lastPause.to === now ? lastPause : null
  lastWarm = { at: now, missed: { dueAt, expiredAt, pause } }
  const why =
    pause !== null
      ? `process paused ${hhmm(pause.from, tzOffsetMin)}–${hhmm(pause.to, tzOffsetMin)} (Mac asleep)`
      : 'the process did not run in time'
  await record(
    $,
    `warm missed: due ${hhmm(dueAt, tzOffsetMin)}, cache expired ${expiredAt === null ? '?' : hhmm(expiredAt, tzOffsetMin)}, ${why}; window ended`,
  )
  disarm()
}

/** The next warm as the clock holds it: due, running now, overdue (the process stood), or none left. */
function nextText(now: number): string {
  if (nextAt === null) return 'прогревы этого окна сделаны'
  if (nextAt > now) return `следующий прогрев в ${hhmm(nextAt, tzOffsetMin)} (через ${hoursText(Math.ceil((nextAt - now) / 60_000) / 60)})`
  if (isWarmInFlight) return 'прогрев идёт сейчас'
  return `прогрев опаздывает: был нужен в ${hhmm(nextAt, tzOffsetMin)}`
}

/** What happened to a warm that did not go out: the owner reads it after coming back to a cold cache. */
function missedText(m: NonNullable<LastWarm['missed']>): string {
  const why =
    m.pause !== null
      ? `Mac спал (процесс стоял) с ${hhmm(m.pause.from, tzOffsetMin)} до ${hhmm(m.pause.to, tzOffsetMin)}`
      : 'процесс не работал в это время'
  const expired = m.expiredAt === null ? '' : `, кэш истёк в ${hhmm(m.expiredAt, tzOffsetMin)}`
  return `Прогрев в ${hhmm(m.dueAt, tzOffsetMin)} пропущен: ${why}${expired}.`
}

function warmsText(): string {
  if (lastWarm === null) return 'Прогревов в этом окне ещё не было.'
  if (lastWarm.missed !== undefined) return missedText(lastWarm.missed)
  let last: string
  if (lastWarm.reason !== undefined) last = `не удался: ${lastWarm.reason}`
  else if ((lastWarm.cacheRead ?? 0) < (lastWarm.cacheWrite ?? 0)) {
    last = `кэш уже истёк, записан заново: ${tokensText(lastWarm.cacheWrite ?? 0)} токенов`
  } else last = `${tokensText(lastWarm.cacheRead ?? 0)} токенов из кэша`
  const late = (lastWarm.lateMs ?? 0) >= 2 * 60_000 ? ` (опоздал на ${hoursText(Math.round((lastWarm.lateMs ?? 0) / 60_000) / 60)})` : ''
  return `Прогревов в этом окне: ${warms}, последний в ${hhmm(lastWarm.at, tzOffsetMin)} — ${last}${late}.`
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
      if (lastWarm?.missed !== undefined) lines.push(missedText(lastWarm.missed))
      const isLapsed = lastReplyAt !== null && !isTurnRunning && (cache === null || cache <= now)
      lines.push(
        (lastReplyAt !== null && !isTurnRunning && !shouldWarm(s.mode, lastKind)
          ? 'Сейчас не греет: последний ответ не ждёт тебя (`/warm on` — греть и такие).'
          : isLapsed && lastWarm?.missed === undefined
            ? 'Сейчас не греет: кэш последнего ответа уже истёк, держать нечего — ждёт следующего ответа.'
            : 'Сейчас не греет: ждёт следующего ответа.') +
          (cache !== null && cache > now ? ` Кэш жив до ${hhmm(cache, tzOffsetMin)}.` : ''),
      )
    } else {
      lines.push(`Греет: ${nextText(now)}, кэш жив до ${hhmm(until, tzOffsetMin)}.`)
      lines.push(warmsText())
      lines.push('Греет, только пока Mac не спит: с закрытой крышкой запросы не уходят, кэш умрёт через час после последнего.')
    }
  }
  lines.push(`По умолчанию для новых сессий: ${hoursText(def)}.`)
  lines.push(`Журнал прогревов (все сессии, строка на попытку): ${LOG_PATH}`)
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
    try {
      home = (await $.env.get('HOME')) ?? null
    } catch {
      home = null
    }
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
    // A bare `/warm` only reads: re-planning would drop a retry the clock holds.
    if (c.kind !== 'status' && !isTurnRunning) await evaluate($)
    return { text: await statusText($) }
  })
}
