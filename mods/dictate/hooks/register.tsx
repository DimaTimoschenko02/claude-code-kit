import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, PromptOrigin, Register, Timer } from 'claude-code'

import type { DictateBatch, DictateCut } from '../types'

// Voice dictation helpers.
//
// Batch: while batch mode is on, every prompt the person sends is held in
// $.state and dropped before it starts a turn; a release word or /pack sends
// them as one numbered prompt. `/pack` is registered `immediate`, so it
// switches batching on mid-turn too. (Not /batch: that name is a built-in the
// engine refuses to re-register, and it stays untouched.)
//
// Cuts: Claude Code's voice mode in `tap` setting stops a recording by itself
// 120 s after the tap (hard-coded, no setting) and 15 s after the last
// recognised word, and submits what it heard at once. The person dictating
// with his eyes on another window keeps talking into nothing. While a batch is
// open the prompt box is read once a second (voice mode writes its interim
// transcript there), so the mod knows when a recording started and when it
// last moved: a double beep ~15 s before the 2-minute cap, one beep on a stop
// the person did not make, and the last sentences of the stopped chunk in the
// band above the prompt until the next chunk — where to pick up. A capped
// chunk is marked in the batch so the model expects a repeat.
//
// The cap counts from the tap, but the box shows nothing until voice mode has
// connected: on a slow connect (the first recording after an idle spell) it
// buffers the audio and then shows several seconds of speech at once. The
// start is put back by how long that first text took to say, so the warning
// still comes ~15 s before the cap. Every warning and held chunk is a line in
// ~/.claude/state/dictate/voice.log (`/pack log`), to check a missed beep later.
//
// The box: the engine puts a dropped prompt back into the prompt box (as the
// draft, or after it on a new line — read from 2.1.296). Every held chunk is a
// drop, so without care the whole chunk stayed in the box: voice mode would not
// start a fresh recording over it, and the next send carried it into the pack
// again. Each drop therefore takes its text back out of the box once it lands,
// the band shows the tail of the last held chunk instead, and a chunk already in
// the pack is never held twice.
//
// Terms: every person's prompt has misheard phrases from
// ~/.claude/dictate-terms.json replaced before the model reads it.

const batch = atom({ plugin: 'dictate', key: 'batch' } as const, null)
const cut = atom({ plugin: 'dictate', key: 'cut' } as const, null)

const MAX_AGE_MS = 12 * 60 * 60 * 1000
const PERSON_ORIGINS: ReadonlySet<PromptOrigin['kind']> = new Set(['composer', 'bridge', 'sdk'])
const END_WORD = String.raw`(?:всё|все|готово|отправляй|поехали|go)[\s.!?…,;:)]*$`
// A message that is only an end word.
const RELEASE = new RegExp(String.raw`^\s*${END_WORD}`, 'iu')
// An end word as the message's own last sentence: after a sentence end and a
// space (`main.go` is a file, not a send), or on a line of its own.
const TRAILING = new RegExp(String.raw`([.!?…]["»”)\]]*\s+|\n)\s*${END_WORD}`, 'iu')
const SEND_HINT = '«всё» отдельно или последней фразой («… сделать. Всё.»)'
const HELD = (count: number) =>
  `📥 в пачке ${count} — ${SEND_HINT} или /pack — отправить; /pack cancel — сбросить`

