// Pure parts of wake-resume: recognising a turn the Mac's sleep cut, reading `pmset` output, and the texts.
import type { WakeCut, WakeResumeSession } from '../types'

/**
 * The line the engine itself appends when the machine slept mid-stream (its `StreamSuspended` error): a short prefix
 * («API Error»), then fixed words. Matched as the text's whole last line, so a reply that only quotes it is no cut.
 */
export const SLEEP_CUT = /^[^\n:]{1,40}: Your computer went to sleep mid-response\. The response above may be incomplete\.$/

/** The engine's error text for a cut turn: its last line is the sleep line, whatever partial text came before. */
export function isSleepCut(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false
  const last = text.trimEnd().split('\n').at(-1) ?? ''
  return SLEEP_CUT.test(last.trim())
}

/** StopFailure's `error_details` for the same failure names the engine's stream code. */
export const isSuspendedDetail = (text: string | null | undefined): boolean =>
  typeof text === 'string' && /\bStreamSuspended\b/.test(text)

/** How often the mod looks for the owner's return while a cut waits. */
export const TICK_MS = 20_000
/** Awake this long without a gap between ticks counts as a full wake even with nobody at the keyboard. */
export const STEADY_MS = 5 * 60_000
/** Auto-continues in a row without the owner writing; past it the session waits for them. */
export const STREAK_MAX = 3
/** A StopFailure and a turn.complete this close apart are one cut. */
export const SAME_CUT_MS = 60_000
export const CONTINUED_KEEP = 20
export const LOG_KEEP = 500

/** The tool calls in which the turn waits for the owner rather than works. */
export const OWNER_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode'])

export const INITIAL: WakeResumeSession = { pending: null, continued: [], streak: 0 }
export const norm = (v: Partial<WakeResumeSession> | undefined): WakeResumeSession => ({ ...INITIAL, ...(v ?? {}) })

/** `pmset -g assertions`: someone is at the Mac — a key, the trackpad or the lid opened in the last minutes. */
export const isUserActive = (assertions: string): boolean => /^\s*UserIsActive\s+1\s*$/m.test(assertions)

export type PowerEvent = {
  kind: 'sleep' | 'wake' | 'darkwake'
  /** ms since the epoch. */
  at: number
  /** The line's own local date and time, as `pmset` wrote it. */
  date: string
  hhmm: string
  /** A sleep's cause as `pmset` names it ('Clamshell Sleep', 'Maintenance Sleep', …). */
  reason?: string
  power?: 'battery' | 'ac'
}

const LINE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (Sleep|Wake|DarkWake)(?: {2,}|\t)\s*(.*)$/

/**
 * The Sleep / Wake / DarkWake lines of `pmset -g log`, oldest first; every other line is skipped. The type column is
 * padded, so `Wake Requests` (one space) is not a wake.
 */
export function parsePowerLog(text: string): PowerEvent[] {
  const out: PowerEvent[] = []
  for (const raw of text.split('\n')) {
    const m = LINE.exec(raw.trimEnd())
    if (m === null) continue
    const [, y, mo, d, h, mi, s, sign, oh, om, type, rest = ''] = m
    const offsetMin = (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om))
    const at = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) - offsetMin * 60_000
    const date = `${y}-${mo}-${d}`
    const hhmm = `${h}:${mi}`
    const power = /Using (Batt|BATT)/.test(rest) ? 'battery' : /Using AC/.test(rest) ? 'ac' : undefined
    if (type === 'Sleep') {
      const reason = /due to '([^']+)'/.exec(rest)?.[1]
      out.push({ kind: 'sleep', at, date, hhmm, ...(reason === undefined ? {} : { reason }), ...(power === undefined ? {} : { power }) })
    } else if (type === 'Wake') {
      out.push({ kind: 'wake', at, date, hhmm, ...(power === undefined ? {} : { power }) })
    } else {
      out.push({ kind: 'darkwake', at, date, hhmm })
    }
  }
  return out
}

/** Sleeps that only continue an earlier one: the dark wakes' way back to sleep. */
const CONTINUING = /Maintenance Sleep|Back to Sleep/i

export type SleepCause = {
  reason: string
  date: string
  hhmm: string
  power?: 'battery' | 'ac'
  /** The first full wake after it, when there was one. */
  woke?: { date: string; hhmm: string }
}

