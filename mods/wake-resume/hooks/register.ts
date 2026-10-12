// Continues a turn the Mac's sleep cut, once the Mac is really awake again.
//
// A closed lid stops every process; the stream in flight dies and the engine writes «API Error: Your computer went to
// sleep mid-response» at the next wake — often a dark wake, minutes or hours before anyone opens the lid. The turn then
// sits there until the owner types «продолжай». This mod notices that error (turn.complete's answer, or StopFailure),
// waits for a full wake — someone at the Mac (`UserIsActive`), or five minutes awake with no gap and no dark wake last
// in `pmset -g log` — and submits one continuation framed as this plugin's message, carrying the sleep's cause and time
// from `pmset -g log`, so the session neither waits nor misdiagnoses the cut.
//
// Guards: one continuation per cut turn; none once the owner wrote (a typed prompt cancels it, a draft in the box holds
// it); none for a turn that was waiting on the owner (a question tool or a permission dialog in flight); at most
// STREAK_MAX in a row without the owner writing. Every cut, continuation and skip is a line in
// ~/.claude/state/wake-resume/resume.log, which `/wake` names.
import type { EngineInterface, Register, Timer } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { WakeCut, WakeResumeSession } from '../types'
import {
  CONTINUED_KEEP,
  INITIAL,
  LOG_KEEP,
  NO_LOG,
  NO_SLEEP,
  OWNER_TOOLS,
  STATUS_WAITING,
  STEADY_MS,
  STREAK_MAX,
  TICK_MS,
  causeText,
  continuationPrompt,
  findCause,
  isSleepCut,
  isSuspendedDetail,
  isUserActive,
  lastSleep,
  localStamp,
  norm,
  parsePowerLog,
  parseTzOffset,
  withCut,
} from './logic'
import type { PowerEvent } from './logic'

type Engine = EngineInterface

export const COMMAND = 'wake'
export const LOG_PATH = '~/.claude/state/wake-resume/resume.log'
const POWER_LINES = "pmset -g log | grep -E '^[0-9-]+ [0-9:]+ [+-][0-9]{4} (Sleep|Wake|DarkWake)  ' | tail -n 400"

const SESSION = atom({ plugin: 'wake-resume', key: 'session' } as const, INITIAL)

let home: string | null = null
let tzOffsetMin = 0
let tick: Timer | null = null
let lastTickAt: number | null = null
/** Since when the process has run without a gap between ticks: the Mac has been awake that long. */
let awakeSince = 0
let isChecking = false
let shown: string | undefined
/** The main loop's turn in flight: its id and start, for a cut StopFailure names. */
let turnId: string | null = null
let turnStartedAt: number | null = null
/** Main-loop tool calls that wait on the owner (a question, a plan to approve), and a permission dialog shown. */
let ownerWaits = 0
let isPermissionAsked = false

const readState = async ($: Engine): Promise<WakeResumeSession> => norm(await read($, SESSION))

async function show($: Engine, text: string | undefined, force = false): Promise<void> {
  if (text === shown && !force) return
  shown = text
  try {
    $.ui.status(text)
  } catch {
    // a status that cannot show must not stop the mod
  }
}

async function record($: Engine, text: string): Promise<void> {
  $.ui.log(`wake-resume: ${text}`, { to: 'debug' })
  if (home === null) return
  try {
    const sid = await $.session.id()
    const path = `${home}${LOG_PATH.slice(1)}`
    const line = `${localStamp(await $.clock.now(), tzOffsetMin)} ${sid.slice(0, 8)} ${text}`
    const old = await $.fs.read(path).catch(() => '')
    const lines = typeof old === 'string' && old !== '' ? old.replace(/\n$/, '').split('\n') : []
    lines.push(line)
    await $.fs.write(path, `${lines.slice(-LOG_KEEP).join('\n')}\n`)
  } catch {
    // an unwritable log must not stop a continuation
  }
}

async function powerEvents($: Engine): Promise<PowerEvent[] | null> {
  try {
    const r = await $.process.run(['/bin/sh', '-c', POWER_LINES], { timeoutMs: 20_000 })
    return r.exitCode === 0 ? parsePowerLog(r.stdout) : null
  } catch {
    return null
  }
}

