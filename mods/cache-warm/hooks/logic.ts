import type { SessionWarm, WarmMode } from '../types'

/** What a reply leaves the owner with; only `waits` and `needs-input` are worth warming in `auto`. */
export type ReplyKind = 'waits' | 'needs-input' | 'result' | 'nothing-waits' | 'other'

/** A warm lands this long before the entry would lapse, so a slow fork still finds it alive. */
export const MARGIN_MIN = 10

const NEEDS_INPUT = /^\s*\**needs input:/im
const RESULT = /^\s*\**result:/im
/** The «Ждёт тебя» slot: a heading or a bold key, its body up to the next heading or blank-line block. */
const WAITS = /Ждёт тебя\**:?\**\s*([\s\S]*?)(?=\n#{1,6}\s|\n\s*\n\s*\*\*[^*\n]+\*\*\s*—|\n---|$)/i
const NOTHING = /^[—\-:\s]*(от тебя ничего|ничего)/i

/**
 * Measured over 327 replies (2026-09-28..10-04): the owner came back 1–3 h after a reply that waited for them 17 times
 * in 163, after a `result:` 3 in 47 (10 never came back), after a mid-work reply 1 in 108.
 */
export function classify(answer: string): ReplyKind {
  if (NEEDS_INPUT.test(answer)) return 'needs-input'
  const slot = WAITS.exec(answer)
  if (slot !== null) {
    const body = slot[1]!.trim()
    if (body !== '' && !NOTHING.test(body)) return 'waits'
  }
  if (RESULT.test(answer)) return 'result'
  return slot !== null ? 'nothing-waits' : 'other'
}

export function shouldWarm(mode: WarmMode, kind: ReplyKind): boolean {
  if (mode === 'off') return false
  return mode === 'on' || kind === 'waits' || kind === 'needs-input'
}

export function stepMs(ttlMin: number): number | null {
  const step = ttlMin - MARGIN_MIN
  return step >= 30 ? step * 60_000 : null
}

/**
 * When the next warm is due after `now`, or null once the window is covered: warms run every `step` from the reply
 * while the reply is younger than the window, so the cache lives at least `hours` after the reply.
 */
export function nextWarm(replyAt: number, now: number, hours: number, ttlMin: number): number | null {
  const step = stepMs(ttlMin)
  if (step === null || hours <= 0) return null
  const k = Math.max(1, Math.floor((now - replyAt) / step) + 1)
  const at = replyAt + k * step
  return at - replyAt < hours * 3_600_000 ? at : null
}

/** The cache's end: the last warm the window allows (or the reply itself) plus the TTL. */
export function aliveUntil(replyAt: number, hours: number, ttlMin: number): number {
  const step = stepMs(ttlMin)
  if (step === null || hours <= 0) return replyAt + ttlMin * 60_000
  const warms = Math.ceil((hours * 3_600_000) / step) - 1
  return replyAt + Math.max(0, warms) * step + ttlMin * 60_000
}

export type Command =
  | { kind: 'status' }
  | { kind: 'mode'; mode: WarmMode }
  | { kind: 'hours'; hours: number }
  | { kind: 'default'; hours: number }
  | { kind: 'error'; text: string }

function duration(raw: string): number | null {
  const m = /^(\d+(?:[.,]\d+)?)\s*(h|ч|час\p{L}*|m|м|мин\p{L}*)?$/iu.exec(raw.trim())
  if (m === null) return null
  const n = Number(m[1]!.replace(',', '.'))
  const minutes = m[2] !== undefined && /^[mм]/i.test(m[2])
  const hours = minutes ? n / 60 : n
  return hours > 0 && hours <= 24 ? hours : null
}

export function parse(args: string): Command {
  const a = args.trim().toLowerCase()
  if (a === '') return { kind: 'status' }
  if (['off', 'stop', 'стоп', 'выкл'].includes(a)) return { kind: 'mode', mode: 'off' }
  if (['on', 'always', 'вкл', 'всегда'].includes(a)) return { kind: 'mode', mode: 'on' }
  if (['auto', 'авто'].includes(a)) return { kind: 'mode', mode: 'auto' }
  const def = /^(default|дефолт|по умолчанию)\s+(.+)$/.exec(a)
  if (def !== null) {
    const h = duration(def[2]!)
    return h === null ? { kind: 'error', text: `не понял срок «${def[2]}»` } : { kind: 'default', hours: h }
  }
  const h = duration(a)
  return h === null ? { kind: 'error', text: `не понял «${args.trim()}»` } : { kind: 'hours', hours: h }
}

export const MODE_TEXT: Record<WarmMode, string> = {
  auto: 'когда ответ ждёт тебя',
  on: 'после каждого ответа',
  off: 'выключен',
}

export function effective(own: SessionWarm | undefined, defaultHours: number): { mode: WarmMode; hours: number; isOwn: boolean } {
  return { mode: own?.mode ?? 'auto', hours: own?.hours ?? defaultHours, isOwn: own?.hours !== undefined }
}

export function hhmm(ms: number, tzOffsetMin: number): string {
  const d = new Date(ms + tzOffsetMin * 60_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

export function parseTzOffset(text: string): number | null {
  const m = /([+-])(\d{2})(\d{2})/.exec(text)
  if (m === null) return null
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

export function hoursText(h: number): string {
  return Number.isInteger(h) ? `${h} ч` : `${Math.round(h * 60)} мин`
}
