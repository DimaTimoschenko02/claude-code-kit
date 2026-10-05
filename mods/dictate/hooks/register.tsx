import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, PromptOrigin, Register, Timer } from 'claude-code'

import type { DictateBatch } from '../types'

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
// last moved: a chime ~15 s before the 2-minute cap, and on a stop the person
// did not make a falling tone plus the last words spoken aloud — where to pick
// up. A capped chunk is marked in the batch so the model expects a repeat.
//
// Terms: every person's prompt has misheard phrases from
// ~/.claude/dictate-terms.json replaced before the model reads it.

const batch = atom({ plugin: 'dictate', key: 'batch' } as const, null)

const MAX_AGE_MS = 12 * 60 * 60 * 1000
const PERSON_ORIGINS: ReadonlySet<PromptOrigin['kind']> = new Set(['composer', 'bridge', 'sdk'])
const RELEASE = /^\s*(?:всё|все|готово|отправляй|поехали|go)[\s.!?…,;:)]*$/iu
const HELD = (count: number) =>
  `📥 в пачке ${count} — «всё» или /pack, чтобы отправить; /pack cancel — сбросить`

// Voice mode's own limits (Claude Code 2.1.289, tap mode): 120 s cap, 15 s
// silence. The box shows the first words a second or two after the tap, so the
// thresholds below are measured from then and sit a little under the limits.
const POLL_MS = 1000
const WARN_AFTER_MS = 103_000
const CAP_SEEN_MS = 108_000
const SILENCE_SEEN_MS = 12_000
const NEW_BURST_MS = 16_000
const TAIL_WORDS = 6
// Two minutes of speech is well over this; a typed note rarely is.
const CAP_TEXT_CHARS = 500
const SPEECH_VOICE = 'Milena'
const CUT_MARK = ' ⟨запись оборвалась здесь — следующее сообщение может повторять конец⟩'
const ENDS_SENTENCE = /[.!?…»")\]]\s*$/u
// Keys that move or send rather than type; space is voice mode's tap key.
const NOT_TYPING: ReadonlySet<string> = new Set([' ', 'space', 'return', 'escape', 'up', 'down', 'left', 'right', 'tab'])

type Dollar = EngineInterface
type Taken = { value: DictateBatch | null }
type Stop = 'own' | 'cap' | 'silence'
type Recording = {
  startedAt: number
  lastText: string
  lastChangeAt: number
  isWarned: boolean
}

// Module state: a hot reload empties it; session.start re-arms the watch.
let watcher: Timer | undefined
let recording: Recording | undefined
// A key was typed into the draft since the last send: that send is the person's own.
let isTyped = false

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

/** Appends a held prompt; 0 when the batch was closed meanwhile. */
async function hold($: Dollar, text: string): Promise<number> {
  const written = await update($, batch, value =>
    value === null ? null : { ...value, messages: [...value.messages, text] },
  )
  return written?.messages.length ?? 0
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
  if (arg !== '') {
    return { text: 'пачка: /pack — включить или отправить; /pack cancel — сбросить' }
  }
  const current = await liveBatch($)
  if (current === null) {
    const now = await $.clock.now()
    await update($, batch, value => value ?? { startedAt: now, messages: [] })
    watch($)
    return {
      text:
        '📥 пачка включена — диктуй; «всё» или /pack — отправить, /pack cancel — сбросить\n' +
        'голос сам рвёт запись через 2 мин и после 15 с тишины: за ~15 с до обрыва — двойной писк, ' +
        'на обрыве — гудок и последние слова вслух, с них продолжай',
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
    recording = undefined
    return
  }
  const isNewBurst = recording === undefined || now - recording.lastChangeAt > NEW_BURST_MS
  if (isNewBurst && text !== recording?.lastText) {
    recording = { startedAt: now, lastText: text, lastChangeAt: now, isWarned: false }
    return
  }
  if (recording === undefined) return
  if (text !== recording.lastText) recording = { ...recording, lastText: text, lastChangeAt: now }
  const isMoving = now - recording.lastChangeAt < SILENCE_SEEN_MS
  if (!recording.isWarned && !isTyped && isMoving && now - recording.startedAt >= WARN_AFTER_MS) {
    recording = { ...recording, isWarned: true }
    await $.audio.play({ asset: 'sounds/warn.wav' }).catch(() => undefined)
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

/** The last few words, punctuation dropped, for speech and the drop line. */
function tail(text: string): string {
  const words = text.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim().split(/\s+/u)
  return words.slice(-TAIL_WORDS).join(' ')
}

/** A falling tone and the last words aloud, off the hook's clock. */
function announce($: Dollar, stop: Exclude<Stop, 'own'>, text: string): void {
  const lead = stop === 'cap' ? 'Обрыв.' : 'Пауза, запись стоп.'
  const phrase = `${lead} Конец: ${tail(text)}`
  $.clock.after(0, () => {
    void (async () => {
      await $.audio.play({ asset: 'sounds/cut.wav' }).catch(() => undefined)
      await $.audio
        .speak(phrase, { voice: SPEECH_VOICE })
        .catch(() => $.audio.speak(phrase))
        .catch(err => $.ui.log(`dictate: speech failed: ${String(err)}`, { to: 'debug' }))
    })()
  })
}

function heldLine(count: number, stop: Stop, text: string): string {
  if (stop === 'own') return HELD(count)
  const why = stop === 'cap' ? '✂ запись оборвалась (лимит 2 мин)' : '⏸ запись остановилась на паузе'
  return `${HELD(count)} · ${why} на «…${tail(text)}» — продолжай с этого места`
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
        description: 'Пачка диктовки: включить или отправить, работает и посреди хода; /pack cancel — сбросить',
        argumentHint: '[cancel]',
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

    if (RELEASE.test(e.text)) {
      const taken = await take($)
      if (taken === null || taken.messages.length === 0) return { drop: 'пачка пуста — выключена' }
      return next(await withTerms($, { ...e, text: compose(taken.messages) }))
    }
    if (e.attachments !== undefined && e.attachments.length > 0) {
      $.ui.toast(
        `пачка ещё открыта (${current.messages.length}): сообщение с вложением ушло отдельно`,
        { timeoutMs: 6000 },
      )
      return next(await withTerms($, e))
    }
    const stop = classifyStop(recording, await $.clock.now(), e.text)
    recording = undefined
    isTyped = false
    const count = await hold($, stop === 'cap' ? `${e.text.trimEnd()}${CUT_MARK}` : e.text)
    if (count === 0) return next(await withTerms($, e))
    if (stop !== 'own') announce($, stop, e.text)
    return { drop: heldLine(count, stop, e.text) }
  })

  // Typing into the draft makes the next send the person's own, not a voice cut.
  // Hot event: a flag and nothing else, and only while a batch is watched.
  on('prompt.edit', (_$, e, next) => {
    if (watcher !== undefined && e.key !== undefined && !NOT_TYPING.has(e.key.key)) isTyped = true
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, batch)
    if (current === null || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="yellow" wrap="truncate">
          {`пачка: ${current.messages.length} · всё — отправить · /pack cancel`}
        </Text>
      </Box>
    )
  })
}