// Voice mode's own limits (Claude Code 2.1.289, tap mode): 120 s cap, 15 s
// silence. The thresholds below count from when the speech began (the first
// text, put back by how long it took to say) and sit a little under the limits.
const POLL_MS = 1000
// A brisk speaking rate: the first text is put back by at most what it took to say.
const FAST_CHARS_PER_S = 15
// Voice mode stops 15 s after the tap when no word came, so no start is later than that.
const MAX_BACKDATE_MS = 14_000
const WARN_AFTER_MS = 103_000
const CAP_SEEN_MS = 108_000
const SILENCE_SEEN_MS = 12_000
const NEW_BURST_MS = 16_000
const EXCERPT_SENTENCES = 3
const EXCERPT_CHARS = 320
// Two minutes of speech is well over this; a typed note rarely is.
const CAP_TEXT_CHARS = 500
const CUT_MARK = ' ⟨запись оборвалась здесь — следующее сообщение может повторять конец⟩'
// A dropped prompt lands back in the box a moment after the hook answers.
const LAND_POLL_MS = 100
const LAND_TRIES = 30
// A held chunk this long that opens the next one is the old box text sent again.
const REPEAT_PREFIX_CHARS = 40
const ENDS_SENTENCE = /[.!?…»")\]]\s*$/u
// Keys that move or send rather than type; space is voice mode's tap key.
const NOT_TYPING: ReadonlySet<string> = new Set([' ', 'space', 'return', 'escape', 'up', 'down', 'left', 'right', 'tab'])
const LOG_PATH = '~/.claude/state/dictate/voice.log'
const LOG_KEEP = 300
const LOG_SHOWN = 12

type Dollar = EngineInterface
type Taken = { value: DictateBatch | null }
type Stop = DictateCut['stop']
type Held = { count: number; text: string | null }
type Recording = {
  /** When the speech began: the first sight of text, put back by `backdatedMs`. */
  startedAt: number
  lastText: string
  lastChangeAt: number
  isWarned: boolean
  /** How long the text seen first took to say (0 for a word or two). */
  backdatedMs: number
  firstChars: number
}

// Module state: a hot reload empties it; session.start re-arms the watch.
let watcher: Timer | undefined
let recording: Recording | undefined
// A key was typed into the draft since the box was last empty: the next send is the person's own.
let isTyped = false
// The voice log: lines written one after another; the zone and session read once.
let logChain: Promise<void> = Promise.resolve()
let tzOffsetMin: number | undefined
let sessionId: string | undefined

// ---------------------------------------------------------------- batch state

/** The open batch, or null; a batch older than 12 h is discarded with a toast. */
async function liveBatch($: Dollar): Promise<DictateBatch | null> {
  const current = await read($, batch)
  if (current === null) return null
  const now = await $.clock.now()
  if (now - current.startedAt <= MAX_AGE_MS) return current
  const dropped: Taken = { value: null }
  const left = await update($, batch, value => {
    const isStale = value !== null && now - value.startedAt > MAX_AGE_MS
    dropped.value = isStale ? value : null
    return isStale ? null : value
  })
  if (dropped.value !== null) {
    unwatch()
    $.ui.toast(`пачка из ${dropped.value.messages.length} сообщ. старше 12 ч — сброшена`, {
      timeoutMs: 8000,
    })
  }
  return left
}

/** Clears the batch and returns what it held (null when there was none). */
async function take($: Dollar): Promise<DictateBatch | null> {
  unwatch()
  const taken: Taken = { value: null }
  await update($, batch, value => {
    taken.value = value
    return null
  })
  return taken.value
}

const unmarked = (message: string) =>
  (message.endsWith(CUT_MARK) ? message.slice(0, -CUT_MARK.length) : message).trim()

/**
 * What of `text` is new to the pack: null for a chunk already held, the part
 * after the last held chunk when the chunk opens with it (old box text sent
 * again with a new recording after it), else the text itself.
 */
export function fresh(messages: readonly string[], text: string): string | null {
  const said = text.trim()
  if (said === '' || messages.some(m => unmarked(m) === said)) return null
  const last = unmarked(messages.at(-1) ?? '')
  if (last.length >= REPEAT_PREFIX_CHARS && said.startsWith(last)) {
    const rest = said.slice(last.length).trim()
    return rest === '' ? null : rest
  }
  return said
}

/**
 * The message before an end word that stands as its own last sentence
 * (`… сделать. Всё.` → `… сделать.`), or null when it does not end so. `ну и
 * всё`, `проверь их все.` and `Ну и всё.` are not: the end word must follow a
 * sentence end. What is left may itself be only an end word (`Все. Все.`).
 */
export function beforeEndWord(text: string): string | null {
  const m = TRAILING.exec(text)
  if (m === null) return null
  return text.slice(0, m.index + (m[1] ?? '').length).trimEnd()
}

/**
 * Appends a held prompt, the repeat of a held one left out: `count` 0 when the
 * batch was closed meanwhile, `text` what was added (null for a repeat).
 */
async function hold($: Dollar, text: string, isCap: boolean): Promise<Held> {
  const held: Held = { count: 0, text: null }
  await update($, batch, value => {
    held.text = null
    held.count = value?.messages.length ?? 0
    if (value === null) return null
    const added = fresh(value.messages, text)
    if (added === null) return value
    held.text = added
    held.count += 1
    return { ...value, messages: [...value.messages, isCap ? `${added}${CUT_MARK}` : added] }
  })
  return held
}

/**
 * The rest of the box once a dropped prompt `sent` landed at its end; undefined
 * while it has not landed (or the box holds something else).
 */
export function withoutLanded(box: string, sent: string): string | undefined {
  const text = box.trimEnd()
  const flat = (s: string) => s.replace(/\s+/gu, ' ').trim()
  if (text.endsWith(sent)) return text.slice(0, text.length - sent.length).trimEnd()
  return flat(text) === flat(sent) ? '' : undefined
}

/** Takes a dropped prompt back out of the box once the engine put it there. */
function unland($: Dollar, dropped: string): void {
  const sent = dropped.trim()
  if (sent === '') return
  $.clock.after(0, async () => {
    for (let i = 0; i < LAND_TRIES; i++) {
      const rest = withoutLanded((await $.prompt.read()).text, sent)
      if (rest !== undefined) {
        await $.prompt.fill({ text: rest, mode: 'replace' }).catch(() => undefined)
        return
      }
      await $.clock.sleep(LAND_POLL_MS)
    }
  })
}

/** Drops a person's prompt and clears it from the box the engine puts it back in. */
function drop($: Dollar, text: string, reason: string): { drop: string } {
  unland($, text)
  return { drop: reason }
}

/** Puts released messages back in front of whatever was held since. */
async function restore($: Dollar, taken: DictateBatch): Promise<void> {
  watch($)
  await update($, batch, value =>
    value === null ? taken : { ...value, messages: [...taken.messages, ...value.messages] },
  )
}

function compose(messages: readonly string[]): string {
  const [only] = messages
  if (messages.length === 1 && only !== undefined) return only
  const n = messages.length
  const isSingular = n % 10 === 1 && n % 100 !== 11
  const head = isSingular
    ? `Пачка из ${n} сообщения, надиктованного подряд — одна задача:`
    : `Пачка из ${n} сообщений, надиктованных подряд — одна задача:`
  const body = messages.map((text, i) => `${i + 1}. ${text.trim()}`).join('\n\n')
  return `${head}\n\n${body}`
}

async function toggle($: Dollar, arg: string): Promise<CommandRunResult> {
  if (arg === 'cancel') {
    const taken = await take($)
    return {
      text:
        taken === null
          ? 'пачки нет — сбрасывать нечего'
          : `🗑 пачка сброшена (${taken.messages.length} сообщ.)`,
    }
  }
  if (arg === 'log') return { text: await logTail($) }
  if (arg !== '') {
    return { text: 'пачка: /pack — включить или отправить; /pack cancel — сбросить; /pack log — журнал записей' }
  }
  const current = await liveBatch($)
  if (current === null) {
    const now = await $.clock.now()
    await update($, batch, value => value ?? { startedAt: now, messages: [] })
    await update($, cut, () => null)
    watch($)
    return {
      text:
        `📥 пачка включена — диктуй; ${SEND_HINT} или /pack — отправить, /pack cancel — сбросить\n` +
        'голос сам рвёт запись через 2 мин и после 15 с тишины: за ~15 с до обрыва — двойной писк, ' +
        'на обрыве — один писк, а над полем ввода — последние фразы записи, с них продолжай',
    }
  }
  const taken = await take($)
  if (taken === null || taken.messages.length === 0) {
    return { text: 'пачка пуста — выключена' }
  }
  // The engine refuses $.prompt.submit inside a command.run hook (the prompt
  // would wait on the turn the hook holds), so it goes from a timer of its own.
  $.clock.after(0, () =>
    $.prompt.submit({ text: compose(taken.messages), asUser: true }).catch(async err => {
      await restore($, taken)
      $.ui.toast(`пачка не ушла (${String(err)}) — сообщения возвращены в пачку`, { timeoutMs: 8000 })
    }),
  )
  return { text: `📤 пачка из ${taken.messages.length} сообщ. отправлена` }
}

// ---------------------------------------------------------------- voice cuts

/** Starts the once-a-second read of the prompt box (no-op when running). */
function watch($: Dollar): void {
  if (watcher !== undefined) return
  recording = undefined
  isTyped = false
  watcher = $.clock.every(POLL_MS, () => {
    void observe($).catch(() => undefined)
  })
}

function unwatch(): void {
  watcher?.cancel()
  watcher = undefined
  recording = undefined
  isTyped = false
}

/** One look at the box: when the dictated text started and last moved. */
async function observe($: Dollar): Promise<void> {
  const box = await $.prompt.read()
  const now = await $.clock.now()
  const text = box.text.trim()
  if (text === '') {
    // Voice mode records only into an empty box: what was typed before is gone.
    recording = undefined
    isTyped = false
    return
  }
  const isNewBurst = recording === undefined || now - recording.lastChangeAt > NEW_BURST_MS
  if (isNewBurst && text !== recording?.lastText) {
    const backdatedMs = Math.min(MAX_BACKDATE_MS, Math.round((text.length / FAST_CHARS_PER_S) * 1000))
    recording = {
      startedAt: now - backdatedMs,
      lastText: text,
      lastChangeAt: now,
      isWarned: false,
      backdatedMs,
      firstChars: text.length,
    }
    return
  }
  if (recording === undefined) return
  if (text !== recording.lastText) recording = { ...recording, lastText: text, lastChangeAt: now }
  const isMoving = now - recording.lastChangeAt < SILENCE_SEEN_MS
  if (!recording.isWarned && !isTyped && isMoving && now - recording.startedAt >= WARN_AFTER_MS) {
    recording = { ...recording, isWarned: true }
    const seen = recording
    const outcome = await $.audio.play({ asset: 'sounds/warn.wav' }).then(
      () => 'played',
      (err: unknown) => `failed: ${oneLine(String(err))}`,
    )
    record($, `warn ${outcome} · ${sinceStart(seen, now)}`)
  }
}

/** Who stopped the recording that just arrived, judged at its arrival. */
function classifyStop(seen: Recording | undefined, now: number, text: string): Stop {
  if (isTyped) return 'own'
  // Nothing seen in the box (a chunk under a second, or a box voice mode does
  // not write to): only a long chunk stopped mid-sentence reads as the cap.
  if (seen === undefined) return text.length >= CAP_TEXT_CHARS && !ENDS_SENTENCE.test(text) ? 'cap' : 'own'
  if (now - seen.lastChangeAt >= SILENCE_SEEN_MS) return 'silence'
  if (now - seen.startedAt >= CAP_SEEN_MS) return 'cap'
  return 'own'
}

const secs = (ms: number) => `${Math.round(ms / 1000)} s`
const oneLine = (text: string) => text.replace(/\s+/gu, ' ').trim().slice(0, 200)

/** How long a recording ran, and how much of its start was put back. */
function sinceStart(seen: Recording, now: number): string {
  const put = seen.backdatedMs >= 1000 ? `, ${secs(seen.backdatedMs)} put back for ${seen.firstChars} chars at once` : ''
  return `${secs(now - seen.startedAt)} since the speech began${put}`
}

/** The log line of a held chunk: who stopped it and what the box showed of it. */
export function chunkLine(
  count: number,
  stop: Stop,
  chars: number,
  seen: Recording | undefined,
  now: number,
  wasTyped: boolean,
): string {
  const head = `chunk ${count}: ${stop}, ${chars} chars`
  if (wasTyped) return `${head} · typed into the box`
  if (seen === undefined) return `${head} · the box never showed it, judged by its end`
  const warned = seen.isWarned ? 'warned' : 'no warning'
  return `${head} · ${sinceStart(seen, now)}, still ${secs(now - seen.lastChangeAt)} · ${warned}`
}

/** Local `YYYY-MM-DD HH:MM:SS` at a UTC offset in minutes. */
export function stamp(ms: number, offsetMin: number): string {
  const d = new Date(ms + offsetMin * 60_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  )
}

async function zoneOffset($: Dollar): Promise<number> {
  const out = await $.process.run(['date', '+%z'], { timeoutMs: 5_000 }).catch(() => null)
  const m = /([+-])(\d{2})(\d{2})/u.exec(out?.stdout ?? '')
  if (m === null) return -new Date().getTimezoneOffset()
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

async function logFile($: Dollar): Promise<string | undefined> {
  home ??= await $.env.get('HOME')
  return home === undefined ? undefined : `${home}${LOG_PATH.slice(1)}`
}

async function writeLine($: Dollar, text: string): Promise<void> {
  const path = await logFile($)
  if (path === undefined) return
  tzOffsetMin ??= await zoneOffset($)
  sessionId ??= await $.session.id()
  const old = await $.fs.read(path).catch(() => '')
  const lines = typeof old === 'string' && old !== '' ? old.replace(/\n$/u, '').split('\n') : []
  lines.push(`${stamp(await $.clock.now(), tzOffsetMin)} ${sessionId.slice(0, 8)} ${text}`)
  await $.fs.write(path, `${lines.slice(-LOG_KEEP).join('\n')}\n`)
}

/** One line in the voice log, off the caller's clock; a lost line never stops dictation. */
function record($: Dollar, text: string): void {
  $.clock.after(0, () => {
    logChain = logChain.then(() => writeLine($, text)).catch(() => undefined)
  })
}

async function logTail($: Dollar): Promise<string> {
  const path = await logFile($).catch(() => undefined)
  const text = path === undefined ? '' : await $.fs.read(path).catch(() => '')
  const lines = typeof text === 'string' ? text.split('\n').filter(line => line.trim() !== '') : []
  if (lines.length === 0) return `журнал записей пуст: ${LOG_PATH}`
  return [`журнал записей (${LOG_PATH}), последние ${Math.min(LOG_SHOWN, lines.length)}:`, ...lines.slice(-LOG_SHOWN)].join('\n')
}

/** The last sentences of a chunk (up to 3, about 320 chars): where it stopped. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  const sentences = flat.match(/[^.!?…]+(?:[.!?…]+|$)/gu) ?? [flat]
  let out = ''
  for (let i = sentences.length - 1, n = 0; i >= 0 && n < EXCERPT_SENTENCES; i--, n++) {
    const sentence = (sentences[i] ?? '').trim()
    const longer = out === '' ? sentence : `${sentence} ${out}`
    if (out !== '' && longer.length > EXCERPT_CHARS) break
    out = longer
  }
  if (out.length > EXCERPT_CHARS) return `…${out.slice(-EXCERPT_CHARS).trimStart()}`
  return out.length < flat.length ? `…${out}` : out
}

/** One beep, off the hook's clock: no words, the band shows where it stopped. */
function beep($: Dollar): void {
  $.clock.after(0, () => {
    void $.audio.play({ asset: 'sounds/cut.wav' }).catch(() => undefined)
  })
}

const CUT_LABEL: Record<DictateCut['stop'], string> = {
  own: '✓ в пачке, конец:',
  cap: '✂ запись оборвалась (лимит 2 мин), конец:',
  silence: '⏸ запись встала на паузе 15 с, конец:',
}

function heldLine(count: number, stop: Stop, isRepeat: boolean): string {
  if (isRepeat) return `${HELD(count)} · это уже было в пачке — не добавлено`
  if (stop === 'own') return HELD(count)
  const why = stop === 'cap' ? '✂ запись оборвалась (лимит 2 мин)' : '⏸ запись встала на паузе'
  return `${HELD(count)} · ${why} — где, видно над полем ввода`
}

// ---------------------------------------------------------------- term dictionary

type Terms = { path: string; mtimeMs: number; pattern: RegExp | null; map: Map<string, string> }

// Module cache: a hot reload empties it, which costs one re-read.
let terms: Terms | undefined
let home: string | undefined

const normalize = (phrase: string) => phrase.trim().replace(/\s+/g, ' ').toLowerCase()
const escape = (phrase: string) => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
const isUpperFirst = (text: string) => {
  const first = text.charAt(0)
  return first !== first.toLowerCase() && first === first.toUpperCase()
}

function compile(path: string, mtimeMs: number, source: unknown): Terms {
  const map = new Map<string, string>()
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    for (const [from, to] of Object.entries(source)) {
      const key = normalize(from)
      if (key !== '' && typeof to === 'string') map.set(key, to)
    }
  }
  const keys = [...map.keys()].sort((a, b) => b.length - a.length)
  const pattern =
    keys.length === 0
      ? null
      : new RegExp(
          `(?<![\\p{L}\\p{N}_])(?:${keys.map(k => escape(k).replace(/ /g, '\\s+')).join('|')})(?![\\p{L}\\p{N}_])`,
          'giu',
        )
  return { path, mtimeMs, pattern, map }
}

/** The dictionary, re-read only when the file's mtime changed. */
async function loadTerms($: Dollar): Promise<Terms | undefined> {
  home ??= await $.env.get('HOME')
  if (home === undefined) return undefined
  const path = `${home}/.claude/dictate-terms.json`
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined) {
    terms = undefined
    return undefined
  }
  if (terms !== undefined && terms.path === path && terms.mtimeMs === stat.mtimeMs) return terms
  try {
    terms = compile(path, stat.mtimeMs, JSON.parse(await $.fs.read(path)))
  } catch (err) {
    $.ui.toast(`dictate-terms.json не читается: ${String(err)}`, { timeoutMs: 8000 })
    terms = compile(path, stat.mtimeMs, null)
  }
  return terms
}

