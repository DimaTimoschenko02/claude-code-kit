// stop-point: the stop point ↔ compaction machinery as in-process hooks. It asks the agent for a stop point (a file
// with what the compaction summary loses) when the context nears the compaction window and when the owner writes
// «точка останова»; once the owner's point is written it holds the turn to reads until he compacts; it defers an
// auto-compaction until a fresh point exists (never wedging); after a compaction it puts the point and the files the
// summary dropped back into context. Everything per session lives in $.state, so a hot reload keeps it.

import type { EngineInterface, Register, Settings, SettingsSource } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { StopPointSession } from '../types'
import {
  HOLD_REASON,
  INITIAL,
  PHRASE,
  READ_ONLY,
  WHY_GATE,
  WHY_OWNER_STOP,
  WHY_THRESHOLD,
  absolute,
  afterCompactText,
  afterCompaction,
  basename,
  gateDecision,
  isFresh,
  isOwnerPrompt,
  limits,
  lostRefs,
  midTurn,
  normalize,
  ownerRequest,
  requestText,
  resumeText,
  standDownReason,
  statusText,
  templateBody,
} from './logic'
import type { GateDecision, Limits } from './logic'

const SESSION = atom({ plugin: 'stop-point', key: 'session' } as const, INITIAL)

/** Tools whose call with the point's path writes the point. */
const WRITES = new Set(['Write', 'Edit', 'MultiEdit'])

const HOLD_NOTICE =
  'Точка останова записана по просьбе владельца. Заверши ход отбивкой 💾 — дальше он делает /compact; до этого ' +
  'открыты только Read, Grep, Glob и правка самого файла точки.'

type Config = {
  /** Why the mod sits this session out (a shell copy is still wired); null when active. */
  standDown: string | null
  sid: string
  root: string
  cwd: string
  home: string
  /** Where the point of this session is written, as the request names it. */
  pointPath: string
  /** The same file with every symbolic link of its folder followed; null while the folder does not exist. */
  pointReal: string | null
  template: string
  templateBody: string
  autoCompactWindow: number | null
  triggerOverride: number | null
  growthOverride: number | null
  logPath: string
  pointsDir: string
}

let cached: Promise<Config> | null = null
let shownStatus: string | undefined

/** The session's paths and settings, read once per session (and again after a reload, /clear or resume). */
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
  const [root, cwd, sid, homeEnv, tokensEnv, growthEnv] = await Promise.all([
    $.session.root(),
    $.session.cwd(),
    $.session.id(),
    $.env.get('HOME'),
    $.env.get('STOP_POINT_TOKENS'),
    $.env.get('STOP_POINT_GROWTH'),
  ])
  const home = homeEnv ?? ''
  const projectTemplate = `${root}/.claude/hooks/_lib/stop-point-template.md`
  const resumeDir = `${root}/.claude/state/resume`
  const [hasProjectTemplate, hasResumeDir, ownShell] = await Promise.all([
    $.fs.exists(projectTemplate),
    $.fs.exists(resumeDir),
    $.fs.exists(`${root}/.claude/hooks/session-stop-point.sh`),
  ])
  const pointsDir = hasProjectTemplate || hasResumeDir ? resumeDir : `${home}/.claude/state/stop-point/points`
  const template = hasProjectTemplate ? projectTemplate : `${$.plugin.root}/template.md`
  const settings = (source?: SettingsSource): Promise<Settings> =>
    $.settings.read(source === undefined ? {} : { source }).catch((): Settings => ({}))
  const [templateText, merged, project, local, user, dir] = await Promise.all([
    $.fs.read(template).catch(() => ''),
    settings(),
    settings('project'),
    settings('local'),
    settings('user'),
    $.fs.stat(pointsDir, { resolve: true }).catch(() => null),
  ])
  const hooks = (s: Settings): string => JSON.stringify(s['hooks'] ?? {})
  const window = merged['autoCompactWindow']
  return {
    standDown: standDownReason(`${hooks(project)}\n${hooks(local)}`, hooks(user), ownShell),
    sid,
    root,
    cwd,
    home,
    pointPath: `${pointsDir}/${sid}.md`,
    pointReal: dir?.realPath === undefined ? null : `${dir.realPath}/${sid}.md`,
    template,
    templateBody: templateBody(templateText),
    autoCompactWindow: typeof window === 'number' ? window : null,
    triggerOverride: toNumber(tokensEnv),
    growthOverride: toNumber(growthEnv),
    logPath: `${home}/.claude/state/stop-point/gate.log`,
    pointsDir,
  }
}

const toNumber = (v: string | undefined): number | null => {
  const n = Number(v)
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : null
}

