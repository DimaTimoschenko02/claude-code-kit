// Pure parts of agent-routes: the routes file, the prompt section, agent definitions and the Agent-call checks.
// No `$` here, so the tests cover it without an engine world.

/** One row of the project's routing table. */
export type Route = {
  work: string
  default: string
  fallback?: string
  agent?: string
  sol?: boolean
  marker?: string
}

export type Routes = { routes: Route[]; notes: string[] }

/** A typed agent as its file declares it; `model` is the frontmatter family, null when it inherits. */
export type AgentDef = { name: string; description: string; model: Family | null }

export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable'
const RANK: Record<Family, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }

/** The routes file is the project's own text resent every turn: each cell and the lists stay bounded. */
const CELL_MAX = 300
const ROUTES_MAX = 40
const NOTES_MAX = 20
/** Each agent's line in a deny is cut to this many characters; at most AGENTS_MAX agents are listed. */
export const LINE_MAX = 120
export const AGENTS_MAX = 15

/** Built-in types that run on the parent's model unless the call names one. */
const BUILTIN = new Set(['general-purpose', 'explore', 'claude', ''])
/** Built-in types that do anything: a call naming one of these went past the typed agents. */
const CATCH_ALL = new Set(['general-purpose', 'claude', ''])

const ESCALATE = /\bescalate:/i

export const GENERAL_RULES = [
  '- Модель Claude-агента — из его frontmatter, в вызове не пиши; поднять — `escalate: <почему>` в description.',
  '- Встроенные (`general-purpose`, `Explore`, `claude`) — с `model: "sonnet"` в вызове, Opus — с `escalate:`; есть типизированный агент под задачу — зови его.',
  '- Codex — всегда `-s danger-full-access`.',
]

/** One line, bounded: newlines and runs of spaces folded, a table pipe escaped. */
function cell(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  const cut = one.length > CELL_MAX ? `${one.slice(0, CELL_MAX - 1)}…` : one
  return cut.replace(/\|/g, '\\|')
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const isOptText = (v: unknown): boolean => v === undefined || isText(v)

/** Parses `.claude/agent-routes.json`. Any shape error makes the whole file invalid: the error says where. */
export function parseRoutes(text: string): Routes | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''))
  } catch (err) {
    return { error: `not JSON: ${String(err).slice(0, 120)}` }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'top level is not an object' }
  const obj = raw as Record<string, unknown>
  const list = obj.routes ?? []
  if (!Array.isArray(list)) return { error: '`routes` is not an array' }
  const routes: Route[] = []
  for (const [i, r] of list.entries()) {
    if (typeof r !== 'object' || r === null) return { error: `routes[${i}] is not an object` }
    const o = r as Record<string, unknown>
    if (!isText(o.work) || !isText(o.default)) return { error: `routes[${i}] needs \`work\` and \`default\`` }
    if (!isOptText(o.fallback) || !isOptText(o.agent) || !isOptText(o.marker)) {
      return { error: `routes[${i}]: \`fallback\`, \`agent\`, \`marker\` must be text` }
    }
    if (o.sol !== undefined && typeof o.sol !== 'boolean') return { error: `routes[${i}].sol is not a boolean` }
    if (o.sol === true && o.agent === undefined) return { error: `routes[${i}]: \`sol\` needs \`agent\`` }
    routes.push({
      work: o.work,
      default: o.default,
      ...(o.fallback === undefined ? {} : { fallback: o.fallback as string }),
      ...(o.agent === undefined ? {} : { agent: (o.agent as string).trim() }),
      ...(o.sol === undefined ? {} : { sol: o.sol }),
      ...(o.marker === undefined ? {} : { marker: o.marker as string }),
    })
  }
  const notes = obj.notes ?? []
  if (!Array.isArray(notes) || !notes.every(isText)) return { error: '`notes` is not a list of text' }
  return { routes: routes.slice(0, ROUTES_MAX), notes: (notes as string[]).slice(0, NOTES_MAX) }
}

/** The system-prompt section: the general rules always, the project's table and notes when its file is valid. */
export function promptSection(routes: Routes | null): string {
  const out = ['# Агенты и Codex (мод agent-routes)', '', ...GENERAL_RULES]
  if (routes !== null && (routes.routes.length > 0 || routes.notes.length > 0)) {
    out.push('', 'Маршруты этого проекта (`.claude/agent-routes.json`):')
    if (routes.routes.length > 0) {
      out.push('', '| Работа | По умолчанию | Не вышло |', '| --- | --- | --- |')
      for (const r of routes.routes) out.push(`| ${cell(r.work)} | ${cell(r.default)} | ${r.fallback ? cell(r.fallback) : '—'} |`)
    }
    if (routes.notes.length > 0) out.push('', ...routes.notes.map(n => `- ${cell(n).replace(/\\\|/g, '|')}`))
  }
  return out.join('\n')
}

