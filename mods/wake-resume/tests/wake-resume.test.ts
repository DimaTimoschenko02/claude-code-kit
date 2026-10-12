import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  NO_SLEEP,
  STEADY_MS,
  STREAK_MAX,
  TICK_MS,
  causeText,
  findCause,
  isSleepCut,
  isSuspendedDetail,
  isUserActive,
  lastSleep,
  parsePowerLog,
} from '../hooks/logic'

const MIN = 60_000
const HOME = '/home/fake'
const LOG = `${HOME}/.claude/state/wake-resume/resume.log`
/** Local 20:21:07 on 06.10 (+03:00): the dark wake at which a real session wrote the cut. */
const CUT_AT = Date.UTC(2026, 9, 6, 17, 21, 7)
/** Local 19:51:44: when that turn began, ten seconds before the lid closed. */
const TURN_AT = Date.UTC(2026, 9, 6, 16, 51, 44)

/** The assistant record a sleep left in a real transcript (ids dropped). */
const TRANSCRIPT_LINE =
  '{"type":"assistant","error":"server_error","truncatedAfterOutput":true,"isApiErrorMessage":true,"sessionKind":"bg",' +
  '"message":{"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","type":"message",' +
  '"content":[{"type":"text","text":"API Error: Your computer went to sleep mid-response. The response above may be incomplete."}]}}'
const CUT_TEXT = (JSON.parse(TRANSCRIPT_LINE) as { message: { content: { text: string }[] } }).message.content[0]?.text ?? ''

/** `pmset -g log`, power lines only, as this Mac wrote them around two real cuts (06.10 evening, 09.10 afternoon). */
const POWER_LOG = [
  "2026-10-06 19:14:42 +0300 Sleep               \tEntering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using Batt (Charge:53%) 101 secs",
  '2026-10-06 19:16:23 +0300 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to smc.sysState.Wake(0x70070000) USB-C_plug SMC.OutboxNotEmpty/ Using AC',
  '2026-10-06 19:16:24 +0300 Wake                \tDarkWake to FullWake from Deep Idle [CDNVAP] : due to Notification Using AC (Charge:53%) 4 secs',
  "2026-10-06 19:16:28 +0300 Sleep               \tEntering DarkWake state due to 'Notification Wake Back to Sleep':TCPKeepAlive=active Using AC (Charge:53%)",
  "2026-10-06 19:17:08 +0300 Sleep               \tEntering Sleep state due to 'Notification Wake Back to Sleep':TCPKeepAlive=active Using AC (Charge:53%)",
  '2026-10-06 19:32:09 +0300 DarkWake            \tDarkWake from Deep Idle [CDNPB] : due to NUB.SPMISw3IRQ nub-spmi0.0x02 rtc/Maintenance Using AC',
  "2026-10-06 19:32:55 +0300 Sleep               \tEntering Sleep state due to 'Maintenance Sleep':TCPKeepAlive=active Using AC (Charge:73%) 219 secs",
  '2026-10-06 19:36:34 +0300 DarkWake            \tDarkWake from Deep Idle [CDNPB] : due to smc.sysState.Wake(0x70070000) USB-C_plug SMC.OutboxNotEmpty/ Using AC',
  '2026-10-06 19:36:58 +0300 Wake                \tDarkWake to FullWake from Deep Idle [CDNVA] : due to UserActivity Assertion Using BATT (Charge:76%) 896 secs',
  '2026-10-06 19:51:49 +0300 Wake Requests       \t[process=mDNSResponder request=Maintenance deltaSecs=4564]',
  "2026-10-06 19:51:54 +0300 Sleep               \tEntering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using Batt (Charge:76%) 1753 secs",
  '2026-10-06 20:21:07 +0300 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to NUB.SPMISw3IRQ nub-spmi0.0x02 rtc/Maintenance Using BATT (Charge:76%)',
  "2026-10-06 20:21:52 +0300 Sleep               \tEntering Sleep state due to 'Maintenance Sleep':TCPKeepAlive=active Using Batt (Charge:76%) 898 secs",
  '2026-10-06 20:36:50 +0300 Wake                \tWake from Deep Idle [CDNVA] : due to smc.sysState.Wake(0x70070000) lid SMC.OutboxNotEmpty/HID Activity Using BATT (Charge:76%)',
  "2026-10-09 13:17:46 +0300 Sleep               \tEntering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using Batt (Charge:91%) 8 secs",
  "2026-10-09 13:18:39 +0300 Sleep               \tEntering Sleep state due to 'Maintenance Sleep':TCPKeepAlive=active Using Batt (Charge:91%) 1387 secs",
  '2026-10-09 15:44:20 +0300 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to NUB.SPMISw3IRQ nub-spmi0.0x02 rtc/Maintenance Using BATT (Charge:90%)',
  "2026-10-09 15:44:20 +0300 Sleep               \tEntering Sleep state due to 'Maintenance Sleep':TCPKeepAlive=active Using Batt (Charge:90%) 988 secs",
  '2026-10-09 16:00:48 +0300 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to NUB.SPMISw3IRQ nub-spmi0.0x02 rtc/SleepService Using BATT (Charge:90%)',
  "2026-10-09 16:00:50 +0300 Sleep               \tEntering Sleep state due to 'Sleep Service Back to Sleep':TCPKeepAlive=active Using Batt (Charge:90%) 739 secs",
  '2026-10-09 16:36:15 +0300 Wake                \tWake from Deep Idle [CDNVA] : due to smc.sysState.Wake(0x70070000) lid SMC.OutboxNotEmpty/HID Activity Using BATT (Charge:90%)',
].join('\n')
/** The 06.10 part alone: what the log held when that cut was continued. */
const LOG_06 = POWER_LOG.split('\n').filter(l => l.startsWith('2026-10-06')).join('\n')
/** The same evening, read during the dark wake: the lid not yet opened. */
const LOG_06_DARK = LOG_06.split('\n').filter(l => !l.includes('20:36:50') && !l.includes('20:21:52')).join('\n')

