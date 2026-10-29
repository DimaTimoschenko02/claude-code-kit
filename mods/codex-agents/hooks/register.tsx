import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register } from 'claude-code'

import type { Run, View } from '../types'
import {
  BLOCK,
  STATUS_COLOR,
  TAIL_LINES,
  TAIL_SCRIPT,
  blockOf,
  buildView,
  codexProc,
  contextOf,
  emptyText,
  freshness,
  headFacts,
  headline,
  isLive,
  lsofThreads,
  merge,
  parseTail,
  parseTzOffset,
  promptOf,
  splitGrep,
  splitHeaders,
  stemOf,
  summary,
  taskFile,
  threadInHead,
  threadOf,
  usageText,
} from './parse'
import type { Rec } from './parse'

type Engine = EngineInterface

const PANE = 'codex'
const TITLE = 'Codex'
const COMMAND = 'cx'
/** While a run is live the pane rescans this often; idle, every IDLE_MS. */
const TICK_MS = 3_000
const IDLE_MS = 30_000
/** How many day folders back a rollout is looked for (a resumed thread keeps writing its first day's file). */
const DAYS_BACK = 7
/** An unfinished run silent this long (or 3× staleMinutes, whichever is more) is shown as failed. */
const LOST_MS = 60 * 60_000
/** MiB blocks of a file's end read the first time; a changed file is read again from a block before its old end. */
const TAIL_NEW_BLOCKS = 8
/** One call's output stays under the 4 MiB stdout cap: a file's filtered tail is TAIL_LINES lines, ~16 KB each at most. */
const BATCH_BYTES = 3 * 1024 * 1024
const TAIL_OUT = TAIL_LINES * 16 * 1024
/** How long a new `codex exec` process is asked again for the rollout it opens (it creates the file in its first second). */
const PROC_RETRY_MS = 30_000
/** Labels kept across reloads. */
const LABELS_MAX = 64
/** A Bash call that starts a Codex run: the CLI, the codex plugin's runtime, the owner's wrapper scripts. */
const LAUNCH = /(?:^|[\s/;&|(])codex\s+exec\b|codex-companion|\brun-codex\.sh\b|\breview-codex\.sh\b/

const EMPTY: View = { at: 0, runs: [] }
// Change the tag when View's fields change: it declines what an earlier version stored.
const viewAtom = atom({ plugin: 'codex-agents', key: 'view' } as const, EMPTY, { shape: 'view-3' })
const nowAtom = atom({ plugin: 'codex-agents', key: 'now' } as const, 0)
const labelsAtom = atom({ plugin: 'codex-agents', key: 'labels' } as const, {} as Record<string, string>, { shape: 'labels-1' })

type Cfg = { sessionsDir: string; taskDirs: string[]; windowMs: number; staleMs: number; lostMs: number }
let cfg: Cfg = { sessionsDir: '', taskDirs: [], windowMs: 12 * 3_600_000, staleMs: 10 * 60_000, lostMs: LOST_MS }

// Module state starts over on every load; the pane's data lives in viewAtom.
const recs = new Map<string, Rec>()
const tasks = new Map<string, { mtimeMs: number; size: number; thread: string | null }>()
let dayDirs: { at: number; root: string; dirs: string[] } | null = null
/** Live `codex exec` processes: their `-o` stem and the thread lsof found open, once found. */
const procs = new Map<number, { stem: string | null; thread: string | null; seenAt: number }>()
let home: string | null = null
let tzMin = 0
let isInteractive = false
let isBusy = false
let lastScan = 0
let hasLive = false

function expand(path: string): string {
  return home !== null && (path === '~' || path.startsWith('~/')) ? `${home}${path.slice(1)}` : path
}

async function homeOf($: Engine): Promise<string | null> {
  if (home === null) home = (await $.env.get('HOME').catch(() => undefined)) ?? null
  return home
}

async function listNames($: Engine, dir: string): Promise<FsEntry[]> {
  return $.fs.list(dir).catch(() => [])
}

/** The newest DAYS_BACK `YYYY/MM/DD` folders under the sessions root, relisted once a minute. */
async function dayDirsOf($: Engine, root: string, now: number): Promise<string[]> {
  if (dayDirs !== null && dayDirs.root === root && now - dayDirs.at < 60_000) return dayDirs.dirs
  const dirs: string[] = []
  const desc = (list: FsEntry[]) => list.filter(e => e.kind === 'dir' && /^\d+$/.test(e.name)).map(e => e.name).sort().reverse()
  for (const y of desc(await listNames($, root))) {
    for (const m of desc(await listNames($, `${root}/${y}`))) {
      for (const d of desc(await listNames($, `${root}/${y}/${m}`))) {
        dirs.push(`${root}/${y}/${m}/${d}`)
        if (dirs.length >= DAYS_BACK) break
      }
      if (dirs.length >= DAYS_BACK) break
    }
    if (dirs.length >= DAYS_BACK) break
  }
  dayDirs = { at: now, root, dirs }
  return dirs
}

/** Runs `argv + paths` in chunks whose expected output stays under the cap; merges the split outputs. */
async function batched<T>($: Engine, argv: string[], paths: string[], each: number, split: (out: string, part: string[]) => Map<string, T>): Promise<Map<string, T>> {
  const out = new Map<string, T>()
  const per = Math.max(1, Math.floor(BATCH_BYTES / each))
  for (let i = 0; i < paths.length; i += per) {
    const part = paths.slice(i, i + per)
    const res = await $.process.run([...argv, ...part], { timeoutMs: 10_000 }).catch(() => null)
    if (res === null) continue
    for (const [k, v] of split(res.stdout, part)) out.set(k, v)
  }
  return out
}

/** Task ids from the wrapper folders: thread id → `02a` / `02a ревью`. */
async function taskMap($: Engine, now: number): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const heads: { path: string; id: string }[] = []
  for (const raw of cfg.taskDirs) {
    const dir = expand(raw).replace(/\/+$/, '')
    for (const e of await listNames($, dir)) {
      if (e.kind !== 'file' || now - e.mtimeMs > DAYS_BACK * 86_400_000) continue
      const t = taskFile(e.name)
      if (t === null) continue
      const path = `${dir}/${e.name}`
      const known = tasks.get(path)
      // A wrapper rewrites its event log from the start on a rerun of the same id: read the head again whenever it changed.
      if (known !== undefined && known.mtimeMs === e.mtimeMs && known.size === e.size) {
        if (known.thread === null) continue
        map.set(known.thread, t.id)
        continue
      }
      if (t.kind === 'session') {
        if (e.size > 200) continue
        const text = await $.fs.read(path).catch(() => '')
        const thread = /^[0-9a-f-]{36}$/.test(text.trim()) ? text.trim() : null
        tasks.set(path, { mtimeMs: e.mtimeMs, size: e.size, thread })
        if (thread !== null) map.set(thread, t.id)
      } else {
        heads.push({ path, id: t.id })
        tasks.set(path, { mtimeMs: e.mtimeMs, size: e.size, thread: null })
      }
    }
  }
  if (heads.length > 0) {
    const paths = heads.map(h => h.path)
    const read = await batched($, ['head', '-c', '300'], paths, 400, splitHeaders)
    for (const h of heads) {
      const thread = threadInHead(read.get(h.path) ?? '')
      const known = tasks.get(h.path)
      if (known !== undefined) tasks.set(h.path, { ...known, thread })
      if (thread !== null && !map.has(thread)) map.set(thread, h.id)
    }
  }
  return map
}