/** The model family a model id or alias names (`claude-opus-5-5` → opus), null for anything else. */
export function family(model: unknown): Family | null {
  const m = String(model ?? '').toLowerCase()
  return (Object.keys(RANK) as Family[]).find(f => m.includes(f)) ?? null
}

/** Flattens to one line and drops the quotes YAML may wrap a scalar in. */
function flat(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  const quoted = /^(["'])(.*)\1$/.exec(one)
  return (quoted ? quoted[2]! : one).replace(/\\"/g, '"').trim()
}

/**
 * Reads `name`, `description` and `model` from an agent file's frontmatter (plain, quoted or block scalars). Null
 * when the file has no frontmatter. The model is read too, for the model check.
 */
export function parseAgent(text: string, fallbackName: string): AgentDef | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^﻿/, ''))
  if (!m) return null
  const lines = m[1]!.split(/\r?\n/)
  const read = (key: string): string | undefined => {
    const i = lines.findIndex(l => l.startsWith(`${key}:`))
    if (i < 0) return undefined
    const head = lines[i]!.slice(key.length + 1).trim()
    if (head !== '' && !/^[>|][+-]?$/.test(head)) return flat(head)
    const body: string[] = []
    for (const l of lines.slice(i + 1)) {
      if (!/^\s/.test(l) && l.trim() !== '') break
      body.push(l)
    }
    return flat(body.join(' '))
  }
  const name = read('name') || fallbackName
  return { name, description: read('description') ?? '', model: family(read('model')) }
}

/** The first sentence, cut at a word to LINE_MAX characters with an ellipsis. */
export function shortLine(description: string): string {
  const end = /[.!?](?=\s+[A-ZА-ЯЁЄІЇ«"`(]|\s*$)/.exec(description)
  const first = end ? description.slice(0, end.index + 1) : description
  if (first.length <= LINE_MAX) return first
  const cut = first.slice(0, LINE_MAX - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > LINE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:—-]+$/, '')}…`
}

/** Nearest definitions first: a later one of the same name is shadowed, as the engine resolves it. */
export function mergeAgents(...lists: AgentDef[][]): AgentDef[] {
  const seen = new Set<string>()
  const out: AgentDef[] = []
  for (const a of lists.flat()) {
    if (seen.has(a.name)) continue
    seen.add(a.name)
    out.push(a)
  }
  return out
}

const typeOf = (t: string | undefined) => (t ?? '').trim()
export const isCatchAll = (t: string | undefined) => CATCH_ALL.has(typeOf(t).toLowerCase())
export const isBuiltin = (t: string | undefined) => BUILTIN.has(typeOf(t).toLowerCase())
/** Plugin agents (`plugin:agent`) and odd names are not ours to judge. */
const isForeign = (t: string | undefined) => /[:/\\]/.test(typeOf(t))
export const hasEscalate = (description: string | undefined) => ESCALATE.test(description ?? '')

/** The part of an Agent call the checks read. */
export type AgentCall = { subagent_type?: string; description?: string; prompt?: string; model?: string }

export type Check = 'sol-route' | 'catch-all' | 'model-typed' | 'model-builtin'

export type Decision =
  | { kind: 'pass' }
  | { kind: 'deny'; check: Check; reason: string }

const SOURCE = 'agent-routes (a mod the owner installed)'

function solReason(r: Route): string {
  const claude = r.marker
    ? `тот же вызов с \`escalate: <почему>\` в description или ${r.marker} в промпте`
    : 'тот же вызов с `escalate: <почему>` в description'
  return [
    `${SOURCE}: \`${r.agent}\` для работы «${cell(r.work)}» по умолчанию идёт не так — ${cell(r.default)}.`,
    r.fallback ? `Не вышло — ${cell(r.fallback)}.` : '',
    `Claude вместо этого — ${claude}.`,
  ]
    .filter(s => s !== '')
    .join(' ')
}

function catchAllReason(type: string, agents: AgentDef[]): string {
  const shown = agents.slice(0, AGENTS_MAX)
  return [
    `${SOURCE}: \`${type || 'general-purpose'}\` — последний вариант. Под задачу может подойти типизированный агент:`,
    ...shown.map(a => `- ${a.name} — ${a.description ? shortLine(a.description) : '(без описания)'}`),
    ...(agents.length > shown.length ? [`- …и ещё ${agents.length - shown.length}`] : []),
    'Ни один не подходит — повтори тот же вызов (тот же description), второй раз пропущу.',
  ].join('\n')
}

