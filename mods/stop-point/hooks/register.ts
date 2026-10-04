// stop-point: keeps the session's stop point (a file with what a compaction summary loses: anchors, numbers,
// verdicts) fresh by itself. After every main-thread reply a background Sonnet completion rewrites the file from the
// previous point and the transcript since its last write; the owner never asks and the main model never writes it.
// One write at a time: a reply during a write queues exactly one more. A compaction makes the point current first
// (its own write over what is still unwritten, bounded), then puts the point and the files the summary dropped back
// into context. The status line says when the point was last made current, that it is being written, or why not.
//
// Why a completion, not a subagent: a plugin-spawned subagent's hand-back arrives on the main thread as a prompt and
// starts a turn (measured 2026-10-04: origin `peer`, then a main reply about it) — on every reply, a loop.

import type { EngineInterface, Register, SessionMessage, Settings, SettingsSource } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { StopPointSession } from '../types'
import {
  COMPACT_WAIT_MS,
  SIZE_SOFT,
  INITIAL,
  MAX_REPLY_TOKENS,
  WRITER_MODEL,
  WRITER_SYSTEM,
  WRITE_TIMEOUT_MS,
  afterCompactText,
  claimForCompaction,
  claimOnReply,
  clockTime,
  cursorAt,
  deltaFrom,
  failureReason,
  lostRefs,
  lostAnchors,
  noTranscriptError,
  norm,
  parseReply,
  reaskIssues,
  reaskPrompt,
  restoreAnchors,
  utf8Bytes,
  releaseRun,
  renderDelta,
  resumeText,
  standDownReason,
  statusText,
  templateBody,
  writerPrompt,
} from './logic'

const SESSION = atom({ plugin: 'stop-point', key: 'session' } as const, INITIAL)

const COMMAND = 'stop-point'

/** A point's file name: the session id, a UUID. Pruning touches nothing else in the folder. */
const POINT_NAME = '????????-????-????-????-????????????.md'

type Config = {
  /** Why the mod sits this session out (a shell copy is still wired); null when active. */
  standDown: string | null
  sid: string
  root: string
  home: string
  /** Where the point of this session lives. */
  pointPath: string
  templatePath: string
  templateBody: string
  logPath: string
  /** The points folder with every symbolic link followed; null while it does not exist. Pruned by its real path. */
  pointsReal: string | null
}

let cached: Promise<Config> | null = null
let shownStatus: string | undefined
/** A compaction's own write is running (the background slot is in the state; this one is the hook's). */
let compacting = false
/** File writes of this module instance, in order; a write of an older generation never lands over a newer one. */
let fileChain: Promise<unknown> = Promise.resolve()
let writtenGen = 0

/** The session's paths and settings, read once per session (and again after a reload or /clear). */
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
  const [root, sid, homeEnv] = await Promise.all([$.session.root(), $.session.id(), $.env.get('HOME')])
  const home = homeEnv ?? ''
  const resumeDir = `${root}/.claude/state/resume`
  const [rootStat, resumeStat, ownShell] = await Promise.all([
    $.fs.stat(root, { resolve: true }).catch(() => null),
    $.fs.stat(resumeDir, { resolve: true }).catch(() => null),
    $.fs.exists(`${root}/.claude/hooks/session-stop-point.sh`),
  ])
  // A repo keeps its points in its own .claude/state/resume only where that folder really lies inside the repo: the
  // folder is pruned with find -delete, and a repo cloned from anywhere could link it to any folder of the owner's.
  // The template is always the mod's own — a repo's text in the writer's prompt would be a prompt from a stranger.
  const isInsideRoot =
    resumeStat?.kind === 'dir' &&
    resumeStat.realPath !== undefined &&
    rootStat?.realPath !== undefined &&
    resumeStat.realPath.startsWith(`${rootStat.realPath}/`)
  const pointsDir = isInsideRoot ? resumeDir : `${home}/.claude/state/stop-point/points`
  const templatePath = `${$.plugin.root}/template.md`
  const settings = (source: SettingsSource): Promise<Settings> => $.settings.read({ source }).catch((): Settings => ({}))
  const [templateText, project, local, user, dir] = await Promise.all([
    $.fs.read(templatePath).catch(() => ''),
    settings('project'),
    settings('local'),
    settings('user'),
    $.fs.stat(pointsDir, { resolve: true }).catch(() => null),
  ])
  const hooks = (s: Settings): string => JSON.stringify(s['hooks'] ?? {})
  return {
    standDown: standDownReason(`${hooks(project)}\n${hooks(local)}`, hooks(user), ownShell),
    sid,
    root,
    home,
    pointPath: `${pointsDir}/${sid}.md`,
    templatePath,
    templateBody: templateBody(templateText),
    logPath: `${home}/.claude/state/stop-point/writes.log`,
    pointsReal: dir?.kind === 'dir' && dir.realPath !== undefined ? dir.realPath : null,
  }
}

