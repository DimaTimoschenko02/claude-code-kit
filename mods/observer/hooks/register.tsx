// observer: a side observer of the main session, our own replacement for the built-in you-should-know. After every
// main-thread reply a background Sonnet completion reads what happened since its last check — Dima's words and
// Claude's replies whole, tool calls in one line, failed results — with the project's rules, the inventory of our
// tools, its own notes for the session and the facts the mod counted, and answers with new notes and at most one
// KNOW (what Dima should know and will likely miss) and one REPEAT (повторы и затыки: work running harder than it
// should, and the tool that would fix it). KNOW goes to the band above the prompt; REPEAT goes to the session's
// findings file, reaches the band only when it rests on a counted fact, and is handed once to the main model with
// the next prompt. Repeats are counted by code over the whole session, never remembered by the model.
//
// The band's line has three actions, as the built-in's «Chat in main session»: «в чат» puts it in the prompt box for
// the owner to send or extend, «сохранить» adds it to the durable defects file, «убрать» takes it down. The engine's own
// `[-]` at the band's right end only folds the band: the line stays.
//
// Why a completion, not a subagent: a plugin-spawned subagent's hand-back starts a main turn — on every reply, a loop.

import type { EngineInterface, Register, SessionMessage } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { ObserverBand, ObserverFinding, ObserverSession } from '../types'
import type { Inventory, RulesFile } from './logic'
import {
  CHECK_TIMEOUT_MS,
  INITIAL,
  MAX_FINDINGS,
  MAX_REPLY_TOKENS,
  MAX_UNSEEN,
  OBSERVER_MODEL,
  changingBlock,
  claimOnReply,
  chatText,
  clockTime,
  contextNote,
  defectLine,
  count,
  cursorAt,
  deltaFrom,
  factLine,
  failureReason,
  findingLine,
  hitsIn,
  inventoryBlock,
  isDuplicate,
  lastDefects,
  noTranscriptError,
  norm,
  oneLine,
  parseReply,
  releaseRun,
  renderDelta,
  restsOnFact,
  rulesBlock,
  stableBlock,
  stamp,
  thresholdOf,
  withDefect,
} from './logic'

const SESSION = atom({ plugin: 'observer', key: 'session' } as const, INITIAL)
const BAND = atom({ plugin: 'observer', key: 'band' } as const, null as ObserverBand)

const COMMAND = 'observer'
/** The band goes after this many owner prompts: a finding he has typed past twice is stale. */
const BAND_PROMPTS = 2
/** A findings file's name: the session id, a UUID. Pruning touches nothing else in the folder. */
const FINDINGS_NAME = '????????-????-????-????-????????????.md'

type Config = {
  sid: string
  root: string
  cwd: string
  home: string
  dir: string
  findingsPath: string
  logPath: string
  /** Defects the owner chose to keep, across sessions and projects; never pruned by age. */
  defectsPath: string
  /** Checks run here: an interactive session, or a headless one the owner opted in with CLAUDE_OBSERVER_HEADLESS=1. */
  active: boolean
}

let cached: Promise<Config> | null = null
let stable: Promise<string> | null = null
/** From session.start; a reload fires it again. Unknown → treat as interactive. */
let interactive: boolean | null = null

function config($: EngineInterface): Promise<Config> {
  if (cached === null) {
    cached = load($)
    cached.catch(() => {
      cached = null
    })
  }
  return cached
}

async function load($: EngineInterface): Promise<Config> {
  const [root, cwd, sid, home, headless] = await Promise.all([
    $.session.root(),
    $.session.cwd(),
    $.session.id(),
    $.env.get('HOME'),
    $.env.get('CLAUDE_OBSERVER_HEADLESS'),
  ])
  const dir = `${home ?? ''}/.claude/state/observer`
  return {
    sid,
    root,
    cwd,
    home: home ?? '',
    dir,
    findingsPath: `${dir}/${sid}.md`,
    logPath: `${dir}/checks.log`,
    defectsPath: `${dir}/defects.md`,
    active: interactive !== false || headless === '1',
  }
}