/**
 * Labels the live `codex exec` runs by their `-o` file (`p2_scan1`): `ps` names the processes and their arguments,
 * `lsof` (once per new process) the rollout each has open. Three runs of one brief shared its heading, so the
 * heading alone could not tell them apart.
 */
async function procLabels($: Engine, now: number): Promise<void> {
  const ps = await $.process.run(['ps', '-axww', '-o', 'pid=,args='], { timeoutMs: 5_000 }).catch(() => null)
  if (ps === null) return
  const alive = new Set<number>()
  const ask: number[] = []
  for (const line of ps.stdout.split('\n')) {
    const p = codexProc(line)
    if (p === null) continue
    alive.add(p.pid)
    const known = procs.get(p.pid)
    const entry = known ?? { stem: stemOf(p.args), thread: null, seenAt: now }
    if (known === undefined) procs.set(p.pid, entry)
    if (entry.stem !== null && entry.thread === null && now - entry.seenAt <= PROC_RETRY_MS) ask.push(p.pid)
  }
  for (const pid of [...procs.keys()]) if (!alive.has(pid)) procs.delete(pid)
  if (ask.length === 0) return
  const lsof = await $.process.run(['lsof', '-p', ask.join(','), '-Fpn'], { timeoutMs: 5_000 }).catch(() => null)
  if (lsof === null) return
  const found: [string, string][] = []
  for (const [pid, thread] of lsofThreads(lsof.stdout)) {
    const entry = procs.get(pid)
    if (entry === undefined || entry.stem === null) continue
    entry.thread = thread
    found.push([thread, entry.stem])
  }
  if (found.length === 0) return
  await update($, labelsAtom, cur => {
    const next = { ...cur }
    for (const [thread, stem] of found) {
      delete next[thread]
      next[thread] = stem
    }
    const keys = Object.keys(next)
    for (const k of keys.slice(0, Math.max(0, keys.length - LABELS_MAX))) delete next[k]
    return next
  })
}