const readState = async ($: EngineInterface): Promise<StopPointSession> => norm(await read($, SESSION))

/** Every state change goes through `update`, which retries on conflict: decide inside `fn`, never on a stale read. */
const change = ($: EngineInterface, fn: (v: StopPointSession) => StopPointSession): Promise<StopPointSession> =>
  update($, SESSION, v => fn(norm(v)))

/** `force`: after a reload the line on screen may be the old instance's, whatever this one last set. */
function showStatus($: EngineInterface, s: StopPointSession, force = false): void {
  const text = compacting ? '🟡 точка пишется…' : statusText(s)
  if (text === shownStatus && !force) return
  shownStatus = text
  $.ui.status(text)
}

/** The point file of this session when it is there and not empty. */
async function pointFile($: EngineInterface, c: Config): Promise<{ text: string; mtimeMs: number } | null> {
  const st = await $.fs.stat(c.pointPath).catch(() => null)
  if (st === null || st.kind !== 'file' || st.size === 0) return null
  const text = await $.fs.read(c.pointPath).catch(() => '')
  return text.trim() === '' ? null : { text, mtimeMs: st.mtimeMs }
}

/** Temp file + rename, in this instance's order; an older generation that comes late is dropped. */
function writeFileAtomic($: EngineInterface, path: string, text: string, gen: number): Promise<void> {
  const run = fileChain.then(async () => {
    if (gen < writtenGen) return
    const tmp = `${path}.tmp-${gen}`
    await $.fs.write(tmp, text)
    const mv = await $.process.run(['mv', '-f', tmp, path], { timeoutMs: 5000 })
    if (mv.exitCode !== 0) throw new Error(`mv exit ${mv.exitCode}`)
    writtenGen = gen
  })
  fileChain = run.catch(() => undefined)
  return run
}

type Outcome = {
  kind: 'written' | 'unchanged' | 'empty' | 'discarded' | 'error'
  reason?: string
  ms: number
  count: number
  chars: number
  usage?: Usage
  /** The writer was asked once more: anchors it dropped, or a file over the size bound. */
  reask?: boolean
  /** Anchors put back mechanically after the second answer still lacked them. */
  restored?: number
  /** The written file's size in UTF-8 bytes. */
  bytes?: number
}

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

const addUsage = (a: Usage, b: Usage): Usage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
})

/** A re-ask needs at least this much of the run's time left; with less, dropped anchors are restored mechanically. */
const REASK_MIN_MS = 15_000

/**
 * One write: the delta since the cursor, the writer's completion, then — if no newer generation landed meanwhile —
 * the cursor moves, the file is replaced, and the run's cost is kept. A failure leaves the cursor, so the next run
 * covers this delta too.
 */