/** The cached prefix: prompt, rules, inventory — computed once per module load, so every call opens the same. */
function stablePart($: EngineInterface, c: Config): Promise<string> {
  if (stable === null) {
    stable = buildStable($, c)
    stable.catch(() => {
      stable = null
    })
  }
  return stable
}

async function buildStable($: EngineInterface, c: Config): Promise<string> {
  const candidates = [
    `${c.root}/.claude/CLAUDE.md`,
    `${c.root}/CLAUDE.md`,
    ...(c.cwd === c.root ? [] : [`${c.cwd}/.claude/CLAUDE.md`, `${c.cwd}/CLAUDE.md`]),
    `${c.home}/.claude/CLAUDE.md`,
  ]
  const files: RulesFile[] = []
  const real = new Set<string>()
  for (const path of candidates) {
    const st = await $.fs.stat(path, { resolve: true }).catch(() => null)
    if (st === null || st.kind !== 'file') continue
    const key = st.realPath ?? path
    if (real.has(key)) continue
    real.add(key)
    files.push({ path, text: await $.fs.read(path).catch(() => '') })
  }
  return stableBlock(rulesBlock(files), inventoryBlock(await inventory($, c)))
}

async function inventory($: EngineInterface, c: Config): Promise<Inventory> {
  const [commands, usage, dirsEnv] = await Promise.all([
    $.command.list().catch(() => []),
    $.session.usage({ breakdown: 'summary' }).catch(() => null),
    $.env.get('CLAUDE_CODE_PLUGIN_DIRS').catch(() => undefined),
  ])
  const b = usage?.context.breakdown
  const mods = (dirsEnv ?? '').split(':').filter(d => d !== '').map(d => d.replace(/\/+$/, '').split('/').pop() ?? '')
  const binDirs = new Set([`${c.root}/bin`, `${c.cwd}/bin`])
  const top = await $.fs.list(c.root).catch(() => [])
  for (const e of top.filter(e => e.kind === 'dir' && !e.name.startsWith('.')).slice(0, 30)) binDirs.add(`${c.root}/${e.name}/bin`)
  const scripts: string[] = []
  for (const d of binDirs) {
    const list = await $.fs.list(d).catch(() => [])
    const rel = d.startsWith(`${c.root}/`) ? d.slice(c.root.length + 1) : d
    for (const e of list.slice(0, 60)) if (e.kind !== 'dir' && !e.name.startsWith('.')) scripts.push(`${rel}/${e.name}`)
  }
  return {
    commands: commands.map(x => ({ name: x.name, description: x.description, source: x.source, ...(x.plugin === undefined ? {} : { plugin: x.plugin }) })),
    agents: (b?.agents ?? []).map(a => a.agentType),
    skills: (b?.skills?.skillFrontmatter ?? []).map(s => s.name),
    mods,
    scripts,
  }
}

const readState = async ($: EngineInterface): Promise<ObserverSession> => norm(await read($, SESSION))

const change = ($: EngineInterface, fn: (v: ObserverSession) => ObserverSession): Promise<ObserverSession> =>
  update($, SESSION, v => fn(norm(v)))

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

type Outcome = {
  kind: 'checked' | 'empty' | 'discarded' | 'error'
  reason?: string
  ms: number
  count: number
  chars: number
  facts: number
  know: number
  repeat: number
  band: boolean
  notes: string
  usage?: Usage
}

/** Appends lines to a bounded file (read, append, keep the last `keep`). */
async function appendBounded($: EngineInterface, path: string, lines: readonly string[], keep: number): Promise<void> {
  const old = await $.fs.read(path).catch(() => '')
  const rows = old === '' ? [] : old.replace(/\n$/, '').split('\n')
  rows.push(...lines)
  await $.fs.write(path, `${rows.slice(-keep).join('\n')}\n`)
}

/**
 * One check: count the delta, ask the observer, then — if this run still holds the slot and the session is the same —
 * move the cursor, keep the notes, file the findings. A failed call leaves the cursor, so the next check covers this
 * delta too; the counts stay (ids are remembered, so nothing is counted twice).
 */
