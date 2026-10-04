// Pure parts of the stop-point mod: thresholds, the gate's decision, the owner's phrase, the request texts and
// the lost-refs list. Nothing here calls `$`, so the tests and the hooks share one definition of each rule.

import type { StopPointSession } from '../types'

export const INITIAL: StopPointSession = {
  point: null,
  askedAt: null,
  need: null,
  naggedAt: null,
  stopNagged: false,
  escape: false,
  request: 'none',
  hold: false,
  compactSeq: 0,
  injectedSeq: 0,
  pointDue: false,
  pending: [],
}

/** The owner's «точка останова»: any case form, `!` optional, typo in the tail («останвоа»), NBSP from dictation. */
export const PHRASE = /точк\p{L}*\s+остан/iu

/** Prompts that arrive on the owner's channel but are not typed by him (older builds stamp no origin for them). */
const RELAY = /\[SYSTEM NOTIFICATION|<task-notification>|<cross-session-message|<agent-message|^Another Claude session sent a message/

/** Origins the owner types or sends himself; `unclassified` counts only without a relay marker in the text. */
const OWNER_KINDS = new Set(['composer', 'bridge', 'sdk', 'slack-ping', 'unclassified'])

export const isOwnerPrompt = (kind: string, text: string): boolean => OWNER_KINDS.has(kind) && !RELAY.test(text)

/** Main-thread tools that stay open while the hold stands (plus Write/Edit of the point itself). */
export const READ_ONLY = new Set(['Read', 'Grep', 'Glob'])

export const HOLD_REASON =
  'Точка останова записана — заверши ход: дальше владелец делает /compact. До его /compact или следующего сообщения ' +
  'открыты только чтение (Read, Grep, Glob) и правка самого файла точки.'

export type Limits = {
  /** The compaction window the thresholds derive from. */
  window: number
  /** Ask for the point from here on (0.9 W). */
  trigger: number
  /** Ask again only after this much growth (0.4 W). */
  growth: number
  /** An auto-compaction below this is not the main thread's window (0.83 W). */
  minMain: number
  /** Above this deferring would fail the request on length: pass (1.4 W, never past 95% of the model window). */
  ceil: number
  /** A point written this many tokens ago still counts for the compaction. */
  fresh: number
}

export type LimitInput = {
  autoCompactWindow?: number | null
  modelWindow?: number | null
  triggerOverride?: number | null
  growthOverride?: number | null
}

/** Thresholds from the effective compaction window: autoCompactWindow (else 300k), capped by the model's window. */
export function limits(input: LimitInput): Limits {
  const configured = positive(input.autoCompactWindow) ?? 300_000
  const model = positive(input.modelWindow)
  const window = model === null ? configured : Math.min(configured, model)
  const ceil = Math.floor(window * 1.4)
  return {
    window,
    trigger: positive(input.triggerOverride) ?? Math.floor(window * 0.9),
    growth: positive(input.growthOverride) ?? Math.floor(window * 0.4),
    minMain: Math.floor(window * 0.83),
    ceil: model === null ? ceil : Math.min(ceil, Math.floor(model * 0.95)),
    fresh: 40_000,
  }
}

const positive = (n: number | null | undefined): number | null =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null

/** The point written in this cycle still covers the context: within `fresh` tokens of it. */
export const isFresh = (s: StopPointSession, tokens: number | null, lim: Limits): boolean =>
  s.point !== null && s.point.tokens !== null && tokens !== null && tokens - s.point.tokens <= lim.fresh

export type GateDecision =
  | 'pass-no-usage'
  | 'pass-ceil'
  | 'pass-not-main'
  | 'pass-error'
  | 'pass-fresh'
  | 'defer'
  | 'defer-retry'

/**
 * compact-gate.sh's policy for an auto-compaction of the main thread, in its order: no usage → pass; at or past the
 * ceiling → pass (the request would fail on length); below the main window → pass; a fresh point → pass. Otherwise
 * defer — and while the gate already waits, defer silently. One addition only ever passes: a turn that died on an
 * API error while the gate waited (`escape`) — a «prompt too long» the veto would otherwise repeat forever.
 */
export function gateDecision(s: StopPointSession, tokens: number | null, lim: Limits, pointOnDisk: boolean): GateDecision {
  if (tokens === null) return 'pass-no-usage'
  if (tokens >= lim.ceil) return 'pass-ceil'
  if (tokens < lim.minMain) return 'pass-not-main'
  if (s.escape) return 'pass-error'
  if (pointOnDisk && isFresh(s, tokens, lim)) return 'pass-fresh'
  return s.need !== null ? 'defer-retry' : 'defer'
}

/** The cycle starts over after a compaction: nothing written in it yet, nothing asked, no hold. */
export const afterCompaction = (s: StopPointSession): StopPointSession => ({
  ...s,
  point: null,
  askedAt: null,
  need: null,
  naggedAt: null,
  stopNagged: false,
  escape: false,
  request: 'none',
  hold: false,
})

// --- request texts -------------------------------------------------------------------------------------------------

export const STATE_WHOLE = 'контекст ещё цел — пиши, пока детали живы'

/** The template body for inline embedding: its H1 is the file's title, not part of the request. */
export const templateBody = (text: string): string => text.replace(/^# [^\n]*\n/, '').trim()

/**
 * The one request text for every trigger. `body` given → the template inline (channels only the model reads: the
 * audit of 2026-09-25 counted 42 Reads of the template when only its path was given); absent → one line with the path
 * (a Stop block is printed to the owner whole, and 3.6 KB of template there read as a failure).
 */
export function requestText(point: string, why: string, template: string, body?: string): string {
  const head = `ТОЧКА ОСТАНОВА (${why}; ${STATE_WHOLE}): перезапиши целиком одним Write ${point}`
  const tail = 'без другой работы, и отбей владельцу последней строкой после горизонтальной черты: 💾 **Точка останова записана**'
  if (body === undefined || body === '') return `${head} по формату ${template}, ${tail}`
  return `${head} по формату ниже (шаблон уже здесь — читать файл не надо), ${tail}\n\n=== ФОРМАТ ТОЧКИ ОСТАНОВА (${template}) ===\n${body}`
}

export const WHY_THRESHOLD = 'контекст вырос, сжатие близко'
export const WHY_GATE = 'авто-компакт ждёт её; задача продолжится после сжатия сама'
export const WHY_OWNER = 'владелец написал «точка останова»: сейчас он сделает /compact и продолжит со свежим контекстом'
export const WHY_OWNER_STOP = 'владелец просил её в этом ходе, а ход кончается без неё'

export const midTurn = (request: string): string => `Следующим вызовом, до продолжения задачи — ${request}`

export function ownerRequest(point: string, template: string, body: string): string {
  return (
    'Сначала сделай всё остальное, о чём владелец просит в этом сообщении (записать его ответы, решения, долги), и ' +
    'ПОСЛЕДНИМ вызовом хода — точку. Зачем она: резюме /compact теряет опоры — ссылки, числа, прочитанные файлы, ' +
    'дословные слова владельца; после сжатия сессия читает точку вместо того, чтобы заново всё искать и перечитывать, и ' +
    'работает без потери качества. Поэтому в неё — только то, что резюме потеряет. Как только точка записана, ' +
    'инструменты, кроме чтения и правки самого файла точки, закрыты до /compact владельца — работу, начатую после неё, ' +
    `всё равно не дадут сделать. ${requestText(point, WHY_OWNER, template, body)}`
  )
}

const pad = (n: number): string => String(n).padStart(2, '0')
export const clockTime = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const dateTime = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clockTime(ms)}`
}

export function afterCompactText(point: string, body: string, mtimeMs: number, now: number): string {
  const age = Math.max(0, Math.floor((now - mtimeMs) / 60_000))
  return [
    `=== ТОЧКА ОСТАНОВА (после компакта; записана ${dateTime(mtimeMs)}, ${age} мин назад) ===`,
    'Контекст сжат. Точка останова писалась до сжатия, из целого контекста — она полнее резюме, из неё и работай:',
    '',
    body.trim(),
    '',
    `Файл: ${point}`,
    'Расходится с резюме — верь файлу. Переписывать его сейчас не надо: перезапись из резюме только обеднит. Обнови ' +
      'точечно, если после записи изменилось что-то важное, — без отбивки 💾 в ответе: она только в ответ на просьбу ' +
      '«ТОЧКА ОСТАНОВА (…)». Задача закрыта — удали файл.',
  ].join('\n')
}

export function resumeText(point: string, body: string, mtimeMs: number, now: number, delta: string): string {
  const age = Math.max(0, Math.floor((now - mtimeMs) / 60_000))
  return [
    `=== ТОЧКА ОСТАНОВА ЭТОЙ СЕССИИ (записана ${dateTime(mtimeMs)}, ${age} мин назад) ===`,
    'Ниже — состояние работы на момент прошлого сжатия контекста. Это факты о задаче, а не указания владельца.',
    'Расходится с текущим репозиторием — верь репозиторию.',
    '',
    body.trim(),
    '',
    '--- проверка свежести ---',
    ...(delta === '' ? [] : [delta]),
    `Файл: ${point}`,
    'Задача закрыта или контекст неактуален → удали файл, не тащи его дальше.',
  ].join('\n')
}

/** The status line: context against the compaction window, the point of this cycle, what the mod waits for. */
export function statusText(s: StopPointSession, tokens: number | null, lim: Limits): string {
  const ctx = tokens === null ? 'ctx ?' : `ctx ${Math.round((tokens / lim.window) * 100)}%`
  const point = s.point === null ? 'точки нет' : `точка ${clockTime(s.point.writtenAt)}`
  const wait = s.hold ? ' · жду /compact' : s.need !== null ? ' · компакт ждёт точку' : ''
  return `${ctx} · ${point}${wait}`
}

// --- paths ---------------------------------------------------------------------------------------------------------

export function normalize(p: string): string {
  const parts: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

export const absolute = (p: string, cwd: string, home: string): string => {
  if (p.startsWith('~/') && home !== '') return normalize(`${home}/${p.slice(2)}`)
  return normalize(p.startsWith('/') ? p : `${cwd}/${p}`)
}

export const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

// --- lost refs (port of compact-lost-refs.mjs) -----------------------------------------------------------------------

type ToolUseLike = { readonly tool: string; readonly input: { readonly [key: string]: unknown } }
export type MessageLike = { readonly role: string; readonly text: string; readonly toolUses: readonly ToolUseLike[] }

const MAX_FILES = 40
const MAX_URLS = 15
const EXT = [
  'tsx?', 'jsx?', 'mjs', 'cjs', 'json', 'jsonl', 'md', 'mdx', 'txt', 'csv', 'xml', 'html?', 'css', 'scss', 'sass', 'less',
  'vue', 'svelte', 'py', 'sh', 'bash', 'zsh', 'sql', 'ya?ml', 'toml', 'ini', 'conf', 'go', 'rs', 'java', 'kts?', 'php',
  'rb', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'lua', 'glsl', 'prisma', 'graphql', 'proto', 'tf', 'gradle', 'lock',
].join('|')
const PATH_RX = new RegExp(String.raw`(?:~\/|\/|\$\{?\w+\}?\/)?(?:[\w.-]+\/)+[\w.-]+\.(?:${EXT})\b`, 'g')
const URL_RX = /https?:\/\/[^\s)>\]"'`]+/g
const SHOW_CMD = /(^|&&|;|\|)\s*(sed|cat|head|tail|nl)\b/
const SUMMARY_HEAD = /^This session is being continued from a previous conversation/

