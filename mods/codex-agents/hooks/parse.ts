// Pure parsing of Codex rollout files (~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl) and the
// pane's text; register.tsx does the reading.
import type { Run, RunPhase, Usage, UsageWindow, View } from '../types'

export type Phase = 'running' | 'done' | 'failed' | 'none'

/** What the mod knows of one rollout file, kept between scans. */
export type Rec = {
  path: string
  thread: string
  size: number
  mtimeMs: number
  /** session_meta's timestamp; the file's mtime until the head is read. */
  startMs?: number
  cwd?: string
  origin?: string
  prompt?: string
  isHeadRead: boolean
  phase: Phase
  turnStart?: number
  endAt?: number
  error?: string
  action?: string
  tokens?: number
  usage?: Usage
}

/** What one read of a file's tail says; absent fields were not in it. */
export type TailFacts = {
  marker?: { kind: 'start'; at: number } | { kind: 'complete'; at: number; error?: string; last?: string } | { kind: 'aborted'; at: number; reason?: string }
  tokens?: number
  usage?: Usage
  action?: string
}

const THREAD = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

/** The thread id a rollout file's name ends with; null for any other file. */
export function threadOf(name: string): string | null {
  return THREAD.exec(name)?.[1] ?? null
}

/** Splits `tail -c`/`head -c` output over several files at their `==> path <==` headers (one file prints none). */
export function splitHeaders(stdout: string, paths: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (paths.length === 1) {
    out.set(paths[0]!, stdout)
    return out
  }
  const known = new Set(paths)
  let current: string | null = null
  let buf: string[] = []
  const flush = () => {
    if (current !== null) out.set(current, buf.join('\n').replace(/\n$/, ''))
  }
  for (const line of stdout.split('\n')) {
    const m = /^==> (.+) <==$/.exec(line)
    if (m !== null && known.has(m[1]!)) {
      flush()
      current = m[1]!
      buf = []
      continue
    }
    buf.push(line)
  }
  flush()
  return out
}

/** Splits `grep -H -o` output into each file's matches, in order. */
export function splitGrep(stdout: string, paths: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const sorted = [...paths].sort((a, b) => b.length - a.length)
  for (const line of stdout.split('\n')) {
    const path = sorted.find(p => line.startsWith(`${p}:`))
    if (path === undefined) continue
    const list = out.get(path) ?? []
    list.push(line.slice(path.length + 1))
    out.set(path, list)
  }
  return out
}

/** session_meta's start, cwd and originator from the head grep's matches. */
export function headFacts(matches: readonly string[]): { startMs?: number; cwd?: string; origin?: string } {
  const out: { startMs?: number; cwd?: string; origin?: string } = {}
  for (const m of matches) {
    const kv = /^\{?"(timestamp|cwd|originator)":"([^"]*)"$/.exec(m)
    if (kv === null) continue
    if (kv[1] === 'timestamp' && out.startMs === undefined) {
      const t = Date.parse(kv[2]!)
      if (!Number.isNaN(t)) out.startMs = t
    } else if (kv[1] === 'cwd' && out.cwd === undefined) out.cwd = oneLine(kv[2]!, 200)
    else if (kv[1] === 'originator' && out.origin === undefined) out.origin = oneLine(kv[2]!, 40)
  }
  return out
}

