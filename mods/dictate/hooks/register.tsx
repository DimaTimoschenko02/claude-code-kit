import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, PromptOrigin, Register } from 'claude-code'

import type { DictateBatch } from '../types'

// Voice dictation helpers.
//
// Batch: while batch mode is on, every prompt the person sends is held in
// $.state and dropped before it starts a turn; a release word or /pack sends
// them as one numbered prompt. `/pack` is registered `immediate`, so it
// switches batching on mid-turn too. (Not /batch: that name is a built-in the
// engine refuses to re-register, and it stays untouched.)
//
// Terms: every person's prompt has misheard phrases from
// ~/.claude/dictate-terms.json replaced before the model reads it.

const batch = atom({ plugin: 'dictate', key: 'batch' } as const, null)

const MAX_AGE_MS = 12 * 60 * 60 * 1000
const PERSON_ORIGINS: ReadonlySet<PromptOrigin['kind']> = new Set(['composer', 'bridge', 'sdk'])
const RELEASE = /^\s*(?:всё|все|готово|отправляй|поехали|go)[\s.!?…,;:)]*$/iu
const HELD = (count: number) =>
  `📥 в пачке ${count} — «всё» или /pack, чтобы отправить; /pack cancel — сбросить`

type Dollar = EngineInterface
type Taken = { value: DictateBatch | null }

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
    $.ui.toast(`пачка из ${dropped.value.messages.length} сообщ. старше 12 ч — сброшена`, {
      timeoutMs: 8000,
    })
  }
  return left
}

/** Clears the batch and returns what it held (null when there was none). */
async function take($: Dollar): Promise<DictateBatch | null> {
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
    return { text: '📥 пачка включена — диктуй; «всё» или /pack — отправить, /pack cancel — сбросить' }
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
    await liveBatch($)
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
    const count = await hold($, e.text)
    return count === 0 ? next(await withTerms($, e)) : { drop: HELD(count) }
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