/** The live context size (input + cache read + cache write of the last response) and the thresholds over it. */
async function measure($: EngineInterface, c: Config): Promise<{ tokens: number | null; lim: Limits }> {
  const usage = await $.session.usage().catch(() => null)
  const lim = limits({
    autoCompactWindow: c.autoCompactWindow,
    modelWindow: usage?.context.window ?? null,
    triggerOverride: c.triggerOverride,
    growthOverride: c.growthOverride,
  })
  return { tokens: usage?.context.tokens ?? null, lim }
}

/** The gate waits and the agent has not been reminded within the last 20k tokens of growth. */
const nagDue = (s: StopPointSession, tokens: number | null, lim: Limits): boolean =>
  tokens !== null && !s.hold && s.need !== null && !isFresh(s, tokens, lim) && (s.naggedAt === null || tokens >= s.naggedAt + 20_000)

/** The context crossed the threshold (again, past the growth step) with no point and no owner request pending. */
const thresholdDue = (s: StopPointSession, tokens: number | null, lim: Limits): boolean =>
  tokens !== null && !s.hold && s.need === null && s.request !== 'owner' && !isFresh(s, tokens, lim) &&
  tokens >= lim.trigger && (s.askedAt === null || tokens >= s.askedAt + lim.growth)

/** Anything a main tool call's result has to carry or record. */
const due = (s: StopPointSession, tokens: number | null, lim: Limits): boolean =>
  s.pending.length > 0 || s.pointDue || nagDue(s, tokens, lim) || thresholdDue(s, tokens, lim)

const field = (e: object, key: string): unknown => (e as Readonly<Record<string, unknown>>)[key]

/** The path names this session's point: its own spelling, its folder's real one, or wherever it resolves. */
async function isPoint($: EngineInterface, c: Config, p: unknown): Promise<boolean> {
  if (typeof p !== 'string' || basename(p) !== `${c.sid}.md`) return false
  const a = absolute(p, c.cwd, c.home)
  if (a === normalize(c.pointPath) || (c.pointReal !== null && a === normalize(c.pointReal))) return true
  const st = await $.fs.stat(a, { resolve: true }).catch(() => null)
  return st?.realPath !== undefined && st.realPath === c.pointReal
}

/** The point file of this session when it is there and not empty. */
async function pointFile($: EngineInterface, c: Config): Promise<{ text: string; mtimeMs: number } | null> {
  const st = await $.fs.stat(c.pointPath).catch(() => null)
  if (st === null || st.kind !== 'file' || st.size === 0) return null
  const text = await $.fs.read(c.pointPath).catch(() => '')
  return text.trim() === '' ? null : { text, mtimeMs: st.mtimeMs }
}

function showStatus($: EngineInterface, s: StopPointSession, tokens: number | null, lim: Limits): void {
  const text = statusText(s, tokens, lim)
  if (text === shownStatus) return
  shownStatus = text
  $.ui.status(text)
}

async function appendLog($: EngineInterface, c: Config, now: number, tokens: number | null, decision: GateDecision) {
  const line = `${new Date(now).toISOString()} auto ${tokens ?? '-'} ${c.sid.slice(0, 8)} ${decision}`
  try {
    const old = await $.fs.read(c.logPath).catch(() => '')
    const lines = old === '' ? [] : old.replace(/\n$/, '').split('\n')
    lines.push(line)
    await $.fs.write(c.logPath, `${lines.slice(-1000).join('\n')}\n`)
  } catch {
    // the log is for people reading it later; the gate never depends on it
  }
}