async function writeOnce(
  $: EngineInterface,
  c: Config,
  gen: number,
  messages: readonly SessionMessage[],
  timeoutMs: number,
): Promise<Outcome> {
  const t0 = await $.clock.now()
  const s = await readState($)
  const delta = deltaFrom(messages, s.cursor)
  const cursor = cursorAt(messages)
  const rendered = renderDelta(delta)
  const base = { count: delta.length, chars: rendered.text.length }
  const fail = async (reason: string, ms: number): Promise<Outcome> => {
    await change($, v => (gen < v.appliedGen ? v : { ...v, error: reason }))
    return { kind: 'error', reason, ms, ...base }
  }

  if (rendered.text.trim() === '') {
    // nothing a writer could use (no messages, or only empty ones): the point already covers it
    await change($, v => (gen <= v.appliedGen || cursor === null ? v : { ...v, appliedGen: gen, cursor }))
    return { kind: 'empty', ms: 0, ...base }
  }

  const previous = await pointFile($, c)
  const prompt = writerPrompt({
    templatePath: c.templatePath,
    templateBody: c.templateBody,
    pointPath: c.pointPath,
    previous,
    delta: rendered.text,
    count: rendered.count,
    root: c.root,
    now: t0,
  })
  const ask = (text: string, ms: number) =>
    $.model.complete({
      model: WRITER_MODEL,
      system: WRITER_SYSTEM,
      prompt: text,
      maxTokens: MAX_REPLY_TOKENS,
      effort: 'medium',
      timeoutMs: ms,
    })
  const r = await ask(prompt, timeoutMs)
  let usage: Usage = r.usage
  let now = await $.clock.now()
  if (!r.isAnswered) return { ...(await fail(failureReason(r), now - t0)), usage }
  let reply = parseReply(r.text)
  if (reply.kind === 'empty') return { ...(await fail('пустой ответ', now - t0)), usage }

  // Checks in code, not in the prompt alone: the previous point's anchors survive unless the delta closed them, and
  // the file stays near the template's 3 KB. One re-ask for both; what is still dropped is put back mechanically.
  // The file is never cut: an oversize second answer is written as it is and logged.
  const extra = { reask: false, restored: 0 }
  if (reply.kind === 'written') {
    const prevText = previous?.text ?? ''
    const issues = reaskIssues(lostAnchors(prevText, reply.body, rendered.text), utf8Bytes(reply.body))
    const left = timeoutMs - (now - t0)
    if (issues.length > 0 && left >= REASK_MIN_MS) {
      extra.reask = true
      const r2 = await ask(reaskPrompt(prompt, reply.body, issues), left)
      usage = addUsage(usage, r2.usage)
      now = await $.clock.now()
      const second = r2.isAnswered ? parseReply(r2.text) : null
      if (second !== null && second.kind === 'written') reply = second
    }
    const still = lostAnchors(prevText, reply.body, rendered.text)
    if (still.length > 0) {
      reply = { kind: 'written', body: restoreAnchors(reply.body, prevText, still) }
      extra.restored = still.length
    }
  }
  const ms = now - t0
  const bytes = reply.kind === 'written' ? utf8Bytes(reply.body) : undefined
  if ((await $.session.id()) !== c.sid) return { kind: 'discarded', ms, ...base, usage }

  const last = {
    kind: reply.kind,
    at: now,
    ms,
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  }
  const out = { applied: false }
  await change($, v => {
    out.applied = gen > v.appliedGen
    if (!out.applied) return v
    return { ...v, appliedGen: gen, cursor, last, error: null }
  })
  if (!out.applied) return { kind: 'discarded', ms, ...base, usage }
  if (reply.kind === 'written') {
    try {
      await writeFileAtomic($, c.pointPath, reply.body, gen)
    } catch (err) {
      return { ...(await fail(`запись файла: ${String(err).slice(0, 60)}`, ms)), usage }
    }
  }
  return { kind: reply.kind, ms, ...base, usage, ...extra, bytes }
}

/** One line per run in the debug log and in writes.log (bounded), so the cost per reply can be measured later. */
async function logRun($: EngineInterface, c: Config, where: 'reply' | 'compact', o: Outcome): Promise<void> {
  const u = o.usage
  const cost = u === undefined
    ? ''
    : ` in=${u.input_tokens} out=${u.output_tokens} cache_read=${u.cache_read_input_tokens} cache_write=${u.cache_creation_input_tokens}`
  const what = o.kind === 'error' ? `error(${o.reason ?? '?'})` : o.kind
  const checks =
    (o.bytes === undefined ? '' : ` bytes=${o.bytes}${o.bytes > SIZE_SOFT ? ' oversize' : ''}`) +
    (o.reask === true ? ' reask' : '') +
    (o.restored !== undefined && o.restored > 0 ? ` restored=${o.restored}` : '')
  const line = `${where} ${what} ${(o.ms / 1000).toFixed(1)}s msgs=${o.count} chars=${o.chars}${checks}${cost}`
  $.ui.log(`stop-point: ${line}`, { to: 'debug' })
  try {
    const stamp = new Date(await $.clock.now()).toISOString()
    const old = await $.fs.read(c.logPath).catch(() => '')
    const lines = old === '' ? [] : old.replace(/\n$/, '').split('\n')
    lines.push(`${stamp} ${c.sid.slice(0, 8)} ${line}`)
    await $.fs.write(c.logPath, `${lines.slice(-2000).join('\n')}\n`)
  } catch {
    // the log is for measuring later; the point never depends on it
  }
}