/**
 * The checks on one Agent call, in order: Sol route, catch-all, model. `claim(key)` answers true the first time a
 * catch-all call (type + description) is seen in the session; it is asked only when a deny would follow.
 */
export function decideAgent(call: AgentCall, routes: Routes | null, agents: AgentDef[], claim: (key: string) => boolean): Decision {
  if (hasEscalate(call.description)) return { kind: 'pass' }
  const type = typeOf(call.subagent_type)

  const sol = routes?.routes.find(r => r.sol === true && r.agent === type && type !== '')
  if (sol && !(sol.marker && (call.prompt ?? '').includes(sol.marker))) {
    return { kind: 'deny', check: 'sol-route', reason: solReason(sol) }
  }

  const want = family(call.model)
  // A built-in above Sonnet is named in the catch-all denial too, so the retry it asks for is the one that runs.
  const builtinHigh = isBuiltin(type) && (want === null || RANK[want] > RANK.sonnet)

  if (isCatchAll(type) && agents.length > 0 && claim(`${type}\u0000${call.description ?? ''}`)) {
    const reason = catchAllReason(type, agents)
    return { kind: 'deny', check: 'catch-all', reason: builtinHigh ? `${reason} Повторяя, укажи \`model: "sonnet"\`.` : reason }
  }

  if (isBuiltin(type)) {
    if (!builtinHigh) return { kind: 'pass' }
    const was = want === null ? 'модель не указана, унаследовал бы родительскую' : `указан ${call.model}`
    return {
      kind: 'deny',
      check: 'model-builtin',
      reason: `${SOURCE}: \`${type || 'general-purpose'}\` — ${was}. Встроенные идут на Sonnet: повтори тот же вызов с \`model: "sonnet"\`; нужен Opus — с \`escalate: <почему>\` в description.`,
    }
  }
  if (want === null || isForeign(type)) return { kind: 'pass' }
  const own = agents.find(a => a.name === type)?.model ?? null
  if (own === null || RANK[want] <= RANK[own]) return { kind: 'pass' }
  return {
    kind: 'deny',
    check: 'model-typed',
    reason: `${SOURCE}: \`${type}\` идёт на модели из своего frontmatter \`${own}\`, вызов может её только понизить. Повтори тот же вызов без \`model\`; нужна \`${call.model}\` — с \`escalate: <почему>\` в description.`,
  }
}

/** One decision as a journal line. */
export function journalLine(entry: {
  ts: string
  session: string
  cwd: string
  check: string
  subagent_type: string | null
  action: string
  description: string
}): string {
  const description = entry.description.replace(/\s+/g, ' ').trim().slice(0, 80)
  return `${JSON.stringify({ ...entry, description })}\n`
}

/** The journal with one line added, its oldest lines dropped past `cap` bytes so it never nears the 4 MiB read limit. */
export function appendBounded(old: string, line: string, cap = 2 * 1024 * 1024): string {
  const text = old + line
  if (text.length <= cap) return text
  const tail = text.slice(text.length - Math.floor(cap / 2))
  return tail.slice(tail.indexOf('\n') + 1)
}

/** Decisions per check since `sinceMs`, from the journal's text; a line that does not parse is skipped. */
export function countByCheck(text: string, sinceMs: number): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const e = JSON.parse(line) as { ts?: string; check?: string; action?: string }
      const at = Date.parse(e.ts ?? '')
      if (!Number.isFinite(at) || at < sinceMs || !e.check) continue
      const key = `${e.check} (${e.action ?? '?'})`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    } catch {
      // a torn line from a concurrent writer
    }
  }
  return counts
}

/** Every directory from `dir` up to the root, nearest first. Copied from run-loop-hint's classify.ts. */
export function ancestors(dir: string): string[] {
  const path = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  const out: string[] = []
  let d = path === '' ? '/' : path
  for (let guard = 0; guard < 64; guard += 1) {
    out.push(d)
    const cut = d.lastIndexOf('/')
    if (cut < 0) break
    const parent = cut === 0 ? '/' : d.slice(0, cut)
    const next = /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent
    if (next === d || d === '/' || /^[A-Za-z]:\/$/.test(d)) break
    d = next
  }
  return out
}

/** `dir` + `.claude/<rest>`, slashed, no double slash at a drive root. */
export const under = (dir: string, rest: string) => `${dir.replace(/\/+$/, '')}/.claude/${rest}`