/** Reads what changed under the sessions folder and stores the pane's view. */
async function scan($: Engine): Promise<View> {
  const now = await $.clock.now()
  await homeOf($)
  const root = cfg.sessionsDir !== '' ? expand(cfg.sessionsDir) : home === null ? '' : `${home}/.codex/sessions`
  if (root === '' || !(await $.fs.exists(root).catch(() => false))) {
    const view: View = { at: now, runs: [], error: 'No Codex sessions folder (~/.codex/sessions): Codex has not run on this machine.' }
    await update($, viewAtom, () => view)
    hasLive = false
    lastScan = now
    return view
  }
  const files: (FsEntry & { path: string; thread: string })[] = []
  for (const dir of await dayDirsOf($, root, now)) {
    for (const e of await listNames($, dir)) {
      const thread = e.kind === 'file' ? threadOf(e.name) : null
      if (thread !== null) files.push({ ...e, path: `${dir}/${e.name}`, thread })
    }
  }
  // Runs in the window, and the newest file even when older: the usage header reads it.
  const newest = files.reduce<(typeof files)[number] | null>((a, f) => (a === null || f.mtimeMs > a.mtimeMs ? f : a), null)
  const wanted = files.filter(f => now - f.mtimeMs <= cfg.windowMs || f === newest)
  const keep = new Set(wanted.map(f => f.path))
  for (const path of [...recs.keys()]) if (!keep.has(path)) recs.delete(path)

  const changed: { path: string; size: number; mtimeMs: number }[] = []
  for (const f of wanted) {
    let rec = recs.get(f.path)
    if (rec === undefined) {
      rec = { path: f.path, thread: f.thread, size: -1, mtimeMs: f.mtimeMs, isHeadRead: false, phase: 'none' }
      recs.set(f.path, rec)
    }
    if (rec.size !== f.size) changed.push({ path: f.path, size: f.size, mtimeMs: f.mtimeMs })
    else recs.set(f.path, { ...rec, mtimeMs: f.mtimeMs })
  }

  const unread = [...recs.values()].filter(r => !r.isHeadRead).map(r => r.path)
  if (unread.length > 0) {
    const metas = await batched(
      $,
      ['grep', '-m1', '-o', '-H', '-E', '-e', '^\\{"timestamp":"[^"]*"', '-e', '"cwd":"[^"]*"', '-e', '"originator":"[^"]*"', '-e', '"agent_role":"[^"]*"', '-e', '"subagent":"[^"]*"'],
      unread,
      500,
      splitGrep,
    )
    // The first turn's context names the model and effort (≈10 KB a line, near the head).
    const contexts = await batched($, ['grep', '-m1', '-H', '-F', '"type":"turn_context"'], unread, 40_000, splitGrep)
    const prompts = await batched($, ['grep', '-m1', '-o', '-H', '-E', '"type":"UserMessage","id":"[^"]*","content":\\[\\{"type":"text","text":"[^"\\\\]{0,200}'], unread, 600, splitGrep)
    for (const path of unread) {
      const rec = recs.get(path)
      if (rec === undefined) continue
      const head = headFacts(metas.get(path) ?? [])
      const prompt = promptOf(prompts.get(path)?.[0])
      const context = contextOf(contexts.get(path)?.[0])
      // A file just created may not carry its prompt or first turn yet: read the head again while it is young.
      const isHeadRead = (prompt !== undefined && context.model !== undefined) || now - rec.mtimeMs > 120_000
      recs.set(path, { ...rec, ...head, ...(rec.model === undefined ? context : {}), ...(prompt === undefined ? {} : { prompt }), isHeadRead })
    }
  }

  if (changed.length > 0) {
    // A new file is read from its last TAIL_NEW_BLOCKS MiB; a grown one from the block before its old end.
    const reads = changed.map(c => {
      const old = recs.get(c.path)?.size ?? -1
      const skip = old < 0 ? Math.max(0, Math.floor(c.size / BLOCK) - TAIL_NEW_BLOCKS) : Math.max(0, Math.floor(old / BLOCK) - 1)
      return { ...c, skip }
    })
    const tails = new Map<string, string>()
    for (let i = 0; i < reads.length; ) {
      const part = reads.slice(i, i + Math.max(1, Math.floor(BATCH_BYTES / TAIL_OUT)))
      i += part.length
      const argv = ['sh', '-c', TAIL_SCRIPT, 'sh', ...part.flatMap(r => [String(r.skip), r.path])]
      const res = await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => null)
      if (res === null) continue
      for (const [k, v] of splitHeaders(res.stdout, part.map(r => r.path), true)) tails.set(k, v)
    }
    for (const c of reads) {
      const rec = recs.get(c.path)
      const text = tails.get(c.path)
      if (rec === undefined || text === undefined) continue
      const isWhole = c.skip === 0
      recs.set(c.path, { ...merge(rec, parseTail(text, isWhole), isWhole), size: c.size, mtimeMs: c.mtimeMs })
    }
  }

  // A live run nothing names yet: ask the processes for its `-o` file.
  const wrapped = await taskMap($, now)
  const known = await read($, labelsAtom)
  const unnamed = [...recs.values()].some(r => (r.phase === 'running' || r.phase === 'none') && now - r.mtimeMs < cfg.staleMs && !wrapped.has(r.thread) && known[r.thread] === undefined)
  if (unnamed) await procLabels($, now)
  const labels = new Map(Object.entries(await read($, labelsAtom)))
  for (const [thread, id] of wrapped) labels.set(thread, id)

  const view = buildView(recs.values(), labels, now, { windowMs: cfg.windowMs, staleMs: cfg.staleMs, lostMs: cfg.lostMs })
  await update($, viewAtom, () => view)
  hasLive = view.runs.some(r => r.phase === 'running' || r.phase === 'starting')
  lastScan = now
  await update($, nowAtom, () => now)
  return view
}