/** The background slot: write, then once more for every reply that came meanwhile (never two at once). */
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
        // An SDK or headless host keeps no transcript for plugins: nothing to write from, ever, in this session.
        // Not a failure — no log line, no error, no status.
        await change($, v => ({ ...v, noTranscript: true, writing: null, dirty: false, error: null })).catch(() => null)
        shownStatus = undefined
        $.ui.status(undefined)
        return
      }
      outcome = await writeOnce($, c, current, messages, WRITE_TIMEOUT_MS)
    } catch (err) {
      const reason = `сбой: ${String(err).slice(0, 60)}`
      await change($, v => ({ ...v, error: reason })).catch(() => null)
      outcome = { kind: 'error', reason, ms: 0, count: 0, chars: 0 }
    }
    if (c !== null) await logRun($, c, 'reply', outcome)
    const now = await $.clock.now()
    const out = { gen: null as number | null }
    const after = await change($, v => {
      const r = releaseRun(v, current, now)
      out.gen = r.gen
      return r.state
    }).catch(() => null)
    if (after === null) return
    showStatus($, after)
    gen = out.gen
  }
}

/** The blocks the next tool result or prompt carries: the point after a compaction, the files the summary lost. */
async function takeDeliveries($: EngineInterface, c: Config): Promise<string[]> {
  const out = { blocks: [] as string[], due: false }
  await change($, v => {
    out.blocks = [...v.pending]
    out.due = v.pointDue
    return { ...v, pending: [], pointDue: false }
  })
  if (out.due) {
    const file = await pointFile($, c)
    if (file !== null) out.blocks.unshift(afterCompactText(c.pointPath, file.text, file.mtimeMs, await $.clock.now()))
  }
  return out.blocks
}

async function commandText($: EngineInterface): Promise<string> {
  const c = await config($)
  if (c.standDown !== null) return `Точка останова: мод в этой сессии не работает — ${c.standDown}.`
  const [s, file, now] = await Promise.all([readState($), pointFile($, c), $.clock.now()])
  const lines = [`Точка останова этой сессии: ${c.pointPath}`]
  if (file === null) lines.push('Файла ещё нет: первая запись — после первого ответа.')
  else {
    const age = Math.max(0, Math.round((now - file.mtimeMs) / 60_000))
    lines.push(`Файл записан в ${clockTime(file.mtimeMs)} (${age} мин назад); обновляется в фоне после каждого ответа (Sonnet).`)
  }
  if (s.noTranscript) lines.push('Хост этой сессии (SDK, без терминала) не даёт плагинам транскрипт — точка здесь не ведётся.')
  if (s.writing !== null || compacting) lines.push('Сейчас пишется.')
  if (s.error !== null) lines.push(`Последний запуск не удался: ${s.error}.`)
  if (s.last !== null) {
    const l = s.last
    const what = l.kind === 'written' ? 'переписал' : 'без изменений'
    lines.push(
      `Последний удачный запуск в ${clockTime(l.at)}: ${what}, ${(l.ms / 1000).toFixed(0)} с, вход ${l.input} ` +
        `(из кэша ${l.cacheRead}, в кэш ${l.cacheWrite}), выход ${l.output} токенов.`,
    )
  }
  return lines.join('\n')
}