async function checkOnce($: EngineInterface, c: Config, gen: number, messages: readonly SessionMessage[]): Promise<Outcome> {
  const t0 = await $.clock.now()
  const s = await readState($)
  const delta = deltaFrom(messages, s.cursor)
  const cursor = cursorAt(messages)
  const rendered = renderDelta(delta)
  const counted = count(s.counters, s.seenIds, hitsIn(delta), t0)
  const facts = counted.facts.map(f => factLine(f.c, t0))
  const base = { count: delta.length, chars: rendered.text.length, facts: facts.length, know: 0, repeat: 0, band: false, notes: '' }
  // the counts land now: they are facts about the transcript whatever the model says
  await change($, v => ({ ...v, counters: counted.counters, seenIds: counted.seenIds }))

  if (rendered.text.trim() === '') {
    await change($, v => (v.checking?.gen !== gen || cursor === null ? v : { ...v, cursor }))
    return { kind: 'empty', ms: 0, ...base }
  }

  const prefix = await stablePart($, c)
  const r = await $.model.complete({
    model: OBSERVER_MODEL,
    prompt: [
      { text: prefix, cache: true },
      { text: changingBlock({ notes: s.notes, facts, delta: rendered.text, count: rendered.count, now: t0, since: s.last?.at ?? null }) },
    ],
    maxTokens: MAX_REPLY_TOKENS,
    effort: 'medium',
    timeoutMs: CHECK_TIMEOUT_MS,
  })
  const now = await $.clock.now()
  const usage: Usage = r.usage
  if (!r.isAnswered) {
    const reason = failureReason(r)
    // a fact that crossed now must still reach the observer: give the threshold back
    await change($, v => ({ ...v, error: reason, counters: unreport(v.counters, counted.facts.map(f => f.key)) }))
    return { kind: 'error', reason, ms: now - t0, ...base, usage }
  }
  const p = parseReply(r.text)
  if ((await $.session.id()) !== c.sid) return { kind: 'discarded', ms: now - t0, ...base, usage }

  const before = s.findings
  const found: ObserverFinding[] = []
  const notes: string[] = []
  if (p.notesCut > 0) notes.push(`notes_cut=${p.notesCut}`)
  if (p.bad !== null) notes.push(`bad(${p.bad})`)
  if (p.know !== null) {
    if (isDuplicate(p.know, before)) notes.push('dup_know')
    else found.push({ at: now, kind: 'KNOW', text: p.know, fact: false })
  }
  if (p.repeat !== null) {
    if (isDuplicate(p.repeat, before)) notes.push('dup_repeat')
    else found.push({ at: now, kind: 'REPEAT', text: p.repeat, fact: facts.length > 0 && restsOnFact(p.repeat) })
  }
  const banded = [...found].reverse().find(f => f.kind === 'KNOW' || f.fact) ?? null
  const repeats = found.filter(f => f.kind === 'REPEAT').map(f => f.text)

  const out = { applied: false }
  await change($, v => {
    out.applied = v.checking?.gen === gen
    if (!out.applied) return v
    return {
      ...v,
      cursor,
      notes: p.notes ?? v.notes,
      findings: [...v.findings, ...found].slice(-MAX_FINDINGS),
      unseen: [...v.unseen, ...repeats].slice(-MAX_UNSEEN),
      checks: v.checks + 1,
      error: p.ok ? null : `ответ не по формату: ${p.bad ?? '?'}`,
      last: {
        at: now,
        ms: now - t0,
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
        lines: found.length,
      },
    }
  })
  if (!out.applied) return { kind: 'discarded', ms: now - t0, ...base, usage }
  if (banded !== null) await update($, BAND, () => ({ text: banded.text, kind: banded.kind, at: now, prompts: 0, fact: banded.fact }))
  if (found.length > 0) await appendBounded($, c.findingsPath, found.map(f => findingLine(f)), 500).catch(() => null)
  return {
    kind: 'checked',
    ms: now - t0,
    ...base,
    know: found.filter(f => f.kind === 'KNOW').length,
    repeat: repeats.length,
    band: banded !== null,
    notes: notes.join(' '),
    usage,
  }
}

/** The facts a failed call never delivered are passed again next time. */
function unreport(counters: ObserverSession['counters'], keys: readonly string[]): ObserverSession['counters'] {
  const out = { ...counters }
  for (const k of keys) {
    const c = out[k]
    if (c !== undefined) out[k] = { ...c, reported: thresholdOf(Math.max(0, Math.floor(c.reported / 2))) }
  }
  return out
}