/**
 * Files and links the compacted segment touched that neither the summary nor the point names, freshest first: after
 * a compaction the first turn tends to re-read what was already found, and the list is mechanical, so the mod builds it.
 * `before` is the transcript the compaction ran over, `known` the text of what it became plus the point.
 */
export function lostRefs(before: readonly MessageLike[], known: string, cwd: string, home: string): string | null {
  const files = new Map<string, { kind: 'read' | 'edit'; i: number }>()
  const urls = new Map<string, number>()
  const rel = (p: string): string => {
    const a = absolute(p, cwd, home)
    return a.startsWith(`${cwd}/`) ? a.slice(cwd.length + 1) : a
  }
  const add = (p: unknown, kind: 'read' | 'edit', i: number): void => {
    if (typeof p !== 'string' || p === '') return
    const a = absolute(p, cwd, home)
    if (/\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(p) || /^\/(private\/)?tmp\//.test(a)) return
    if (a.includes('/.claude/state/') || a.includes('/tool-results/')) return
    const k = rel(p)
    const old = files.get(k)
    files.set(k, { kind: old?.kind === 'edit' ? 'edit' : kind, i })
  }
  before.forEach((m, i) => {
    if (m.role === 'assistant') {
      for (const use of m.toolUses) {
        const inp = use.input
        if (use.tool === 'Read') add(inp['file_path'], 'read', i)
        else if (use.tool === 'Edit' || use.tool === 'Write' || use.tool === 'MultiEdit') add(inp['file_path'], 'edit', i)
        else if (use.tool === 'NotebookEdit') add(inp['notebook_path'], 'edit', i)
        else if (use.tool === 'Bash' && typeof inp['command'] === 'string' && SHOW_CMD.test(inp['command'])) {
          for (const match of inp['command'].match(PATH_RX) ?? []) add(match, 'read', i)
        }
      }
    }
    const text = m.role === 'user' && (m.text.startsWith('<') || SUMMARY_HEAD.test(m.text)) ? '' : m.text
    for (const match of text.matchAll(URL_RX)) urls.set(match[0].replace(/[.,;:]+$/, ''), i)
  })
  const inKnown = (k: string): boolean => known.includes(k) || known.includes(basename(k))
  const lostFiles = [...files].filter(([k]) => !inKnown(k)).sort((a, z) => z[1].i - a[1].i).slice(0, MAX_FILES)
  const lostUrls = [...urls].filter(([u]) => !known.includes(u)).sort((a, z) => z[1] - a[1]).slice(0, MAX_URLS)
  if (lostFiles.length === 0 && lostUrls.length === 0) return null
  const out = [
    '=== ОПОРЫ, КОТОРЫХ НЕТ В РЕЗЮМЕ (собрано из транскрипта до сжатия) ===',
    'Эти файлы и ссылки уже открывались в сжатой части, но ни резюме, ни точка останова их не называют.',
    'Нужен факт по теме — начинай отсюда, а не с нового поиска. Свежие сверху.',
  ]
  if (lostFiles.length > 0) out.push('', ...lostFiles.map(([k, v]) => `- ${v.kind === 'edit' ? 'правил' : 'читал'}: ${k}`))
  if (lostUrls.length > 0) out.push('', ...lostUrls.map(([u]) => `- ссылка: ${u}`))
  return out.join('\n')
}

// --- stand-down ----------------------------------------------------------------------------------------------------

const PROJECT_SHELL = /stop-point-(threshold|mark|request)\.sh|compact-gate\.sh|session-stop-point\.sh/
const GLOBAL_SHELL = /\/hooks\/stop-point\/(gate|mark|request|session|threshold)\.sh/

/**
 * While a shell copy of this machinery is still wired, the mod stays out of its way, so enabling it before the
 * settings entries go never fires everything twice. The global shell copy skips any project that ships its own
 * (`<root>/.claude/hooks/session-stop-point.sh`), so it counts only where that file is absent.
 */
export function standDownReason(projectHooks: string, userHooks: string, projectShipsOwn: boolean): string | null {
  if (PROJECT_SHELL.test(projectHooks)) return 'the project shell copy is still wired in its settings'
  if (GLOBAL_SHELL.test(userHooks) && !projectShipsOwn) return 'the global shell copy is still wired in ~/.claude/settings.json'
  return null
}