export const register: Register = on => {
  // --- lifecycle -----------------------------------------------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    cached = null
    shownStatus = undefined
    const r = await next(e)
    try {
      const c = await config($)
      if (c.standDown !== null) {
        $.ui.log(`stop-point stands down: ${c.standDown}`, { to: 'debug' })
        return r
      }
      await $.process
        .run(['find', c.pointsDir, '-name', '*.md', '-type', 'f', '-mtime', '+7', '-delete'], { timeoutMs: 5000 })
        .catch(() => null)
      const [s, m] = await Promise.all([read($, SESSION), measure($, c)])
      showStatus($, s, m.tokens, m.lim)
    } catch {
      // nothing to set up is worth failing a session start
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    cached = null
    await update($, SESSION, () => INITIAL).catch(() => null)
    if (shownStatus !== undefined) $.ui.status(undefined)
    shownStatus = undefined
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    try {
      const c = await config($)
      if (c.standDown !== null) return r
      const s = await read($, SESSION)
      const lim = limits({
        autoCompactWindow: c.autoCompactWindow,
        modelWindow: e.context.window,
        triggerOverride: c.triggerOverride,
        growthOverride: c.growthOverride,
      })
      showStatus($, s, e.context.tokens ?? null, lim)
    } catch {
      // the status line is decoration
    }
    return r
  })

  // --- the agent's tool calls: the hold, the point's write, mid-turn requests ------------------------------------------

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const c = await config($)
    if (c.standDown !== null) return next(e)
    const tool: string = e.tool
    const writesPoint = WRITES.has(tool) && (await isPoint($, c, field(e, 'file_path')))
    const s = await read($, SESSION)
    if (s.hold && !READ_ONLY.has(tool) && !writesPoint) return { deny: HOLD_REASON }

    const r = await next(e)
    if (r.deny !== undefined) return r
    const { tokens, lim } = await measure($, c)
    const written = writesPoint && r.isError === undefined
    if (!written && !due(s, tokens, lim)) {
      showStatus($, s, tokens, lim)
      return r
    }
    const now = await $.clock.now()
    const out = { blocks: [] as string[], due: false, held: false }
    const after = await update($, SESSION, v => {
      out.blocks = [...v.pending]
      out.due = v.pointDue
      out.held = false
      let n: StopPointSession = { ...v, pending: [], pointDue: false }
      if (written) {
        out.held = v.request === 'owner'
        n = {
          ...n,
          point: { path: c.pointPath, writtenAt: now, tokens },
          need: null,
          naggedAt: null,
          stopNagged: false,
          hold: v.hold || v.request === 'owner',
          request: 'none',
        }
        return n
      }
      if (nagDue(n, tokens, lim)) {
        out.blocks.push(midTurn(requestText(c.pointPath, WHY_GATE, c.template, c.templateBody)))
        return { ...n, naggedAt: tokens }
      }
      if (thresholdDue(n, tokens, lim)) {
        out.blocks.push(midTurn(requestText(c.pointPath, WHY_THRESHOLD, c.template, c.templateBody)))
        return { ...n, askedAt: tokens }
      }
      return n
    })
    if (out.held) out.blocks.push(HOLD_NOTICE)
    if (out.due) {
      const file = await pointFile($, c)
      if (file !== null) out.blocks.unshift(afterCompactText(c.pointPath, file.text, file.mtimeMs, now))
    }
    showStatus($, after, tokens, lim)
    if (out.blocks.length === 0) return r
    return { ...r, context: [...(r.context ?? []), ...out.blocks] }
  })

  on('agent.spawn', async ($, e, next) => {
    if (e.parentAgentId !== undefined) return next(e)
    const c = await config($)
    if (c.standDown !== null) return next(e)
    const s = await read($, SESSION)
    return s.hold ? { deny: HOLD_REASON } : next(e)
  })

  // --- the owner's prompt: «точка останова», lifting the hold, deliveries ------------------------------------------------

  on('prompt.submit', async ($, e, next) => {
    const c = await config($)
    if (c.standDown !== null) return next(e)
    const owner = isOwnerPrompt(e.origin.kind, e.text)
    const phrase = owner && PHRASE.test(e.text)
    const idle = e.turnId === undefined
    const { tokens, lim } = await measure($, c)
    const out = { blocks: [] as string[], due: false }
    const after = await update($, SESSION, v => {
      out.blocks = [...v.pending]
      out.due = v.pointDue
      let n: StopPointSession = { ...v, pending: [], pointDue: false }
      if (owner) n = { ...n, hold: false }
      if (phrase) n = { ...n, request: 'owner', stopNagged: false }
      else if (owner && idle) n = { ...n, request: 'none' }
      if (!phrase && nagDue(n, tokens, lim)) {
        out.blocks.push(midTurn(requestText(c.pointPath, WHY_GATE, c.template, c.templateBody)))
        n = { ...n, naggedAt: tokens }
      }
      return n
    })
    if (out.due) {
      const file = await pointFile($, c)
      if (file !== null) out.blocks.unshift(afterCompactText(c.pointPath, file.text, file.mtimeMs, await $.clock.now()))
    }
    if (phrase) out.blocks.push(ownerRequest(c.pointPath, c.template, c.templateBody))
    showStatus($, after, tokens, lim)
    if (out.blocks.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...out.blocks] })
  })

  // --- turn end: a request the turn did not deliver, an API error while the gate waits -----------------------------------

  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    if (e.agent_id !== undefined || e.stop_hook_active || r.block !== undefined) return r
    const c = await config($)
    if (c.standDown !== null) return r
    const { tokens, lim } = await measure($, c)
    const out = { reason: null as string | null }
    const after = await update($, SESSION, v => {
      out.reason = null
      if (v.hold) return v
      const fresh = isFresh(v, tokens, lim)
      if (v.request === 'owner' && !v.stopNagged) {
        out.reason = requestText(c.pointPath, WHY_OWNER_STOP, c.template)
        return { ...v, stopNagged: true }
      }
      if (v.need !== null && !fresh && !v.stopNagged) {
        out.reason = requestText(c.pointPath, WHY_GATE, c.template)
        return { ...v, stopNagged: true }
      }
      if (thresholdDue(v, tokens, lim)) {
        out.reason = requestText(c.pointPath, WHY_THRESHOLD, c.template)
        return { ...v, askedAt: tokens }
      }
      return v
    })
    showStatus($, after, tokens, lim)
    if (out.reason === null) return r
    $.ui.toast(`Точка останова: контекст ${tokens === null ? '?' : Math.round(tokens / 1000)}k, пишу состояние сессии.`)
    return { ...r, block: out.reason }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || e.reason !== 'error') return r
    await update($, SESSION, v => (v.need === null ? v : { ...v, escape: true })).catch(() => null)
    return r
  })

  // --- compaction: the gate, then the new cycle ------------------------------------------------------------------------

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const c = await config($)
    if (c.standDown !== null) return next(e)

    if (e.trigger === 'auto') {
      const { tokens, lim } = await measure($, c)
      const s = await read($, SESSION)
      const onDisk = s.point !== null && (await pointFile($, c)) !== null
      const out = { decision: 'pass-no-usage' as GateDecision }
      const after = await update($, SESSION, v => {
        const d = gateDecision(v, tokens, lim, onDisk)
        out.decision = d
        if (d === 'pass-error') return { ...v, escape: false }
        if (d === 'pass-fresh') return { ...v, need: null }
        if (d === 'defer') return { ...v, need: tokens, naggedAt: null, stopNagged: false }
        return v
      })
      const d = out.decision
      if (d !== 'defer-retry') await appendLog($, c, await $.clock.now(), tokens, d)
      if (d === 'defer' || d === 'defer-retry') {
        const k = tokens === null ? '?' : `${Math.round(tokens / 1000)}k`
        if (d === 'defer') $.ui.toast(`Авто-компакт отложен до записи точки останова (контекст ${k})`)
        showStatus($, after, tokens, lim)
        return { skip: `авто-компакт отложен до записи точки останова (контекст ${k})` }
      }
    }

    await update($, SESSION, v => ({ ...v, compactSeq: v.compactSeq + 1 }))
    const r = await next(e)
    if (r.skip !== undefined) return r
    try {
      const file = await pointFile($, c)
      const known = `${r.messages.map(m => m.text).join('\n')}\n${file?.text ?? ''}`
      const refs = lostRefs(e.messages, known, c.root, c.home)
      const after = await update($, SESSION, v => ({
        ...afterCompaction(v),
        pending: refs === null ? v.pending : [...v.pending, refs],
        pointDue: v.injectedSeq !== v.compactSeq,
      }))
      const { tokens, lim } = await measure($, c)
      showStatus($, after, tokens, lim)
    } catch {
      // the compaction stands whatever the bookkeeping after it does
    }
    return r
  })

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.agent_id !== undefined) return r
    if (e.source !== 'compact') cached = null
    const c = await config($)
    if (c.standDown !== null) return r
    const file = await pointFile($, c)
    const now = await $.clock.now()
    const blocks: string[] = []
    if (e.source === 'compact') {
      const out = { pending: [] as string[] }
      await update($, SESSION, v => {
        out.pending = v.pending
        return { ...v, pending: [], pointDue: false, injectedSeq: v.compactSeq }
      })
      if (file !== null) blocks.push(afterCompactText(c.pointPath, file.text, file.mtimeMs, now))
      blocks.push(...out.pending)
    } else if (file !== null) {
      blocks.push(resumeText(c.pointPath, file.text, file.mtimeMs, now, await gitDelta($, c.root, file.mtimeMs)))
    }
    if (blocks.length === 0) return r
    return { ...r, additionalContext: [...(r.additionalContext ?? []), ...blocks] }
  })
}

/** What changed in the repository since the point was written: branch, uncommitted files, commits after it. */
async function gitDelta($: EngineInterface, root: string, since: number): Promise<string> {
  const script =
    'git -C "$1" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0; ' +
    'b=$(git -C "$1" rev-parse --abbrev-ref HEAD 2>/dev/null); ' +
    'd=$(git -C "$1" status --porcelain 2>/dev/null | wc -l | tr -d " "); ' +
    'n=$(git -C "$1" log --since="@$2" --oneline 2>/dev/null | wc -l | tr -d " "); ' +
    'echo "ветка: $b; незакоммиченных файлов: $d; коммитов после записи: $n"'
  const run = await $.process
    .run(['sh', '-c', script, 'sh', root, String(Math.floor(since / 1000))], { timeoutMs: 5000 })
    .catch(() => null)
  return run === null || run.exitCode !== 0 ? '' : run.stdout.trim()
}