/** The prompt's first line from the UserMessage grep match (the match stops at the first escape or quote). */
export function promptOf(match: string | undefined): string | undefined {
  if (match === undefined) return undefined
  const i = match.lastIndexOf('"text":"')
  if (i < 0) return undefined
  const line = match.slice(i + 8).replace(/^[#>*\s-]+/, '').trim()
  return line === '' ? undefined : oneLine(line, 90)
}

/** The thread id a wrapper's event log names on its first line (`thread.started`). */
export function threadInHead(text: string): string | null {
  return /"thread_id":"([0-9a-f-]{36})"/.exec(text)?.[1] ?? null
}

/** A wrapper file's task id: `codex-<id>.session`, `codex-<id>.jsonl`, `codex-<id>.resume-N.jsonl`, `codex-<id>-review.jsonl`. */
export function taskFile(name: string): { id: string; kind: 'session' | 'events' } | null {
  const review = /^codex-(.+)-review\.jsonl$/.exec(name)
  if (review !== null) return { id: `${review[1]} ревью`, kind: 'events' }
  const resume = /^codex-(.+?)\.resume-\d+\.jsonl$/.exec(name)
  if (resume !== null) return { id: resume[1]!, kind: 'events' }
  const events = /^codex-(.+)\.jsonl$/.exec(name)
  if (events !== null) return { id: events[1]!, kind: 'events' }
  const session = /^codex-(.+)\.session$/.exec(name)
  if (session !== null) return { id: session[1]!, kind: 'session' }
  return null
}

/** Hides what may be a secret in a command or message line: env assignments, URL credentials, tokens. */
export function mask(s: string): string {
  return s
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1…@')
    .replace(/\b([A-Z][A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, '$1=…')
    .replace(/\b([a-z_]*(?:token|secret|passw(?:or)?d|pass|api_?key|auth)[a-z_]*)=("[^"]*"|'[^']*'|\S+)/gi, '$1=…')
    .replace(/(--?(?:token|secret|password|passwd|api-key|apikey|auth)[= ])\S+/gi, '$1…')
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 …')
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abpr]|glpat|AKIA)[-_A-Za-z0-9]{12,}/g, '…')
    .replace(/\b(?=[A-Za-z0-9_+-]*\d)(?=[A-Za-z0-9_+-]*[A-Za-z])[A-Za-z0-9_+-]{32,}={0,2}/g, '…')
}

/** Replaces C0/C1 control characters (ESC, CSI, BEL, …) so model or command text cannot drive the terminal. */
export function clean(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
}

/** One masked line of at most `max` characters. */
export function oneLine(s: string, max = 140): string {
  const flat = mask(clean(s.slice(0, 600)).replace(/\s+/g, ' ').trim())
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The shell command(s) a code-mode `exec` call runs: `tools.exec_command({cmd:"…"})`. */
export function cmdOfJs(input: string): string | undefined {
  const re = /\bcmd\s*:\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/g
  const cmds: string[] = []
  for (const m of input.slice(0, 20_000).matchAll(re)) {
    const lit = m[1]!
    let text = lit.slice(1, -1)
    if (lit.startsWith('"')) {
      try {
        text = JSON.parse(lit) as string
      } catch {}
    }
    cmds.push(text)
  }
  if (cmds.length === 0) return undefined
  return cmds.length === 1 ? cmds[0] : `${cmds[0]} (+${cmds.length - 1})`
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

const LINE_KINDS = [
  '"type":"task_started"',
  '"type":"task_complete"',
  '"type":"turn_aborted"',
  '"type":"token_count"',
  '"type":"item_completed"',
  '"type":"custom_tool_call"',
  '"type":"function_call"',
  '"type":"agent_message"',
  '"type":"exec_command_begin"',
  '"type":"exec_command_end"',
]

function commandText(command: unknown): string | undefined {
  if (typeof command === 'string') return command
  if (Array.isArray(command) && command.length > 0) {
    const last = command[command.length - 1]
    return typeof last === 'string' ? last : undefined
  }
  return undefined
}

function firstLine(text: string | undefined): string | undefined {
  const line = text?.split('\n').map(l => l.trim()).find(l => l !== '')
  return line === undefined ? undefined : line
}

function usageOf(rl: Obj | undefined, at: number): Usage | undefined {
  if (rl === undefined) return undefined
  const windows: UsageWindow[] = []
  for (const key of ['primary', 'secondary']) {
    const w = obj(rl[key])
    const pct = num(w?.used_percent)
    if (w === undefined || pct === undefined) continue
    const resetsAt = num(w.resets_at)
    windows.push({ minutes: num(w.window_minutes) ?? 0, pct, ...(resetsAt === undefined ? {} : { resetsAt: resetsAt * 1000 }) })
  }
  if (windows.length === 0) return undefined
  const planRaw = str(rl.plan_type)
  const reachedRaw = str(rl.rate_limit_reached_type)
  const plan = planRaw === undefined ? undefined : oneLine(planRaw, 40)
  const reached = reachedRaw === undefined ? undefined : oneLine(reachedRaw, 60)
  return { windows, at, ...(plan === undefined ? {} : { plan }), ...(reached === undefined ? {} : { reached }) }
}

/** The action an item describes, as a line with its glyph; undefined for items that are not one. */
function itemAction(item: Obj): string | undefined {
  const type = str(item.type)
  if (type === 'CommandExecution' || type === 'command_execution') {
    const cmd = commandText(item.command)
    return cmd === undefined ? undefined : `$ ${cmd}`
  }
  if (type === 'AgentMessage' || type === 'agent_message') {
    const parts = Array.isArray(item.content) ? item.content.map(c => str(obj(c)?.text) ?? '').join('') : str(item.text)
    const line = firstLine(parts)
    return line === undefined ? undefined : `💬 ${line}`
  }
  if (type === 'FileChange' || type === 'file_change') {
    const changes = obj(item.changes)
    const names = changes === undefined ? [] : Object.keys(changes).map(p => p.split('/').pop() ?? p)
    return names.length === 0 ? undefined : `✎ ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` (+${names.length - 4})` : ''}`
  }
  return undefined
}

/** Reads a tail of a rollout file; `isWhole` when it holds the file from its first byte (no partial first line). */
export function parseTail(text: string, isWhole: boolean): TailFacts {
  const facts: TailFacts = {}
  const lines = text.split('\n')
  if (!isWhole) lines.shift()
  for (const line of lines) {
    if (!line.startsWith('{') || !LINE_KINDS.some(k => line.includes(k))) continue
    let o: Obj
    try {
      o = JSON.parse(line) as Obj
    } catch {
      continue
    }
    const at = Date.parse(str(o.timestamp) ?? '') || 0
    const p = obj(o.payload)
    if (p === undefined) continue
    const kind = str(p.type)
    if (o.type === 'event_msg') {
      if (kind === 'task_started') facts.marker = { kind: 'start', at: (num(p.started_at) ?? 0) * 1000 || at }
      else if (kind === 'task_complete') {
        const err = obj(p.error)
        const error = str(err?.codex_error_info) ?? str(err?.message)
        const last = firstLine(str(p.last_agent_message))
        facts.marker = { kind: 'complete', at, ...(error === undefined ? {} : { error }), ...(last === undefined ? {} : { last }) }
        if (error !== undefined) facts.action = `✖ ${errorText(error, str(err?.message))}`
        else if (last !== undefined) facts.action = `💬 ${last}`
      } else if (kind === 'turn_aborted') {
        const reason = str(p.reason)
        facts.marker = { kind: 'aborted', at, ...(reason === undefined ? {} : { reason }) }
        facts.action = `✖ прерван${reason === undefined ? '' : `: ${reason}`}`
      } else if (kind === 'token_count') {
        const total = num(obj(obj(p.info)?.total_token_usage)?.total_tokens)
        if (total !== undefined) facts.tokens = total
        const usage = usageOf(obj(p.rate_limits), at)
        if (usage !== undefined) facts.usage = usage
      } else if (kind === 'item_completed') {
        const item = obj(p.item)
        const action = item === undefined ? undefined : itemAction(item)
        if (action !== undefined) facts.action = action
      } else if (kind === 'agent_message') {
        const line = firstLine(str(p.message))
        if (line !== undefined) facts.action = `💬 ${line}`
      } else if (kind === 'exec_command_begin' || kind === 'exec_command_end') {
        const cmd = commandText(p.command)
        if (cmd !== undefined) facts.action = `$ ${cmd}`
      }
    } else if (o.type === 'response_item') {
      if (kind === 'custom_tool_call') {
        const cmd = cmdOfJs(str(p.input) ?? '')
        if (cmd !== undefined) facts.action = `$ ${cmd}`
        else if (str(p.name) !== undefined) facts.action = `⚙ ${str(p.name)}`
      } else if (kind === 'function_call') {
        let args: Obj | undefined
        try {
          args = obj(JSON.parse(str(p.arguments) ?? '{}'))
        } catch {}
        const cmd = commandText(args?.cmd) ?? commandText(args?.command)
        if (cmd !== undefined) facts.action = `$ ${cmd}`
        else if (str(p.name) !== undefined) facts.action = `⚙ ${str(p.name)}`
      }
    }
  }
  return facts
}

function errorText(code: string, message: string | undefined): string {
  if (code === 'usage_limit_exceeded') return 'лимит плана исчерпан'
  return firstLine(message) ?? code
}

/** A rec after one tail read: the newest marker decides the phase; what the tail lacks stays as it was. */
export function merge(rec: Rec, facts: TailFacts, isWhole: boolean): Rec {
  const next: Rec = { ...rec }
  const m = facts.marker
  if (m?.kind === 'start') {
    next.phase = 'running'
    next.turnStart = m.at
    delete next.endAt
    delete next.error
  } else if (m?.kind === 'complete') {
    next.phase = m.error === undefined ? 'done' : 'failed'
    next.endAt = m.at
    if (m.error !== undefined) next.error = m.error
  } else if (m?.kind === 'aborted') {
    next.phase = 'failed'
    next.endAt = m.at
    next.error = m.reason ?? 'aborted'
  } else if (rec.phase === 'none' && !isWhole) {
    // A big file whose tail shows no turn boundary is mid-turn.
    next.phase = 'running'
  }
  if (facts.tokens !== undefined) next.tokens = facts.tokens
  if (facts.usage !== undefined) next.usage = facts.usage
  if (facts.action !== undefined) next.action = oneLine(facts.action)
  return next
}

export type ViewOptions = { windowMs: number; staleMs: number }

const ORDER: Record<RunPhase, number> = { running: 0, starting: 0, stale: 1, done: 2, failed: 2 }

/** The pane's data: runs touched within the window, unfinished first, then newest first; the newest usage. */
export function buildView(recs: Iterable<Rec>, tasks: ReadonlyMap<string, string>, now: number, opts: ViewOptions): View {
  const runs: (Run & { touched: number })[] = []
  let usage: Usage | undefined
  for (const r of recs) {
    if (r.usage !== undefined && (usage === undefined || r.usage.at > usage.at)) usage = r.usage
    if (now - r.mtimeMs > opts.windowMs) continue
    const silentMs = Math.max(0, now - r.mtimeMs)
    const start = r.turnStart ?? r.startMs ?? r.mtimeMs
    let phase: RunPhase
    let action = r.action ?? ''
    if (r.phase === 'running') phase = silentMs > opts.staleMs ? 'stale' : 'running'
    else if (r.phase === 'none') {
      phase = silentMs > 120_000 ? 'failed' : 'starting'
      if (phase === 'failed' && action === '') action = '✖ не стартовал'
    } else phase = r.phase
    const finished = phase === 'done' || phase === 'failed'
    const end = finished ? (r.endAt ?? r.mtimeMs) : now
    runs.push({
      thread: r.thread,
      label: oneLine(tasks.get(r.thread) ?? r.prompt ?? r.thread.slice(0, 8), 90),
      cwd: (r.cwd ?? '').split('/').filter(Boolean).pop() ?? '',
      ...(r.origin !== undefined && r.origin !== 'codex_exec' ? { origin: r.origin } : {}),
      phase,
      elapsedMs: Math.max(0, end - start),
      silentMs,
      ...(finished ? { endAt: end } : {}),
      action,
      ...(r.tokens === undefined ? {} : { tokens: r.tokens }),
      touched: r.mtimeMs,
    })
  }
  runs.sort((a, b) => ORDER[a.phase] - ORDER[b.phase] || b.touched - a.touched)
  return { at: now, runs: runs.map(({ touched: _t, ...run }) => run), ...(usage === undefined ? {} : { usage }) }
}

export function isLive(phase: RunPhase): boolean {
  return phase === 'running' || phase === 'starting' || phase === 'stale'
}

export function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}с`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}м`
  return `${Math.floor(m / 60)}ч ${String(m % 60).padStart(2, '0')}м`
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function parseTzOffset(text: string): number | null {
  const m = /([+-])(\d{2})(\d{2})/.exec(text)
  if (m === null) return null
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

export function hhmm(ms: number, tzMin: number, withSeconds = false): string {
  const d = new Date(ms + tzMin * 60_000)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}${withSeconds ? `:${two(d.getUTCSeconds())}` : ''}`
}

const DAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']

function dayTime(ms: number, tzMin: number): string {
  const d = new Date(ms + tzMin * 60_000)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${DAYS[d.getUTCDay()]} ${two(d.getUTCDate())}.${two(d.getUTCMonth() + 1)} ${hhmm(ms, tzMin)}`
}

function windowName(minutes: number): string {
  if (minutes === 10_080) return 'неделя'
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}д`
  if (minutes >= 60) return `${Math.round(minutes / 60)}ч`
  return `${minutes}м`
}

/** `prolite · неделя 12% · сброс пт 31.10 23:43`, the reached limit first when there is one. */
export function usageText(u: Usage | undefined, tzMin: number): string {
  if (u === undefined) return 'план: нет данных'
  const parts: string[] = []
  if (u.reached !== undefined) parts.push(`🔴 лимит: ${u.reached}`)
  if (u.plan !== undefined) parts.push(u.plan)
  for (const w of u.windows) {
    parts.push(`${windowName(w.minutes)} ${Math.round(w.pct)}%${w.resetsAt === undefined ? '' : ` · сброс ${dayTime(w.resetsAt, tzMin)}`}`)
  }
  return parts.join(' · ')
}

export const PHASE_WORD: Record<RunPhase, string> = {
  running: '● работает',
  starting: '○ запуск',
  stale: '◌ молчит',
  done: '✓ готово',
  failed: '✖ ошибка',
}

/** The run's meta after its label: time, tokens, and when it ended or how long it has been silent. */
export function metaText(r: Run, tzMin: number): string {
  const parts = [fmtDur(r.elapsedMs)]
  if (r.tokens !== undefined) parts.push(`${fmtTokens(r.tokens)} ток.`)
  if (r.phase === 'stale') parts.push(`тихо ${fmtDur(r.silentMs)}`)
  if (r.endAt !== undefined) parts.push(`в ${hhmm(r.endAt, tzMin)}`)
  return parts.join(' · ')
}

/** Plain text for a surface with no pane (`claude -p`): the runs as data lines. */
export function summary(view: View, tzMin: number): string {
  const head = `Codex · ${usageText(view.usage, tzMin)}`
  if (view.error !== undefined) return `${head}\n${view.error}`
  if (view.runs.length === 0) return `${head}\nЗа последние часы запусков Codex нет.`
  const rows = view.runs.slice(0, 12).map(r => {
    const where = [r.cwd, r.origin].filter(Boolean).join(' · ')
    return `${PHASE_WORD[r.phase]} ${r.label}${where === '' ? '' : ` · ${where}`} · ${metaText(r, tzMin)}${r.action === '' ? '' : `\n    ${r.action}`}`
  })
  return [head, ...rows].join('\n')
}
