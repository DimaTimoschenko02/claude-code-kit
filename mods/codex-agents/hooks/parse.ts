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
  /** Why the turn failed, in words. */
  error?: string
  action?: string
  /** The final answer's first line. */
  result?: string
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
  if (review !== null) return { id: `${review[1]} review`, kind: 'events' }
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

/** A final answer's first line; a bare heading (`1. Findings`, `## Summary`, `**Result**`, `Changes:`) takes the next line after it. */
export function answerLine(text: string | undefined): string | undefined {
  const raw = (text ?? '').split('\n').map(l => l.trim()).filter(l => l !== '')
  const flat = (l: string) => l.replace(/^[#>*\s-]+/, '').replace(/\*\*/g, '').trim()
  const first = raw[0]
  if (first === undefined) return undefined
  const isHeading = /^#{1,6}\s/.test(first) || /^\*\*[^*]+\*\*:?$/.test(first) || /^\d+[.)]\s+\S+(?:\s\S+)?:?$/.test(first) || (first.endsWith(':') && first.length < 40)
  return isHeading && raw[1] !== undefined ? `${flat(first).replace(/:$/, '')} — ${flat(raw[1])}` : flat(first)
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
        const code = str(err?.codex_error_info) ?? str(err?.message)
        const error = code === undefined ? undefined : errorText(code, str(err?.message))
        const last = answerLine(str(p.last_agent_message))
        facts.marker = { kind: 'complete', at, ...(error === undefined ? {} : { error }), ...(last === undefined ? {} : { last }) }
      } else if (kind === 'turn_aborted') {
        const reason = str(p.reason)
        facts.marker = { kind: 'aborted', at, ...(reason === undefined ? {} : { reason }) }
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
  if (code === 'usage_limit_exceeded') return 'usage limit reached'
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
    delete next.result
  } else if (m?.kind === 'complete') {
    next.phase = m.error === undefined ? 'done' : 'failed'
    next.endAt = m.at
    if (m.error !== undefined) next.error = oneLine(m.error, 80)
    if (m.last !== undefined) next.result = oneLine(m.last)
  } else if (m?.kind === 'aborted') {
    next.phase = 'failed'
    next.endAt = m.at
    next.error = oneLine(`aborted${m.reason === undefined ? '' : `: ${m.reason}`}`, 80)
  } else if (rec.phase === 'none' && !isWhole) {
    // A big file whose tail shows no turn boundary is mid-turn.
    next.phase = 'running'
  }
  if (facts.tokens !== undefined) next.tokens = facts.tokens
  if (facts.usage !== undefined) next.usage = facts.usage
  if (facts.action !== undefined) next.action = oneLine(facts.action)
  return next
}

export type ViewOptions = { windowMs: number; staleMs: number; lostMs: number }

/** A finished run leaves the pane once this many runs have started after it. */
export const KEEP_ROUNDS = 2

const TIME_ORDER = (a: Run, b: Run) => b.startAt - a.startAt

/**
 * The pane's data: every unfinished run, and a finished one only until KEEP_ROUNDS newer runs have started;
 * unfinished first, newest start first; the newest usage. An unfinished run silent past `lostMs` counts as failed.
 */
export function buildView(recs: Iterable<Rec>, tasks: ReadonlyMap<string, string>, now: number, opts: ViewOptions): View {
  const all: Run[] = []
  let usage: Usage | undefined
  for (const r of recs) {
    if (r.usage !== undefined && (usage === undefined || r.usage.at > usage.at)) usage = r.usage
    if (now - r.mtimeMs > opts.windowMs) continue
    const silentMs = Math.max(0, now - r.mtimeMs)
    const startAt = r.turnStart ?? r.startMs ?? r.mtimeMs
    let phase: RunPhase
    let reason = r.error
    if (r.phase === 'running') {
      if (silentMs > opts.lostMs) {
        phase = 'failed'
        reason = `no events for ${fmtDur(silentMs)}`
      } else phase = silentMs > opts.staleMs ? 'stale' : 'running'
    } else if (r.phase === 'none') {
      phase = silentMs > 120_000 ? 'failed' : 'starting'
      if (phase === 'failed') reason = 'never started'
    } else phase = r.phase
    const finished = phase === 'done' || phase === 'failed'
    const end = finished ? (r.endAt ?? r.mtimeMs) : now
    all.push({
      thread: r.thread,
      label: oneLine(tasks.get(r.thread) ?? r.prompt ?? r.thread.slice(0, 8), 90),
      cwd: (r.cwd ?? '').split('/').filter(Boolean).pop() ?? '',
      ...(r.origin !== undefined && r.origin !== 'codex_exec' ? { origin: r.origin } : {}),
      phase,
      startAt,
      elapsedMs: Math.max(0, end - startAt),
      silentMs,
      ...(finished ? { endAt: end } : {}),
      action: r.action ?? '',
      ...(finished && r.result !== undefined ? { result: r.result } : {}),
      ...(phase === 'failed' && reason !== undefined ? { reason } : {}),
      ...(r.tokens === undefined ? {} : { tokens: r.tokens }),
    })
  }
  const kept = all.filter(r => isLive(r.phase) || all.filter(o => o.startAt > r.startAt).length < KEEP_ROUNDS)
  const runs = [...kept.filter(r => isLive(r.phase)).sort(TIME_ORDER), ...kept.filter(r => !isLive(r.phase)).sort(TIME_ORDER)]
  return { at: now, runs, ...(usage === undefined ? {} : { usage }) }
}

export function isLive(phase: RunPhase): boolean {
  return phase === 'running' || phase === 'starting' || phase === 'stale'
}

export function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** `just now` under two seconds, else `12s ago`. */
export function ago(ms: number): string {
  return ms < 2_000 ? 'just now' : `${fmtDur(ms)} ago`
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

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function dayTime(ms: number, tzMin: number): string {
  const d = new Date(ms + tzMin * 60_000)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${DAYS[d.getUTCDay()]} ${two(d.getUTCDate())}.${two(d.getUTCMonth() + 1)} ${hhmm(ms, tzMin)}`
}

/** A clock time, with the day once it is more than 18 hours back. */
function when(ms: number, now: number, tzMin: number): string {
  return now - ms > 18 * 3_600_000 ? dayTime(ms, tzMin) : hhmm(ms, tzMin)
}

function windowName(minutes: number): string {
  if (minutes === 10_080) return 'week'
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`
  return `${minutes}m`
}

/** `Limits as of 13:57 · prolite · week 7% used, resets Sat 31.10 14:43`, a reached limit right after the time. */
export function usageText(u: Usage | undefined, now: number, tzMin: number): string {
  if (u === undefined) return 'Limits: no data yet'
  const parts = [`Limits as of ${when(u.at, now, tzMin)}`]
  if (u.reached !== undefined) parts.push(`LIMIT REACHED: ${u.reached}`)
  if (u.plan !== undefined) parts.push(u.plan)
  for (const w of u.windows) {
    parts.push(`${windowName(w.minutes)} ${Math.round(w.pct)}% used${w.resetsAt === undefined ? '' : `, resets ${dayTime(w.resetsAt, tzMin)}`}`)
  }
  return parts.join(' · ')
}

export const STATUS_WORD: Record<RunPhase, string> = {
  running: '● RUNNING',
  starting: '○ STARTING',
  stale: '◌ SILENT',
  done: '✓ DONE',
  failed: '✖ FAILED',
}

/** The theme colour of each status; the block's border takes it too, a finished run's border is dim. */
export const STATUS_COLOR: Record<RunPhase, 'success' | 'suggestion' | 'warning' | 'error'> = {
  running: 'success',
  starting: 'suggestion',
  stale: 'warning',
  done: 'success',
  failed: 'error',
}

/** One run as the pane and the text answer draw it: a header, labelled lines, a meta line. */
export type Block = { status: string; title: string; time: string; lines: { label: string; text: string }[]; meta: string }

export function blockOf(r: Run, now: number, tzMin: number): Block {
  const live = isLive(r.phase)
  const status =
    r.phase === 'stale' ? `${STATUS_WORD.stale} ${fmtDur(r.silentMs)}` : r.reason !== undefined ? `${STATUS_WORD[r.phase]} (${r.reason})` : STATUS_WORD[r.phase]
  const lines: Block['lines'] = []
  if (live) lines.push({ label: 'doing', text: r.action !== '' ? r.action : r.phase === 'starting' ? 'starting up' : 'thinking (no command or message yet in what was read)' })
  else if (r.result !== undefined) lines.push({ label: 'result', text: r.result })
  else if (r.action !== '') lines.push({ label: 'last', text: r.action })
  const meta: string[] = []
  if (r.cwd !== '') meta.push(`repo ${r.cwd}`)
  if (r.origin !== undefined) meta.push(`via ${r.origin}`)
  if (r.tokens !== undefined) meta.push(`${fmtTokens(r.tokens)} tokens`)
  meta.push(`started ${when(r.startAt, now, tzMin)}`)
  meta.push(r.endAt !== undefined ? `finished ${when(r.endAt, now, tzMin)}` : `last event ${ago(r.silentMs)}`)
  return { status, title: r.label, time: `${live ? 'for' : 'took'} ${fmtDur(r.elapsedMs)}`, lines, meta: meta.join(' · ') }
}

/** `Codex · 1 running · 1 silent · 2 finished`, or `Codex · nothing running`. */
export function headline(view: View): string {
  const n = (phase: RunPhase) => view.runs.filter(r => r.phase === phase).length
  const working = n('running') + n('starting')
  const parts = [working > 0 ? `${working} running` : '', n('stale') > 0 ? `${n('stale')} silent` : '']
  const finished = view.runs.filter(r => !isLive(r.phase)).length
  if (working + n('stale') === 0) parts.push('nothing running')
  if (finished > 0) parts.push(`${finished} finished`)
  return ['Codex', ...parts.filter(Boolean)].join(' · ')
}

/** `Updated 14:19:36 (12s ago)`, and how often the pane rescans when `rates` are given. */
export function freshness(view: View, now: number, tzMin: number, rates?: { liveMs: number; idleMs: number }): string {
  const base = `Updated ${hhmm(view.at, tzMin, true)} (${ago(Math.max(0, now - view.at))})`
  if (rates === undefined) return base
  const isWorking = view.runs.some(r => isLive(r.phase))
  return `${base} · ${isWorking ? `refreshes every ${fmtDur(rates.liveMs)} while a run is live` : `idle, refreshes every ${fmtDur(rates.idleMs)}`}`
}

/** The line under the header when no run is unfinished. */
export function emptyText(view: View, windowMs: number): string | undefined {
  if (view.error !== undefined || view.runs.some(r => isLive(r.phase))) return undefined
  return view.runs.length === 0 ? `No Codex run is working, and none ran in the last ${Math.round(windowMs / 3_600_000)}h.` : 'No Codex run is working right now.'
}

/** Plain text for a surface with no pane (`claude -p`): the same blocks as data lines. */
export function summary(view: View, tzMin: number, windowMs: number): string {
  const out = [headline(view), freshness(view, view.at, tzMin), usageText(view.usage, view.at, tzMin)]
  if (view.error !== undefined) out.push(view.error)
  const empty = emptyText(view, windowMs)
  if (empty !== undefined) out.push(empty)
  for (const r of view.runs) {
    const b = blockOf(r, view.at, tzMin)
    out.push(`── ${b.status} · ${b.title} · ${b.time}`, ...b.lines.map(l => `   ${l.label}: ${l.text}`), `   ${b.meta}`)
  }
  return out.join('\n')
}