/** One line per check in checks.log (bounded): time, session, ms, tokens, lines emitted. */
async function logCheck($: EngineInterface, c: Config, o: Outcome): Promise<void> {
  const u = o.usage
  const cost = u === undefined
    ? ''
    : ` in=${u.input_tokens} out=${u.output_tokens} cache_read=${u.cache_read_input_tokens} cache_write=${u.cache_creation_input_tokens}`
  const what = o.kind === 'error' ? `error(${o.reason ?? '?'})` : o.kind
  const line =
    `${what} ${(o.ms / 1000).toFixed(1)}s msgs=${o.count} chars=${o.chars} facts=${o.facts} know=${o.know} repeat=${o.repeat}` +
    `${o.band ? ' band' : ''}${o.notes === '' ? '' : ` ${o.notes}`}${cost}`
  $.ui.log(`observer: ${line}`, { to: 'debug' })
  try {
    const stampIso = new Date(await $.clock.now()).toISOString()
    await appendBounded($, c.logPath, [`${stampIso} ${c.sid.slice(0, 8)} ${line}`], 2000)
  } catch {
    // the log is for measuring; the observer never depends on it
  }
}

async function backgroundLoop($: EngineInterface, first: number): Promise<void> {
  let gen: number | null = first
  while (gen !== null) {
    const current: number = gen
    let outcome: Outcome
    let c: Config | null = null
    try {
      c = await config($)
      let messages: readonly SessionMessage[]
      try {
        messages = await $.session.messages()
      } catch (err) {
        if (!noTranscriptError(err)) throw err
        await change($, v => ({ ...v, noTranscript: true, checking: null, dirty: false, error: null })).catch(() => null)
        return
      }
      outcome = await checkOnce($, c, current, messages)
    } catch (err) {
      const reason = `сбой: ${String(err).slice(0, 80)}`
      await change($, v => ({ ...v, error: reason })).catch(() => null)
      outcome = { kind: 'error', reason, ms: 0, count: 0, chars: 0, facts: 0, know: 0, repeat: 0, band: false, notes: '' }
    }
    if (c !== null) await logCheck($, c, outcome)
    const now = await $.clock.now()
    const out = { gen: null as number | null }
    const after = await change($, v => {
      const r = releaseRun(v, current, now)
      out.gen = r.gen
      return r.state
    }).catch(() => null)
    if (after === null) return
    gen = out.gen
  }
}