async function userActive($: Engine): Promise<boolean> {
  try {
    return isUserActive((await $.process.run(['pmset', '-g', 'assertions'], { timeoutMs: 5_000 })).stdout)
  } catch {
    return false
  }
}

const today = (now: number): string => localStamp(now, tzOffsetMin).slice(0, 10)

function arm($: Engine, now: number): void {
  if (tick !== null) return
  lastTickAt = now
  awakeSince = now
  tick = $.clock.every(TICK_MS, () => void onTick($))
}

function disarm(): void {
  tick?.cancel()
  tick = null
  lastTickAt = null
}

async function onCut($: Engine, cut: WakeCut): Promise<void> {
  if (ownerWaits > 0 || isPermissionAsked) {
    await record($, `cut ${cut.turnId} skipped: the turn was waiting on the owner (question or permission)`)
    return
  }
  let isNew = false
  await update($, SESSION, v => {
    const s = norm(v)
    const next = withCut(s, cut)
    isNew = s.pending === null && next.pending !== null
    return next
  })
  if (!isNew) return
  await record($, `cut ${cut.turnId}: sleep mid-response, waiting for a full wake`)
  await show($, STATUS_WAITING)
  arm($, await $.clock.now())
}

/** Every TICK_MS while a cut waits: continue it once the Mac is fully awake and nobody is writing. */
async function onTick($: Engine): Promise<void> {
  if (isChecking) return
  isChecking = true
  try {
    const now = await $.clock.now()
    // A gap between ticks is the Mac asleep: being awake counts again from now.
    if (lastTickAt !== null && now - lastTickAt > 2 * TICK_MS) awakeSince = now
    lastTickAt = now
    const s = await readState($)
    if (s.pending === null) {
      disarm()
      await show($, undefined)
      return
    }
    // A draft in the box is the owner answering: hold until it is sent (which cancels) or cleared.
    const box = await $.prompt.read().catch(() => ({ text: '' }))
    if (box.text.trim() !== '') return
    let events: PowerEvent[] | null | undefined
    if (!(await userActive($))) {
      if (now - awakeSince < STEADY_MS) return
      // Awake a while with nobody at the keys: a long dark wake looks the same from inside, so the log must end on a
      // full wake (an unreadable log leaves the steady clock alone to decide).
      events = await powerEvents($)
      if (events !== null && events.at(-1)?.kind !== 'wake') {
        awakeSince = now
        return
      }
    }
    let cut: WakeCut | null = null
    let streak = 0
    await update($, SESSION, v => {
      const st = norm(v)
      cut = st.pending
      streak = st.streak
      if (st.pending === null) return st
      return { pending: null, continued: [...st.continued, st.pending.turnId].slice(-CONTINUED_KEEP), streak: st.streak + 1 }
    })
    disarm()
    await show($, undefined)
    const claimed = cut as WakeCut | null
    if (claimed === null) return
    if (streak >= STREAK_MAX) {
      await record($, `cut ${claimed.turnId} not continued: ${STREAK_MAX} auto-continues in a row without the owner`)
      return
    }
    events ??= await powerEvents($)
    const found = events === null ? null : findCause(events, claimed)
    const cause = events === null ? NO_LOG : found === null ? NO_SLEEP : causeText(found, today(now))
    try {
      await $.prompt.submit({ text: continuationPrompt(cause) })
      await record($, `cut ${claimed.turnId} continued: ${cause}`)
    } catch (err) {
      await record($, `cut ${claimed.turnId} not continued: submit failed: ${String(err).slice(0, 200)}`)
    }
  } finally {
    isChecking = false
  }
}

