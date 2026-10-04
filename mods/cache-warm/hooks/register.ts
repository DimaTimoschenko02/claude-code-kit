// Keeps an idle session's prompt cache warm while the owner is away and the last reply waits for them: a tool-less fork
// of the session's own transcript every TTL − 10 minutes reads the cached prefix, which renews its lifetime. The window
// runs from the reply; the owner's next message ends it. `/warm` picks the window and mode per session, kept in $.store
// by session id, so a respawn or resume keeps them.
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

function disarm($: Engine): void {
  timer?.cancel()
  timer = null
  nextAt = null
  replyAt = null
  void $.ui.status(undefined)
}

/** Arms, re-plans or disarms from the last reply, the session's mode and window; every change ends here. */
async function evaluate($: Engine): Promise<void> {
  const { mode } = await settings($)
  if (isTurnRunning || lastReplyAt === null || stepMs(cfg.ttlMin) === null || !shouldWarm(mode, lastKind)) {
    disarm($)
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

/** Sets the timer for the next warm, or leaves the status saying when the cache lapses. */
async function plan($: Engine): Promise<void> {
  if (replyAt === null) return
  const { hours } = await settings($)
  const now = await $.clock.now()
  const until = aliveUntil(replyAt, hours, cfg.ttlMin)
  const at = nextWarm(replyAt, now, hours, cfg.ttlMin)
  await $.ui.status(until > now ? `кэш до ${hhmm(until, tzOffsetMin)}` : undefined)
  const from = replyAt
  nextAt = at
  if (at === null) {
    // The window is covered: the status goes when the cache does, not with the owner's next look.
    if (until > now) timer = $.clock.after(until - now, () => void lapse($, from))
    return
  }
  timer = $.clock.after(Math.max(0, at - now), () => {
    void warm($, from)
  })
}

function lapse($: Engine, from: number): void {
  if (replyAt === from) disarm($)
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
      await $.ui.log(`cache-warm: warm ${warms}, ${r.usage.cache_read_input_tokens} tokens read from cache`, { to: 'debug' })
    } else {
      lastWarm = { at, reason: r.reason }
      await $.ui.log(`cache-warm: warm failed (${r.reason})`, { to: 'debug' })
      if (r.reason === 'nothing-to-fork') {
        disarm($)
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
      lines.push(
        lastReplyAt !== null && !isTurnRunning && !shouldWarm(s.mode, lastKind)
          ? 'Сейчас не греет: последний ответ не ждёт тебя (`/warm on` — греть и такие).'
          : 'Сейчас не греет: ждёт следующего ответа.',
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
    disarm($)
    lastReplyAt = null
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
    return next(e)
  })

  // A main-thread turn only: turn.start follows prompt.submit, which a subagent never passes.
  on('turn.start', ($, e, next) => {
    isTurnRunning = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    isTurnRunning = false
    sid = await $.session.id()
    lastReplyAt = await $.clock.now()
    lastKind = e.isAborted ? 'other' : classify(e.answer)
    await evaluate($)
    return r
  })

  // The owner is here: their message renews the cache with the turn it starts.
  on('prompt.submit', ($, e, next) => {
    // A slash command is no turn of the model: `/warm on` must not end the window it sets.
    const isCommand = e.text.trimStart().startsWith('/')
    if ((e.origin.kind === 'composer' || e.origin.kind === 'bridge') && !isCommand) {
      disarm($)
      lastReplyAt = null
    }
    return next(e)
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