/**
 * The sleep that cut a turn: the last sleep that began one (a lid, idle, the menu) at or before the cut. Null when
 * there is none, or when the Mac was fully awake again before the turn began — that sleep is older than the turn.
 */
export function findCause(events: readonly PowerEvent[], cut: { at: number; startedAt: number }): SleepCause | null {
  let s: PowerEvent | undefined
  for (const e of events) {
    if (e.kind === 'sleep' && !CONTINUING.test(e.reason ?? '') && e.at <= cut.at + SAME_CUT_MS) s = e
  }
  if (s === undefined) return null
  const sleep = s
  const woke = events.find(e => e.kind === 'wake' && e.at > sleep.at)
  if (woke !== undefined && woke.at < cut.startedAt) return null
  return {
    reason: sleep.reason ?? 'Sleep',
    date: sleep.date,
    hhmm: sleep.hhmm,
    ...(sleep.power === undefined ? {} : { power: sleep.power }),
    ...(woke === undefined ? {} : { woke: { date: woke.date, hhmm: woke.hhmm } }),
  }
}

/** The last sleep that began one, whatever turn it cut: for `/wake`. */
export function lastSleep(events: readonly PowerEvent[]): SleepCause | null {
  const last = events.at(-1)
  return last === undefined ? null : findCause(events, { at: last.at, startedAt: Number.NEGATIVE_INFINITY })
}

const REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Clamshell/i, 'крышка закрыта'],
  [/Idle/i, 'уснул от простоя'],
  [/Power Button/i, 'кнопкой питания'],
  [/Software|Sleep Button|Apple Menu/i, 'отправлен в сон вручную'],
  [/Low Power|Battery/i, 'села батарея'],
  [/Thermal/i, 'перегрев'],
]

const dayMonth = (date: string): string => `${date.slice(8, 10)}.${date.slice(5, 7)}`
const at = (when: { date: string; hhmm: string }, today: string): string =>
  when.date === today ? when.hhmm : `${when.hhmm} ${dayMonth(when.date)}`

/** «Mac спал — крышка закрыта в 19:51, от батареи; проснулся в 20:36». */
export function causeText(c: SleepCause, today: string): string {
  const reason = REASONS.find(([re]) => re.test(c.reason))?.[1] ?? `«${c.reason.replace(/[^\w .-]/g, '').slice(0, 40)}»`
  const power = c.power === 'battery' ? ', от батареи' : c.power === 'ac' ? ', от сети' : ''
  const woke = c.woke === undefined ? '' : `; проснулся в ${at(c.woke, today)}`
  return `Mac спал — ${reason} в ${at(c, today)}${power}${woke}`
}

export const NO_SLEEP = 'сна Mac за время хода в pmset -g log нет — обрыв без сна (процесс был приостановлен или пропала сеть)'
export const NO_LOG = 'журнал pmset -g log прочитать не удалось'

/** The continuation, framed by the engine as this plugin's message; it says it is automatic and why the turn broke. */
export function continuationPrompt(cause: string): string {
  return (
    'Автопродолжение от мода wake-resume — это не сообщение пользователя. ' +
    'Твой прошлый ответ оборвался ошибкой «API Error: Your computer went to sleep mid-response». ' +
    `Причина по pmset -g log: ${cause}. ` +
    'Продолжи работу с места обрыва: ответ выше мог оборваться на полуслове. ' +
    'Если оборванный ответ ждал решения пользователя — не продолжай, а коротко повтори вопрос.'
  )
}

export const STATUS_WAITING = '⏸ ход оборван сном Mac — продолжу сам, когда проснётся'

export function localStamp(ms: number, tzOffsetMin: number): string {
  const d = new Date(ms + tzOffsetMin * 60_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

export function parseTzOffset(text: string): number | null {
  const m = /([+-])(\d{2})(\d{2})/.exec(text)
  if (m === null) return null
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

/**
 * Records a cut. StopFailure and turn.complete both name one cut a moment apart: the later notice replaces the waiting
 * one (turn.complete knows the turn's id), keeping the earlier start. A turn already continued is never taken again.
 */
export function withCut(s: WakeResumeSession, cut: WakeCut): WakeResumeSession {
  if (s.continued.includes(cut.turnId)) return s
  const p = s.pending
  const startedAt = p !== null && Math.abs(p.at - cut.at) < SAME_CUT_MS ? Math.min(p.startedAt, cut.startedAt) : cut.startedAt
  return { ...s, pending: { ...cut, startedAt } }
}