function applyTerms(text: string, dict: Terms): { text: string; fixes: string[] } {
  if (dict.pattern === null) return { text, fixes: [] }
  const fixes = new Map<string, string>()
  const fixed = text.replace(dict.pattern, match => {
    const to = dict.map.get(normalize(match))
    if (to === undefined) return match
    const replacement = isUpperFirst(match) ? upperFirst(to) : to
    fixes.set(match, replacement)
    return replacement
  })
  return { text: fixed, fixes: [...fixes].map(([from, to]) => `${from} → ${to}`) }
}

/** The prompt with dictionary fixes applied and named in hidden context. */
async function withTerms<E extends { text: string; context?: readonly string[] }>(
  $: Dollar,
  e: E,
): Promise<E> {
  const dict = await loadTerms($).catch(() => undefined)
  if (dict === undefined) return e
  const { text, fixes } = applyTerms(e.text, dict)
  if (fixes.length === 0) return e
  return { ...e, text, context: [...(e.context ?? []), `dictation fixes: ${fixes.join('; ')}`] }
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command
      .register({
        name: 'pack',
        description: 'Пачка диктовки: включить или отправить, работает и посреди хода; /pack cancel — сбросить; /pack log — журнал записей',
        argumentHint: '[cancel | log]',
        immediate: true,
      })
      .catch(err => $.ui.log(`dictate: /pack not registered: ${String(err)}`, { to: 'debug' }))
    if ((await liveBatch($)) !== null) watch($)
    return next(e)
  })

  on('command.run', { command: 'pack' }, async ($, e) => toggle($, e.args.trim().toLowerCase()))

  on('prompt.submit', async ($, e, next) => {
    const isOwn = e.origin.kind === 'plugin' && e.origin.name === $.plugin.name
    if (!isOwn && !PERSON_ORIGINS.has(e.origin.kind)) return next(e)
    const current = isOwn ? null : await liveBatch($)
    if (current === null) return next(await withTerms($, e))

    const before = beforeEndWord(e.text)
    if (RELEASE.test(e.text) || (before !== null && RELEASE.test(before))) {
      const taken = await take($)
      if (taken === null || taken.messages.length === 0) return drop($, e.text, 'пачка пуста — выключена')
      return next(await withTerms($, { ...e, text: compose(taken.messages) }))
    }
    // Ends with «… . Всё.»: the message joins the pack and the pack goes, attachments with it.
    const isLast = before !== null
    const text = before ?? e.text
    if (!isLast && e.attachments !== undefined && e.attachments.length > 0) {
      $.ui.toast(
        `пачка ещё открыта (${current.messages.length}): сообщение с вложением ушло отдельно`,
        { timeoutMs: 6000 },
      )
      return next(await withTerms($, e))
    }
    const now = await $.clock.now()
    const seen = recording
    const wasTyped = isTyped
    const stop = classifyStop(seen, now, text)
    recording = undefined
    isTyped = false
    // A message that ends with the end word was finished on purpose: never marked as cut.
    const held = await hold($, text, !isLast && stop === 'cap')
    if (held.count === 0) return next(await withTerms($, { ...e, text }))
    if (isLast) {
      record($, `${chunkLine(held.count, stop, held.text?.length ?? 0, seen, now, wasTyped)} · ended with the end word, pack sent`)
      const taken = await take($)
      if (taken === null || taken.messages.length === 0) return next(await withTerms($, { ...e, text }))
      return next(await withTerms($, { ...e, text: compose(taken.messages) }))
    }
    const added = held.text
    if (added !== null) {
      await update($, cut, () => ({ stop, excerpt: excerpt(added) }))
      record($, chunkLine(held.count, stop, added.length, seen, now, wasTyped))
    }
    if (stop !== 'own') beep($)
    return drop($, e.text, heldLine(held.count, stop, added === null))
  })

  // Typing into the draft makes the next send the person's own, not a voice cut.
  // Hot event: a flag and nothing else, and only while a batch is watched.
  on('prompt.edit', (_$, e, next) => {
    if (watcher !== undefined && e.key !== undefined && !NOT_TYPING.has(e.key.key)) {
      const after = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
      isTyped = after.trim() !== ''
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, batch)
    if (current === null || e.props.hasSurvey) return next(e)
    const stopped = await read($, cut)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text color="yellow" wrap="truncate">
          {`пачка: ${current.messages.length} · всё (отдельно или последней фразой) — отправить · /pack cancel`}
        </Text>
        {stopped === null ? null : (
          <Text color="yellow" wrap="wrap">
            {`${CUT_LABEL[stopped.stop]} ${stopped.excerpt}`}
          </Text>
        )}
      </Box>
    )
  })
}