const ASSERTIONS = (active: boolean) =>
  ['Assertion status system-wide:', '   BackgroundTask                 0', `   UserIsActive                   ${active ? 1 : 0}`, '   PreventUserIdleSystemSleep     1'].join('\n')

type Submitted = { text: string; origin: string }
type World = {
  clock: ReturnType<typeof mock.clock>
  files: Map<string, string>
  statuses: (string | undefined)[]
  submitted: Submitted[]
  powerLog: string
  isUserActive: boolean
  draft: string
  /** A held owner tool call ends. */
  answerOwner: () => void
}

function world(on: On): World {
  let release: () => void = () => undefined
  const w: World = {
    clock: mock.clock(on, { now: CUT_AT - 30 * MIN }),
    files: new Map(),
    statuses: [],
    submitted: [],
    powerLog: LOG_06_DARK,
    isUserActive: false,
    draft: '',
    answerOwner: () => release(),
  }
  mock.env(on, { HOME })
  on('fs.read', (_$, e) => ({ value: w.files.get(e.path) ?? '' }))
  on('fs.write', (_$, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (cmd === 'date +%z') return out('+0300\n')
    if (cmd === 'pmset -g assertions') return out(ASSERTIONS(w.isUserActive))
    if (cmd.startsWith('/bin/sh -c pmset -g log')) return out(w.powerLog)
    return out('', 127)
  })
  on('session.id', () => ({ value: 'sess-0a1b2c3d' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('prompt.read', () => ({ value: { text: w.draft, cursor: w.draft.length } }))
  on('prompt.submit', (_$, e) => {
    w.submitted.push({ text: e.text, origin: e.origin.kind })
    return { text: e.text }
  })
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.StopFailure', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  on('tool.call', async (_$, e) => {
    if (e.tool === 'AskUserQuestion') await new Promise<void>(res => (release = res))
    return { result: 'ok', text: 'ok' } as never
  })
  return w
}

/** A sleeping Mac runs no timer: a stand-in plugin holds every period that comes due until `/lid open`. */
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
    on('clock.every', async (_$, e, next) => {
      const r = await next(e)
      while (isClosed) await new Promise<void>(resolve => waiters.push(resolve))
      return r
    })
  },
}
const moveLid = ($: Engine, args: 'close' | 'open') =>
  $.command.run({ command: 'lid', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)

const start = ($: Engine) => $.session.start({ cwd: '/home/fake/proj', surface: 'terminal', isInteractive: true })
/** A main turn that ran from TURN_AT and ended at the clock's now with `answer`. */
const endTurn = async ($: Engine, w: World, answer: string, turnId = 't1', agentId?: string) => {
  await $.turn.complete({
    answer,
    durationMs: w.clock.now() - TURN_AT,
    isAborted: false,
    turnId,
    reason: 'answer',
    ...(agentId === undefined ? {} : { agentId }),
  })
}
/** The real cut: the session wakes dark at 20:21:07 and writes the sleep error as the turn's end. */
const cutAtDarkWake = async ($: Engine, w: World, turnId = 't1') => {
  await w.clock.set(CUT_AT)
  await endTurn($, w, `Смотрю ревью PR.\n\n${CUT_TEXT}`, turnId)
}
/** The dark wake ends; the Mac sleeps until the lid opens at 20:36:50 with someone at it. */
const sleepUntilLidOpens = async ($: Engine, w: World) => {
  await moveLid($, 'close')
  await w.clock.set(Date.UTC(2026, 9, 6, 17, 36, 50))
  w.powerLog = LOG_06
  w.isUserActive = true
  await moveLid($, 'open')
  await w.clock.advance(TICK_MS)
}
const typed = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
const wakeCmd = ($: Engine) =>
  $.command.run({ command: 'wake', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)

describe('recognising the cut', () => {
  test('the line a real transcript holds is a cut; a reply quoting it, another error or a plain answer is not', () => {
    expect(isSleepCut(CUT_TEXT)).toBe(true)
    expect(isSleepCut(`Половина ответа\n\n${CUT_TEXT}\n`)).toBe(true)
    expect(isSleepCut(`Ошибка была «${CUT_TEXT}» — это крышка.`)).toBe(false)
    expect(isSleepCut(`${CUT_TEXT}\n\nДальше разбираю причину.`)).toBe(false)
    expect(isSleepCut('API Error: Connection lost mid-response. The response above may be incomplete.')).toBe(false)
    expect(isSleepCut('Готово.')).toBe(false)
    expect(isSuspendedDetail('stream error: StreamSuspended')).toBe(true)
    expect(isSuspendedDetail('server_error')).toBe(false)
  })

  test('pmset: a padded Wake is a wake, «Wake Requests» is not; local times keep their offset', () => {
    const ev = parsePowerLog(POWER_LOG)
    expect(ev.filter(e => e.hhmm === '19:51')).toHaveLength(1)
    const lid = ev.find(e => e.hhmm === '19:51')
    expect(lid).toMatchObject({ kind: 'sleep', reason: 'Clamshell Sleep', power: 'battery', at: Date.UTC(2026, 9, 6, 16, 51, 54) })
    expect(ev.find(e => e.hhmm === '20:36')?.kind).toBe('wake')
    expect(ev.find(e => e.hhmm === '20:21')?.kind).toBe('darkwake')
    expect(isUserActive(ASSERTIONS(true))).toBe(true)
    expect(isUserActive(ASSERTIONS(false))).toBe(false)
  })

  test('the cause of each real cut: the lid that closed, not the maintenance sleeps after it', () => {
    const ev = parsePowerLog(POWER_LOG)
    const evening = findCause(ev, { at: CUT_AT, startedAt: TURN_AT })
    expect(evening === null ? '' : causeText(evening, '2026-10-06')).toBe('Mac спал — крышка закрыта в 19:51, от батареи; проснулся в 20:36')
    // 09.10: the turn began at 15:44, in a dark wake hours after the lid closed; the cut came at the 16:00 dark wake.
    const afternoon = findCause(ev, { at: Date.UTC(2026, 9, 9, 13, 0, 48), startedAt: Date.UTC(2026, 9, 9, 12, 44, 19) })
    expect(afternoon === null ? '' : causeText(afternoon, '2026-10-12')).toBe(
      'Mac спал — крышка закрыта в 13:17 09.10, от батареи; проснулся в 16:36 09.10',
    )
    // A turn that began after the Mac was fully awake again was not cut by that older sleep.
    expect(findCause(ev, { at: Date.UTC(2026, 9, 6, 16, 45), startedAt: Date.UTC(2026, 9, 6, 16, 40) })).toBeNull()
    expect(lastSleep(ev)?.hhmm).toBe('13:17')
  })
})

describe('continuing after the wake', () => {
  test('a cut seen at a dark wake waits; the lid opens and one framed continuation names the cause', { plugins: [LID_PLUGIN] }, async ($, on) => {
    const w = world(on)
    await start($)
    await cutAtDarkWake($, w)
    expect(w.statuses.at(-1)).toContain('продолжу сам')
    // Still the dark wake: nobody at the Mac, not awake long enough.
    await w.clock.advance(2 * TICK_MS)
    expect(w.submitted).toHaveLength(0)
    await sleepUntilLidOpens($, w)
    expect(w.submitted).toHaveLength(1)
    const sent = w.submitted[0]
    expect(sent?.origin).toBe('plugin')
    expect(sent?.text).toContain('это не сообщение пользователя')
    expect(sent?.text).toContain('Mac спал — крышка закрыта в 19:51, от батареи; проснулся в 20:36')
    expect(w.statuses.at(-1)).toBeUndefined()
    expect(w.files.get(LOG)).toContain('cut t1 continued: Mac спал — крышка закрыта в 19:51')
    // One continuation per cut, whatever the clock does after.
    await w.clock.advance(30 * MIN)
    expect(w.submitted).toHaveLength(1)
  })

  test('the owner writing before the wake takes the cut over: nothing is sent', { plugins: [LID_PLUGIN] }, async ($, on) => {
    const w = world(on)
    await start($)
    await cutAtDarkWake($, w)
    await typed($, 'ты прервался, продолжай')
    await sleepUntilLidOpens($, w)
    expect(w.submitted.filter(s => s.origin === 'plugin')).toHaveLength(0)
    expect(w.files.get(LOG)).toContain('not continued: the owner wrote first')
    expect(w.statuses.at(-1)).toBeUndefined()
  })

  test('a slash command typed meanwhile is no answer: the cut still continues', { plugins: [LID_PLUGIN] }, async ($, on) => {
    const w = world(on)
    await start($)
    await cutAtDarkWake($, w)
    await typed($, '/wake')
    await sleepUntilLidOpens($, w)
    expect(w.submitted.filter(s => s.origin === 'plugin')).toHaveLength(1)
  })

  test('a draft in the box holds the continuation until it is cleared', { plugins: [LID_PLUGIN] }, async ($, on) => {
    const w = world(on)
    await start($)
    await cutAtDarkWake($, w)
    w.draft = 'погоди, я'
    await sleepUntilLidOpens($, w)
    await w.clock.advance(3 * TICK_MS)
    expect(w.submitted).toHaveLength(0)
    w.draft = ''
    await w.clock.advance(TICK_MS)
    expect(w.submitted).toHaveLength(1)
  })

  test('a turn waiting on the owner is not continued: an open question, or a permission dialog', { plugins: [LID_PLUGIN] }, async ($, on) => {
    const w = world(on)
    await start($)
    await w.clock.set(CUT_AT)
    void $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
    await w.clock.settle()
    await endTurn($, w, CUT_TEXT, 'tq')
    w.answerOwner()
    await $.turn.start({ text: '', turnId: 'tp' })
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
    await endTurn($, w, CUT_TEXT, 'tp')
    await sleepUntilLidOpens($, w)
    expect(w.submitted).toHaveLength(0)
    expect(w.files.get(LOG)?.match(/waiting on the owner/g)).toHaveLength(2)
  })

  test('a subagent\'s cut is its parent\'s business: nothing waits', { plugins: [LID_PLUGIN] }, async ($, on) => {
    const w = world(on)
    await start($)
    await w.clock.set(CUT_AT)
    await endTurn($, w, CUT_TEXT, 'ta', 'agent-1')
    expect(w.statuses.at(-1)).toBeUndefined()
    await sleepUntilLidOpens($, w)
    expect(w.submitted).toHaveLength(0)
  })

  test('StopFailure and turn.complete naming one cut send one continuation', { plugins: [LID_PLUGIN] }, async ($, on) => {
    const w = world(on)
    await start($)
    await $.turn.start({ text: 'дальше', turnId: 't7' })
    await w.clock.set(CUT_AT)
    await $.classic.StopFailure({ error: 'server_error', last_assistant_message: CUT_TEXT } as never)
    await endTurn($, w, CUT_TEXT, 't7')
    await sleepUntilLidOpens($, w)
    expect(w.submitted).toHaveLength(1)
  })

  test('awake five minutes with nobody at the keys continues; a long dark wake does not', { plugins: [LID_PLUGIN] }, async ($, on) => {
    const w = world(on)
    await start($)
    await cutAtDarkWake($, w)
    // A Power Nap that runs on: the log still ends on the dark wake.
    await w.clock.advance(STEADY_MS + TICK_MS)
    expect(w.submitted).toHaveLength(0)
    // Then a full wake nobody touched (a cut with no sleep behind it looks the same).
    w.powerLog = LOG_06
    await w.clock.advance(STEADY_MS + TICK_MS)
    expect(w.submitted).toHaveLength(1)
  })

  test('a cut with no sleep in the log says so instead of blaming the lid', { plugins: [LID_PLUGIN] }, async ($, on) => {
    const w = world(on)
    w.powerLog = POWER_LOG.split('\n').filter(l => l.includes('2026-10-06 19:1')).join('\n')
    await start($)
    await w.clock.set(CUT_AT)
    await endTurn($, w, CUT_TEXT)
    w.isUserActive = true
    await w.clock.advance(TICK_MS)
    expect(w.submitted[0]?.text).toContain(NO_SLEEP)
  })

  test(`after ${STREAK_MAX} continuations in a row without the owner the next cut waits for them; their message resets it`, { plugins: [LID_PLUGIN] }, async ($, on) => {
    const w = world(on)
    w.isUserActive = true
    w.powerLog = LOG_06
    await start($)
    await w.clock.set(CUT_AT)
    for (let i = 1; i <= STREAK_MAX + 1; i++) {
      await endTurn($, w, CUT_TEXT, `c${i}`)
      await w.clock.advance(TICK_MS)
    }
    expect(w.submitted).toHaveLength(STREAK_MAX)
    expect(w.files.get(LOG)).toContain(`${STREAK_MAX} auto-continues in a row`)
    await typed($, 'я тут')
    await endTurn($, w, CUT_TEXT, 'c9')
    await w.clock.advance(TICK_MS)
    expect(w.submitted.filter(s => s.origin === 'plugin')).toHaveLength(STREAK_MAX + 1)
  })

  test('/wake says whether a cut waits, the last sleep by pmset and where the log is', { plugins: [LID_PLUGIN] }, async ($, on) => {
    const w = world(on)
    w.powerLog = LOG_06
    await start($)
    const idle = (await wakeCmd($)) as { text: string }
    expect(idle.text).toContain('Оборванных сном ходов нет')
    expect(idle.text).toContain('крышка закрыта в 19:51')
    expect(idle.text).toContain('~/.claude/state/wake-resume/resume.log')
    await cutAtDarkWake($, w)
    const waiting = (await wakeCmd($)) as { text: string }
    expect(waiting.text).toContain('Ждёт пробуждения')
    expect(waiting.text).toContain('cut t1: sleep mid-response')
  })
})