async function commandText($: EngineInterface, args: string): Promise<string> {
  const c = await config($)
  const word = args.trim().toLowerCase()
  if (word === 'off' || word === 'выкл') {
    await change($, v => ({ ...v, off: true }))
    await update($, BAND, () => null)
    return 'Наблюдатель в этой сессии выключен. Включить: /observer on'
  }
  if (word === 'on' || word === 'вкл') {
    await change($, v => ({ ...v, off: false }))
    return 'Наблюдатель в этой сессии включён: проверка после каждого ответа.'
  }
  if (word === 'saved' || word === 'недочёты' || word === 'недочеты') {
    const text = await $.fs.read(c.defectsPath).catch(() => '')
    const last = lastDefects(text, 10)
    return last.length === 0
      ? `Сохранённых недочётов пока нет. Сохраняет кнопка «сохранить» на полосе наблюдателя; файл: ${tilde(c.defectsPath, c.home)}`
      : [`Последние сохранённые недочёты (${tilde(c.defectsPath, c.home)}):`, ...last].join('\n')
  }
  if (word !== '')
    return 'Команда: /observer — состояние и находки; /observer недочёты — сохранённые недочёты; /observer off | on — выключить или включить в этой сессии.'
  const [s, now] = await Promise.all([readState($), $.clock.now()])
  const lines: string[] = []
  if (s.noTranscript) lines.push('Наблюдатель: хост этой сессии (SDK) не даёт плагинам транскрипт — здесь не работает.')
  else if (!c.active) lines.push('Наблюдатель: сессия неинтерактивная (claude -p) — не проверяет (включить: CLAUDE_OBSERVER_HEADLESS=1).')
  else lines.push(`Наблюдатель: ${s.off ? 'выключен в этой сессии (/observer on)' : 'включён — фоновый Sonnet после каждого ответа (/observer off)'}.`)
  if (s.checking !== null) lines.push('Сейчас идёт проверка.')
  if (s.error !== null) lines.push(`Последняя проверка не удалась: ${s.error}.`)
  if (s.last !== null) {
    const l = s.last
    lines.push(
      `Проверок: ${s.checks}; последняя в ${clockTime(l.at)}: ${(l.ms / 1000).toFixed(0)} с, вход ${l.input} токенов ` +
        `(из кэша ${l.cacheRead}, в кэш ${l.cacheWrite}), выход ${l.output}; находок в ней: ${l.lines}.`,
    )
  } else lines.push('Проверок ещё не было: первая — после ответа.')
  const recent = s.findings.slice(-5)
  lines.push('', recent.length === 0 ? 'Находок в этой сессии нет.' : 'Последние находки:')
  for (const f of recent) lines.push(`- ${stamp(f.at, now)} ${f.kind}${f.fact ? ' (по счётчику)' : ''}: ${oneLine(f.text, 400)}`)
  const over = Object.values(s.counters).filter(k => k.reported > 0).sort((a, b) => b.n - a.n).slice(0, 10)
  if (over.length > 0) {
    lines.push('', 'Счётчики (3 и больше за сессию):')
    for (const k of over) lines.push(`- ${k.label} × ${k.n} (${stamp(k.first, now)} … ${stamp(k.last, now)})`)
  }
  lines.push(
    '',
    'Полоса над промптом: «в чат» (1) — подсказка в поле ввода, отправишь или допишешь; «сохранить» (2) — строкой в файл недочётов; «убрать» (0) — подсказка уходит совсем.',
    '[-] справа на полосе — это движок: сворачивает всю полосу (ctrl+x ctrl+a), подсказка остаётся.',
    '',
    `Файл находок сессии: ${c.findingsPath}`,
    `Сохранённые недочёты (все проекты, /observer недочёты): ${c.defectsPath}`,
    `Журнал проверок (время, токены): ${c.logPath}`,
  )
  return lines.join('\n')
}

const tilde = (path: string, home: string): string => (home !== '' && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)

/** «в чат»: the line into the prompt box (after a draft, never over it); no box at all → sent as the mod's message. */
async function toChat($: EngineInterface, band: NonNullable<ObserverBand>): Promise<void> {
  try {
    const text = chatText(band)
    const box = await $.prompt.read()
    const draft = box.text.trim() !== ''
    const r = await $.prompt.fill({ text: draft ? `\n${text}` : text, mode: draft ? 'append' : 'replace' })
    if (r.isFilled) {
      await update($, BAND, b => (b !== null && b.at === band.at ? null : b))
      return
    }
    if (r.refusal === 'no_composer') {
      await $.prompt.submit({ text })
      await update($, BAND, b => (b !== null && b.at === band.at ? null : b))
      return
    }
    $.ui.toast(r.refusal === 'dialog' ? 'Открыт диалог — ответь на него и нажми «в чат» ещё раз.' : 'Поле ввода не приняло текст.')
  } catch (err) {
    $.ui.toast(`Наблюдатель: не вставил в чат — ${String(err).slice(0, 80)}`)
  }
}