export const register: Register = on => {
  // --- lifecycle -----------------------------------------------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    cached = null
    shownStatus = undefined
    compacting = false
    const r = await next(e)
    try {
      const c = await config($)
      if (c.standDown !== null) {
        $.ui.log(`stop-point stands down: ${c.standDown}`, { to: 'debug' })
        return r
      }
      await $.command
        .register({
          name: COMMAND,
          description: 'Точка останова: где лежит файл, когда записан, сколько стоила последняя запись',
          immediate: true,
        })
        .catch(err => $.ui.log(`stop-point: /${COMMAND} not registered: ${String(err)}`, { to: 'debug' }))
      if (c.pointsReal !== null)
        await $.process
          .run(['find', c.pointsReal, '-maxdepth', '1', '-type', 'f', '-name', POINT_NAME, '-mtime', '+7', '-delete'], {
            timeoutMs: 5000,
          })
          .catch(() => null)
      // A run claimed by the instance before a reload died with it; the next reply's write covers its delta.
      const s = await change($, v => (v.writing === null ? v : { ...v, writing: null, dirty: false }))
      showStatus($, s, true)
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

  on('command.run', { command: 'stop-point' }, async ($, e, next) => {
    try {
      return { text: await commandText($) }
    } catch (err) {
      return { text: `Точка останова: не прочитал состояние — ${String(err).slice(0, 120)}` }
    }
  })

  // --- every main reply: the background write ------------------------------------------------------------------------

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    try {
      const c = await config($)
      if (c.standDown !== null) return r
      const now = await $.clock.now()
      const out = { gen: null as number | null }
      const after = await change($, v => {
        const claim = claimOnReply(v, now)
        out.gen = claim.gen
        return claim.state
      })
      showStatus($, after)
      const gen = out.gen
      // A timer, not this dispatch: the write outlives the turn's hooks and never holds the next prompt.
      if (gen !== null) $.clock.after(0, () => void backgroundLoop($, gen))
    } catch (err) {
      $.ui.log(`stop-point: no write after the reply: ${String(err)}`, { to: 'debug' })
    }
    return r
  })

  // --- deliveries after a compaction: the next tool result or prompt -------------------------------------------------

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const r = await next(e)
    if (r.deny !== undefined) return r
    try {
      const s = await readState($)
      if (s.pending.length === 0 && !s.pointDue) return r
      const c = await config($)
      if (c.standDown !== null) return r
      const blocks = await takeDeliveries($, c)
      return blocks.length === 0 ? r : { ...r, context: [...(r.context ?? []), ...blocks] }
    } catch {
      return r
    }
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      const s = await readState($)
      if (s.pending.length === 0 && !s.pointDue) return next(e)
      const c = await config($)
      if (c.standDown !== null) return next(e)
      const blocks = await takeDeliveries($, c)
      if (blocks.length === 0) return next(e)
      return next({ ...e, context: [...(e.context ?? []), ...blocks] })
    } catch {
      return next(e)
    }
  })

  // --- compaction: a current point first, then the new cycle ----------------------------------------------------------

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const c = await config($).catch(() => null)
    if (c === null || c.standDown !== null) return next(e)

    // The summary is about to replace the transcript: a reply not yet in the point (a write in flight, or work since
    // the last one) is written now, over the transcript being compacted, bounded so a compaction never wedges.
    try {
      const s = await readState($)
      if (!s.noTranscript && (s.writing !== null || deltaFrom(e.messages, s.cursor).length > 0)) {
        const out = { gen: 0 }
        await change($, v => {
          const claim = claimForCompaction(v)
          out.gen = claim.gen ?? 0
          return claim.state
        })
        compacting = true
        showStatus($, s)
        const o = await writeOnce($, c, out.gen, e.messages, COMPACT_WAIT_MS).finally(() => {
          compacting = false
        })
        await logRun($, c, 'compact', o)
        if (o.kind === 'error') $.ui.toast(`Точка останова не обновилась перед сжатием: ${o.reason ?? '?'}`)
      }
    } catch (err) {
      compacting = false
      $.ui.log(`stop-point: no write before the compaction: ${String(err)}`, { to: 'debug' })
    }

    await change($, v => ({ ...v, compactSeq: v.compactSeq + 1 })).catch(() => null)
    const r = await next(e)
    if (r.skip !== undefined) {
      showStatus($, await readState($).catch(() => INITIAL))
      return r
    }
    try {
      const file = await pointFile($, c)
      const known = `${r.messages.map(m => m.text).join('\n')}\n${file?.text ?? ''}`
      const refs = lostRefs(e.messages, known, c.root, c.home)
      const cursor = cursorAt(r.messages)
      const after = await change($, v => ({
        ...v,
        cursor,
        pending: refs === null ? v.pending : [...v.pending, refs],
        pointDue: v.injectedSeq !== v.compactSeq,
      }))
      showStatus($, after)
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
    if (e.source === 'clear') {
      // a new session id: a new point, from its first reply
      const s = await change($, () => INITIAL)
      showStatus($, s)
      return r
    }
    const file = await pointFile($, c)
    const now = await $.clock.now()
    const blocks: string[] = []
    if (e.source === 'compact') {
      const out = { pending: [] as string[] }
      await change($, v => {
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