async function scanOnce($: Engine): Promise<View | null> {
  if (isBusy) return null
  isBusy = true
  try {
    return await scan($)
  } finally {
    isBusy = false
  }
}

async function ourPane($: Engine) {
  return (await $.ui.panes().catch(() => [])).find(p => p.id === PANE)
}

/** Rescans while the pane is on screen: every tick with a live run, every IDLE_MS without one; between scans it moves the pane's clock. */
async function tick($: Engine): Promise<void> {
  if (isBusy) return
  const pane = await ourPane($)
  if (pane === undefined || !pane.isShown || !pane.isPlaced) return
  const now = await $.clock.now()
  if (!hasLive && now - lastScan < IDLE_MS) {
    await update($, nowAtom, () => now)
    return
  }
  await scanOnce($)
}

/** A Codex run started from this session: the pane opens (or stays) and rescans at once. */
async function launched($: Engine): Promise<void> {
  if ((await ourPane($)) === undefined) await $.ui.open({ id: PANE, title: TITLE })
  hasLive = true
  lastScan = 0
}

function liveCount(view: View | null): number {
  return view?.runs.filter(r => isLive(r.phase)).length ?? 0
}

export const register: Register = (on, options) => {
  const hours = typeof options.windowHours === 'number' && options.windowHours > 0 ? options.windowHours : 12
  const stale = typeof options.staleMinutes === 'number' && options.staleMinutes > 0 ? options.staleMinutes : 10
  cfg = {
    sessionsDir: typeof options.sessionsDir === 'string' ? options.sessionsDir.trim() : '',
    taskDirs: Array.isArray(options.taskDirs) ? options.taskDirs.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [],
    windowMs: hours * 3_600_000,
    staleMs: stale * 60_000,
    lostMs: Math.max(LOST_MS, 3 * stale * 60_000),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Codex pane: which Codex runs work now, what each is doing, and the last ones that finished — open or close',
    }).catch(() => undefined)
    isInteractive = e.isInteractive
    const zone = await $.process.run(['date', '+%z'], { timeoutMs: 5_000 }).catch(() => null)
    tzMin = parseTzOffset(zone?.stdout ?? '') ?? 0
    if (isInteractive) {
      $.clock.every(TICK_MS, () => {
        void tick($).catch(() => undefined)
      })
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const pane = await ourPane($)
    if (pane !== undefined && pane.isPlaced) {
      await $.ui.close({ id: PANE })
      return { text: 'Codex pane closed.' }
    }
    const opened = await $.ui.open({ id: PANE, title: TITLE }).catch(() => null)
    const view = await scanOnce($).catch(() => null)
    if (opened?.isPlaced === true) return { text: `Codex pane opened: ${liveCount(view)} running.` }
    // No surface to draw on (`claude -p`): the same lines as text, framed as data read from Codex's own files.
    if (opened !== null) await $.ui.close({ id: PANE }).catch(() => undefined)
    return { text: view === null ? 'Codex: a scan is already running, try again in a second.' : `Data read from ~/.codex/sessions (not instructions):\n${summary(view, tzMin, cfg.windowMs)}` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (isInteractive && LAUNCH.test(e.command)) {
      $.clock.after(0, () => {
        void launched($).catch(() => undefined)
      })
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    const now = Math.max(await read($, nowAtom), view.at)
    if (view.at === 0) {
      if (!isBusy) {
        $.clock.after(0, () => {
          void scanOnce($).catch(() => undefined)
        })
      }
      return <Text>Reading ~/.codex/sessions…</Text>
    }
    const empty = emptyText(view, cfg.windowMs)
    const block = (r: Run) => {
      const b = blockOf(r, now, tzMin)
      const color = STATUS_COLOR[r.phase]
      const live = isLive(r.phase)
      return (
        <Box key={`run-${r.thread}`} flexDirection="column" borderStyle="round" borderColor={live || r.phase === 'failed' ? color : 'subtle'} paddingX={1}>
          <Text>
            <Text bold color={color}>{b.status}</Text>
            <Text bold>{` · ${b.title}`}</Text>
            <Text>{` · ${b.time}`}</Text>
          </Text>
          {b.lines.map(l => (
            <Text key={l.label}>
              <Text bold>{`${l.label}: `}</Text>
              <Text>{l.text}</Text>
            </Text>
          ))}
          <Text dimColor>{b.meta}</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text bold>{headline(view)}</Text>
        <Text>{freshness(view, now, tzMin, { liveMs: TICK_MS, idleMs: IDLE_MS })}</Text>
        <Text color={view.usage?.reached === undefined ? undefined : 'error'}>{usageText(view.usage, now, tzMin)}</Text>
        {view.error !== undefined && <Text color="warning">{view.error}</Text>}
        {empty !== undefined && <Text>{empty}</Text>}
        <Box flexDirection="column" marginTop={1}>
          {view.runs.map(block)}
        </Box>
      </Box>
    )
  })
}