/** «сохранить»: one line in the defects file; the band stays, its button says it is saved. */
async function saveDefect($: EngineInterface, band: NonNullable<ObserverBand>): Promise<void> {
  try {
    const c = await config($)
    const project = c.root.replace(/\/+$/, '').split('/').pop() ?? ''
    const line = defectLine({ at: band.at, kind: band.kind, fact: band.fact === true, text: band.text, project, sid: c.sid })
    const old = await $.fs.read(c.defectsPath).catch(() => '')
    const next = withDefect(old, line, band.text)
    if (next !== null) await $.fs.write(c.defectsPath, next)
    await update($, BAND, b => (b !== null && b.at === band.at ? { ...b, saved: true } : b))
    $.ui.toast(next === null ? `Уже в недочётах: ${tilde(c.defectsPath, c.home)}` : `Сохранено в недочёты: ${tilde(c.defectsPath, c.home)}`)
  } catch (err) {
    $.ui.toast(`Наблюдатель: не сохранил — ${String(err).slice(0, 80)}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cached = null
    stable = null
    interactive = e.isInteractive
    const r = await next(e)
    try {
      await $.command
        .register({
          name: 'observer',
          description: 'Наблюдатель: находки этой сессии, счётчики повторов, стоимость проверок; off | on',
          immediate: true,
        })
        .catch(err => $.ui.log(`observer: /${COMMAND} not registered: ${String(err)}`, { to: 'debug' }))
      const c = await config($)
      await $.process
        .run(['find', c.dir, '-maxdepth', '1', '-type', 'f', '-name', FINDINGS_NAME, '-mtime', '+30', '-delete'], { timeoutMs: 5000 })
        .catch(() => null)
      // a check claimed by the instance before a reload died with it; the next reply's check covers its delta
      await change($, v => (v.checking === null ? v : { ...v, checking: null, dirty: false }))
    } catch {
      // nothing to set up is worth failing a session start
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    cached = null
    stable = null
    await update($, SESSION, () => INITIAL).catch(() => null)
    await update($, BAND, () => null).catch(() => null)
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.agent_id !== undefined || e.source !== 'clear') return r
    // /clear: a new session id, a new observer from its first reply
    cached = null
    await update($, SESSION, () => INITIAL).catch(() => null)
    await update($, BAND, () => null).catch(() => null)
    return r
  })

  on('command.run', { command: 'observer' }, async ($, e) => {
    try {
      return { text: await commandText($, e.args) }
    } catch (err) {
      return { text: `Наблюдатель: не прочитал состояние — ${String(err).slice(0, 120)}` }
    }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || e.isAborted) return r
    try {
      const c = await config($)
      if (!c.active) return r
      const now = await $.clock.now()
      const out = { gen: null as number | null }
      await change($, v => {
        const claim = claimOnReply(v, now)
        out.gen = claim.gen
        return claim.state
      })
      const gen = out.gen
      // a timer, not this dispatch: the check outlives the turn's hooks and never holds the next prompt
      if (gen !== null) $.clock.after(0, () => void backgroundLoop($, gen))
    } catch (err) {
      $.ui.log(`observer: no check after the reply: ${String(err)}`, { to: 'debug' })
    }
    return r
  })

  // unseen REPEAT lines reach the main model once, with the next prompt; the band ages by the owner's prompts
  on('prompt.submit', async ($, e, next) => {
    try {
      const band = await read($, BAND)
      if (band !== null && e.origin.kind === 'composer')
        await update($, BAND, b => (b === null ? b : b.prompts + 1 >= BAND_PROMPTS ? null : { ...b, prompts: b.prompts + 1 }))
      const s = await readState($)
      if (s.unseen.length === 0) return next(e)
      const out = { lines: [] as string[] }
      await change($, v => {
        out.lines = v.unseen
        return { ...v, unseen: [] }
      })
      if (out.lines.length === 0) return next(e)
      return next({ ...e, context: [...(e.context ?? []), contextNote(out.lines)] })
    } catch {
      return next(e)
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const band = await read($, BAND)
    if (band === null || e.props.hasSurvey) return next(e)
    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        <Text color={band.kind === 'KNOW' ? 'cyan' : 'yellow'} wrap="wrap">
          {`👁 ${band.kind === 'KNOW' ? 'знай' : 'повтор'}: ${band.text}`}
        </Text>
        <Box flexDirection="row" gap={2}>
          <Button key="observer-chat" plain hotkey="1" label="в чат" onPress={() => void toChat($, band)} />
          <Button
            key="observer-save"
            plain
            hotkey="2"
            label={band.saved === true ? 'сохранено ✓' : 'сохранить'}
            dimColor={band.saved === true}
            onPress={() => void saveDefect($, band)}
          />
          <Button key="observer-hide" plain hotkey="0" role="dismiss" label="убрать" onPress={() => void update($, BAND, () => null)} />
        </Box>
      </Box>
    )
  })
}