async function statusText($: Engine): Promise<string> {
  const s = await readState($)
  const now = await $.clock.now()
  const lines: string[] = []
  if (s.pending !== null) {
    lines.push(
      `Ждёт пробуждения: ход оборвался сном Mac (замечено в ${localStamp(s.pending.at, tzOffsetMin).slice(11)}). ` +
        `Продолжу сам, когда кто-то за Mac или он ${STEADY_MS / 60_000} мин не спит.`,
    )
  } else {
    lines.push('Оборванных сном ходов нет. Если ход оборвётся ошибкой «went to sleep mid-response», продолжу его сам после пробуждения.')
  }
  lines.push(`Сейчас за Mac: ${(await userActive($)) ? 'есть активность (UserIsActive 1)' : 'активности нет'}.`)
  const events = await powerEvents($)
  const last = events === null ? null : lastSleep(events)
  lines.push(`Последний сон по pmset -g log: ${events === null ? NO_LOG : last === null ? 'не найден' : causeText(last, today(now))}.`)
  lines.push(`Автопродолжений подряд без пользователя: ${s.streak} из ${STREAK_MAX}.`)
  lines.push(`Журнал (все сессии, строка на обрыв, продолжение или пропуск): ${LOG_PATH}`)
  if (home !== null) {
    const log = await $.fs.read(`${home}${LOG_PATH.slice(1)}`).catch(() => '')
    const tail = typeof log === 'string' ? log.trimEnd().split('\n').filter(l => l !== '').slice(-5) : []
    if (tail.length > 0) lines.push(...tail.map(l => `  ${l}`))
  }
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      home = (await $.env.get('HOME')) ?? null
    } catch {
      home = null
    }
    const zone = await $.process.run(['date', '+%z'], { timeoutMs: 5_000 }).catch(() => null)
    tzOffsetMin = parseTzOffset(zone?.stdout ?? '') ?? 0
    await $.command
      .register({
        name: COMMAND,
        description: 'Автопродолжение после сна Mac: ждёт ли оборванный ход, последний сон по pmset, журнал',
        immediate: true,
      })
      .catch(err => $.ui.log(`wake-resume: /${COMMAND} not registered: ${String(err)}`, { to: 'debug' }))
    // After a reload the screen keeps the old instance's line; a cut that waited goes on waiting.
    const s = await readState($)
    await show($, s.pending === null ? undefined : STATUS_WAITING, true)
    if (s.pending !== null) arm($, await $.clock.now())
    return next(e)
  })

  // turn.start follows prompt.submit, which a subagent never passes: the main loop's turns only.
  on('turn.start', async ($, e, next) => {
    turnId = e.turnId
    turnStartedAt = await $.clock.now()
    isPermissionAsked = false
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    if (isSleepCut(e.answer)) {
      const now = await $.clock.now()
      await onCut($, { turnId: e.turnId, at: now, startedAt: now - e.durationMs })
    }
    isPermissionAsked = false
    ownerWaits = 0
    return r
  })

  // The engine's own failure hook: names the cut where the answer may carry only the partial text.
  on('classic.StopFailure', async ($, e, next) => {
    const r = await next(e)
    if (e.agent_id === undefined && (isSleepCut(e.last_assistant_message) || isSuspendedDetail(e.error_details))) {
      const now = await $.clock.now()
      await onCut($, { turnId: turnId ?? `stop:${now}`, at: now, startedAt: turnStartedAt ?? now })
    }
    return r
  })

  on('classic.PermissionRequest', async (_$, e, next) => {
    if (e.agent_id === undefined) isPermissionAsked = true
    return next(e)
  })

  // Hot: every tool call passes here, so it only counts the owner's question tools on the main loop.
  on('tool.call', async (_$, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (!OWNER_TOOLS.has(e.tool)) {
      const r = await next(e)
      isPermissionAsked = false
      return r
    }
    ownerWaits++
    try {
      return await next(e)
    } finally {
      ownerWaits = Math.max(0, ownerWaits - 1)
    }
  })

  // The owner wrote: a waiting cut is theirs now, and the streak starts over.
  on('prompt.submit', async ($, e, next) => {
    const isOwner = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (isOwner && !e.text.trimStart().startsWith('/')) {
      let dropped: WakeCut | null = null
      await update($, SESSION, v => {
        const s = norm(v)
        dropped = s.pending
        return s.pending === null && s.streak === 0 ? s : { ...s, pending: null, streak: 0 }
      })
      const was = dropped as WakeCut | null
      if (was !== null) {
        disarm()
        await show($, undefined)
        await record($, `cut ${was.turnId} not continued: the owner wrote first`)
      }
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => ({ text: await statusText($) }))
}
