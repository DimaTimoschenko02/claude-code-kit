// A side panel per session: the links the main thread's replies carried, grouped under their task, and one line per
// `result:` the replies delivered. The owner ticks, rewrites, deletes and adds lines in place; what they changed reaches
// the model with their next message. The panel lives in $.store per session id, so it outlives restarts and reloads.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Item, Panel, Pr } from '../types'
import {
  addNote,
  addOwnerLine,
  capture,
  edit,
  emptyPanel,
  isCard,
  merge,
  nextTurn,
  normalize,
  panelPulls,
  panelTasks,
  remove,
  reportText,
  taskRegex,
  toggle,
  view,
} from './logic'
import type { Section, TaskGroup } from './logic'
import { GH_FIELDS, cardBadge, cardStatus, parsePr, prBadge, pullOf } from './status'
import type { Badge } from './status'
import { runs, withLead } from './markup'
import type { Run } from './markup'
import { NO_REFS, blocked, candidates, gate, githubRepo, linked, placeByName, repoOfLinks, vaultNote, within } from './refs'
import type { Refs } from './refs'

type Engine = EngineInterface

const PANE = 'session-panel'
export const COMMAND = 'sp'
export const TOOL = 'add'
const KEY = 'panel:'
const TTL_MS = 30 * 86_400_000
/** Wide enough for a card title and its three buttons; the owner's drag or key resize wins and is kept. */
const COLUMNS = 48
/** The theme colour a reply's own `code` spans are drawn in; a surface that lacks the key draws the default colour. */
const CODE_COLOR = 'permission'

const panelAtom = atom({ plugin: 'session-panel', key: 'panel' } as const, emptyPanel(0))
const editingAtom = atom({ plugin: 'session-panel', key: 'editing' } as const, null)
const statusesAtom = atom({ plugin: 'session-panel', key: 'statuses' } as const, {})
const prsAtom = atom({ plugin: 'session-panel', key: 'prs' } as const, {})
const openAtom = atom({ plugin: 'session-panel', key: 'open' } as const, [])
/** An open pull request is asked again at most this often; a merged or closed one not again in this load. */
const PR_REFRESH_MS = 60_000
/** Pull requests asked per pass, the most recently carried first; the rest wait for the next reply. */
const PR_PER_PASS = 20
const refsAtom = atom({ plugin: 'session-panel', key: 'refs' } as const, NO_REFS)

function isPanel(value: unknown): value is Panel {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return Array.isArray(v.items) && Array.isArray(v.dropped) && Array.isArray(v.report) && typeof v.seq === 'number'
}

type Config = { pattern: RegExp; cardsDir: string; doneStatuses: string[]; linkRoots: string[]; vault: string }
/** The owner's own repos and vault: their files link from any session. */
const LINK_ROOTS = ['~/claude-code-kit', '~/mind']
const VAULT = '~/mind'
let cfg: Config = { pattern: taskRegex(undefined), cardsDir: '', doneStatuses: ['Done'], linkRoots: LINK_ROOTS, vault: VAULT }
// Bumped per owner line so the add field empties; an auto capture mid-typing leaves it alone.
let addRound = 0
// The session the atom holds; `/clear` starts a new id, whose panel is loaded fresh.
let sid = ''
// How to restart this session so it loads new mods: a background job by its job id, any other by its session id.
let restart = ''

async function sync($: Engine): Promise<void> {
  const id = await $.session.id()
  if (id === sid) return
  sid = id
  const stored = await $.store.get(`${KEY}${id}`)
  await update($, panelAtom, () => (isPanel(stored) ? normalize(stored) : emptyPanel(0)))
  await update($, editingAtom, () => null)
  await update($, openAtom, () => [])
  await refreshCards($)
  await resolveRefs($)
}

// Where the places a line names are looked up: the session's folder and repo, the owner's home, the GitHub repo, and
// the roots a path must lie in to be linked — as spelt (checked before any disk access) and as they really are.
let where = { cwd: '', top: '', home: '', repo: '', spelt: [] as string[], real: [] as string[], vault: '' }
// What this load already looked up: a sha → a commit or not, a path → its checked target or nothing.
let seenShas = new Map<string, boolean>()
let seenPaths = new Map<string, Refs['files'][string] | null>()
/** New paths looked up per pass; a long stored panel is checked over a few replies instead of all at start. */
const PATHS_PER_PASS = 200
const HEX = /^[0-9a-f]{7,40}$/

/** A command by its argument vector, never a shell; its output, or null when it failed or exited non-zero. */
async function run($: Engine, argv: string[], cwd: string, stdin?: string): Promise<string | null> {
  const r = await $.process
    .run(argv, { cwd, timeoutMs: 5_000, ...(stdin === undefined ? {} : { stdin }) })
    .catch(() => null)
  return r === null || r.exitCode !== 0 ? null : r.stdout
}

async function realDir($: Engine, path: string): Promise<string | undefined> {
  const st = await $.fs.stat(path, { resolve: true }).catch(() => null)
  return st?.kind === 'dir' ? st.realPath : undefined
}

async function locate($: Engine, cwd: string): Promise<void> {
  const repo = await $.session.repo().catch(() => null)
  const top = repo?.root ?? ''
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const expand = (p: string) => (p.startsWith('~/') && home !== '' ? `${home}${p.slice(1)}` : p)
  const spelt = [cwd, top, cfg.cardsDir, expand(cfg.vault), ...cfg.linkRoots.map(expand)]
    .map(p => p.replace(/\/+$/, ''))
    .filter(p => p.startsWith('/') && p.length > 1 && !p.split('/').some(s => s === '.' || s === '..'))
  const real: string[] = []
  for (const p of spelt) {
    const r = await realDir($, p)
    if (r !== undefined && r !== '/') real.push(r)
  }
  const vault = cfg.vault === '' ? undefined : await realDir($, expand(cfg.vault))
  where = { cwd, top, home, repo: githubRepo(repo?.remote ?? ''), spelt: [...new Set([...spelt, ...real])], real, vault: vault ?? '' }
  seenShas = new Map()
  seenPaths = new Map()
}

/**
 * Where a path the text names really is, when a click there is safe: spelt inside a root, landing inside a root once
 * every link is followed, no bundle along the way, no launcher file. A vault note carries its vault and note path.
 */
async function place($: Engine, path: string): Promise<Refs['files'][string] | null> {
  for (const abs of placeByName(path, [where.cwd, where.top], where.home, where.spelt)) {
    const st = await $.fs.stat(abs, { resolve: true }).catch(() => null)
    if (st === null || st.kind === 'other' || st.realPath === undefined) continue
    const dir = st.kind === 'dir'
    if (!within(st.realPath, where.real) || blocked(abs, dir) || blocked(st.realPath, dir)) continue
    const note = dir ? undefined : vaultNote(st.realPath, where.vault)
    return { abs: st.realPath, dir, ...(note === undefined ? {} : { vault: note }) }
  }
  return null
}

/** Checks what the panel's lines name — shas with git, paths on disk — so the pane links only what leads somewhere. */
async function resolveRefs($: Engine): Promise<void> {
  const panel = await read($, panelAtom)
  const shas = new Set<string>()
  const paths = new Set<string>()
  for (const item of panel.items) {
    if (item.href !== undefined) continue
    const c = candidates(item.text)
    for (const s of c.shas) if (HEX.test(s)) shas.add(s)
    for (const p of c.paths) paths.add(p)
  }
  const fresh = where.top === '' ? [] : [...shas].filter(s => !seenShas.has(s))
  if (fresh.length > 0) {
    // Only hex reaches git, on its standard input: nothing the text says can become an option or a revision range.
    const out = await run($, ['git', 'cat-file', '--batch-check'], where.top, `${fresh.map(s => `${s}^{commit}`).join('\n')}\n`)
    const lines = out?.split('\n') ?? []
    fresh.forEach((s, n) => seenShas.set(s, / commit /.test(lines[n] ?? '')))
  }
  const placed = new Map<string, Refs['files'][string] | null>()
  for (const p of [...paths].filter(x => !seenPaths.has(x)).slice(0, PATHS_PER_PASS)) placed.set(p, await place($, p))
  for (const [p, f] of placed) seenPaths.set(p, f)
  const known: Record<string, Refs['files'][string]> = {}
  for (const [p, f] of seenPaths) if (f !== null) known[p] = f
  const refs: Refs = {
    repo: where.repo !== '' ? where.repo : repoOfLinks(panel.items.flatMap(i => (i.href === undefined ? [] : [i.href]))),
    commits: [...seenShas].filter(([, ok]) => ok).map(([s]) => s),
    files: known,
  }
  await update($, refsAtom, () => refs)
}

async function change($: Engine, fn: (p: Panel) => Panel): Promise<void> {
  await sync($)
  const before = await read($, panelAtom)
  const after = fn(before)
  if (after === before) return
  const stamped = { ...after, at: await $.clock.now() }
  await update($, panelAtom, () => stamped)
  await $.store.set(`${KEY}${sid}`, stamped)
  if (after.items !== before.items) await resolveRefs($)
}

/** Every task the panel names gets its card's status, whether or not a reply linked the card itself. */
async function refreshCards($: Engine): Promise<void> {
  if (cfg.cardsDir === '') return
  const statuses: Record<string, string> = {}
  for (const task of panelTasks(await read($, panelAtom))) {
    const text = await $.fs.read(`${cfg.cardsDir}/${task}.md`).catch(() => null)
    const status = text === null ? undefined : cardStatus(text)
    if (status !== undefined) statuses[task] = status
  }
  await update($, statusesAtom, () => statuses)
}

// One pass at a time; gh missing or failing leaves the rows without a pull request badge, nothing else.
let prBusy = false
let ghMissing = false
// A session started outside a login shell may lack Homebrew on its PATH: the usual places are tried next.
const GH = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']
let gh = 0
// Once a path ran, a failure to start (a timeout) is that request's, not a missing gh.
let ghRan = false
let prFailed = new Map<string, number>()

/** Asks gh for the state of the panel's pull requests that are new or open and not asked within the last minute. */
async function refreshPrs($: Engine, force: boolean): Promise<void> {
  if (prBusy || ghMissing) return
  prBusy = true
  try {
    const now = await $.clock.now()
    const known: Readonly<Record<string, Pr>> = await read($, prsAtom)
    const fresh = (at: number | undefined) => at !== undefined && now - at < PR_REFRESH_MS
    const due = panelPulls(await read($, panelAtom))
      .filter(p => {
        const have = known[p.key]
        if (have !== undefined && have.state !== 'OPEN') return false
        if (fresh(prFailed.get(p.key))) return false
        return have === undefined || force || !fresh(have.at)
      })
      .slice(0, PR_PER_PASS)
    for (const p of due) {
      // Only a checked owner/repo and a number reach gh, as separate arguments.
      let r = null
      while (r === null && gh < GH.length) {
        r = await $.process
          .run([GH[gh]!, 'pr', 'view', p.number, '--repo', p.repo, '--json', GH_FIELDS], { timeoutMs: 15_000 })
          .catch(() => null)
        if (r === null && ghRan) break
        if (r === null) gh++
      }
      if (r === null && ghRan) {
        prFailed.set(p.key, now)
        continue
      }
      if (r === null) {
        ghMissing = true
        $.ui.log('session-panel: gh did not start; pull request states are off for this load', { to: 'debug' })
        return
      }
      ghRan = true
      const pr = r.exitCode === 0 ? parsePr(r.stdout, now) : null
      if (pr === null) {
        prFailed.set(p.key, now)
        continue
      }
      prFailed.delete(p.key)
      await update($, prsAtom, m => ({ ...m, [p.key]: pr }))
    }
  } finally {
    prBusy = false
  }
}

function laterPrs($: Engine, force: boolean): void {
  $.clock.after(0, () => {
    void refreshPrs($, force).catch(() => undefined)
  })
}

async function togglePane($: Engine): Promise<boolean> {
  if ((await $.ui.panes()).some(p => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return false
  }
  await $.ui.open({ id: PANE, title: 'Сессия', columns: COLUMNS })
  // Opening the pane asks again, even after gh was not found earlier in this load.
  ghMissing = false
  gh = 0
  laterPrs($, true)
  return true
}

async function flip($: Engine, key: string): Promise<void> {
  await update($, openAtom, list => (list.includes(key) ? list.filter(k => k !== key) : [...list, key]))
}

export const register: Register = (on, options) => {
  cfg = {
    pattern: taskRegex(typeof options.taskPattern === 'string' ? options.taskPattern : undefined),
    cardsDir: typeof options.cardsDir === 'string' ? options.cardsDir.replace(/\/+$/, '') : '',
    doneStatuses: Array.isArray(options.doneStatuses)
      ? options.doneStatuses.filter((s): s is string => typeof s === 'string')
      : ['Done'],
    linkRoots: Array.isArray(options.linkRoots) ? options.linkRoots.filter((s): s is string => typeof s === 'string') : LINK_ROOTS,
    vault: typeof options.vault === 'string' ? options.vault : VAULT,
  }
  const pattern = cfg.pattern

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Панель сессии: ссылки, задачи и что сделано — открыть или закрыть',
      immediate: true,
    }).catch(err => $.ui.log(`session-panel: /${COMMAND} not registered: ${String(err)}`, { to: 'debug' }))
    await $.tool.register({
      name: TOOL,
      description:
        "Adds a line to the owner's session panel. Links in your replies and `result:` lines are picked up by " +
        'themselves; call this only for what no reply carried — a link worth keeping, or a short done note.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The line, or the link label when href is given.' },
          href: { type: 'string', description: 'https:// or obsidian:// address, optional.' },
          done: { type: 'boolean', description: 'A delivered result rather than a note.' },
        },
        required: ['text'],
      },
    }).catch(err => $.ui.log(`session-panel: tool not registered: ${String(err)}`, { to: 'debug' }))

    // Panels of sessions long gone would fill the store's 4 MiB.
    const now = await $.clock.now()
    for (const key of await $.store.keys()) {
      if (!key.startsWith(KEY)) continue
      const value = await $.store.get(key)
      if (!isPanel(value) || now - value.at > TTL_MS) await $.store.delete(key)
    }

    sid = ''
    prFailed = new Map()
    ghMissing = false
    gh = 0
    ghRan = false
    await locate($, e.cwd)
    await sync($)
    laterPrs($, true)
    const jobDir = await $.env.get('CLAUDE_JOB_DIR').catch(() => undefined)
    const job = jobDir?.replace(/\/+$/, '').split('/').pop()
    restart = job !== undefined && job !== '' ? `claude respawn ${job}` : `claude --resume ${sid}`
    if (e.isInteractive && !(await $.ui.panes()).some(p => p.id === PANE)) {
      void $.ui.open({ id: PANE, title: 'Сессия', columns: COLUMNS })
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    void e
    void next
    await sync($)
    return { text: (await togglePane($)) ? 'Панель сессии открыта.' : 'Панель сессии закрыта.' }
  })

  on('tool.call', { tool: 'mcp__session-panel__add' }, async ($, e) => {
    const input = e as unknown as { text?: unknown; href?: unknown; done?: unknown }
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    const href = typeof input.href === 'string' ? input.href.trim() : ''
    if (text === '') return { deny: 'text is empty' }
    if (href !== '' && !/^(?:https?|obsidian):\/\/\S+$/.test(href)) return { deny: 'href must be an https:// or obsidian:// address' }
    await change($, p =>
      href !== ''
        ? merge(p, { links: [{ href, label: text }], results: [] }, pattern, 'tool')
        : input.done === true
          ? merge(p, { links: [], results: [text] }, pattern, 'tool')
          : addNote(p, text, pattern, 'tool'),
    )
    return { result: 'added to the session panel' }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || e.isAborted || e.answer === '') return r
    const got = capture(e.answer)
    // Every reply counts, carrying links or not: freshness is measured in the work done since.
    await change($, p => merge(nextTurn(p), got, pattern))
    await refreshCards($)
    laterPrs($, false)
    return r
  })

  // The owner's panel edits reach the model with their next message, then the list starts over.
  on('prompt.submit', async ($, e, next) => {
    const owner = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!owner) return next(e)
    await sync($)
    const note = reportText((await read($, panelAtom)).report)
    if (note === undefined) return next(e)
    await change($, p => ({ ...p, report: [] }))
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Link } = els
    // The mobile app draws no field yet: there the panel is read-and-tick only.
    const Input = 'Input' in els ? els.Input : null
    const panel = await read($, panelAtom)
    const editing = await read($, editingAtom)
    const prs: Readonly<Record<string, Pr>> = await read($, prsAtom)
    const unfolded: readonly string[] = await read($, openAtom)
    const v = view(panel, { statuses: await read($, statusesAtom), prs, doneStatuses: cfg.doneStatuses })
    // Every place a line names — `#140`, a sha, a path, an address, a task with its card here — is a link where it stands.
    const places = {
      ...(await read($, refsAtom)),
      cards: new Map(panel.items.filter(isCard).map(i => [i.task!, i.href!] as const)),
      task: cfg.pattern,
    }

    // A line's markdown drawn as styled runs; inside a link item a run's own link is drawn as its label alone.
    const inline = (list: Run[], id: string, linkable: boolean) =>
      list.map((r, n) => {
        const look = {
          ...(r.bold === undefined ? {} : { bold: true }),
          ...(r.italic === undefined ? {} : { italic: true }),
          ...(r.code === undefined ? {} : { color: CODE_COLOR }),
        }
        const text = <Text key={`r-${id}-${n}`} {...look}>{r.text}</Text>
        return r.href !== undefined && linkable ? <Link key={`l-${id}-${n}`} href={r.href}>{text}</Link> : text
      })

    // A link item's own address passes the same gate as a line's: one that fails draws as its label, plain.
    const linkTo = (href: string, label: RenderChildren[]) => {
      const safe = gate(href, places.files)
      return safe === undefined ? label : <Link href={safe}>{label}</Link>
    }

    const look = (b: Badge) => ({ ...(b.color === undefined ? {} : { color: b.color }), ...(b.dim === undefined ? {} : { dimColor: true }) })
    // A pull request's state after its link: `PR #171 ждёт ревью`, `PR #171 → main`.
    const prState = (href: string | undefined, key: string) => {
      const pr = href === undefined ? undefined : pullOf(href)
      const known = pr === undefined ? undefined : prs[pr.key]
      if (known === undefined) return null
      const b = prBadge(known)
      return <Text key={`ps-${key}`} {...look(b)}>{` ${b.text}`}</Text>
    }
    // A task row's badges: the card's status, then each pull request with its number linked.
    const badges = (g: TaskGroup) => {
      const out: RenderChildren[] = []
      if (g.status !== undefined) {
        const b = cardBadge(g.status)
        out.push(<Text key={`cs-${g.task}`} {...look(b)}>{`  ${b.text}`}</Text>)
      }
      for (const k of g.prs) {
        const pr = prs[k]
        if (pr === undefined) continue
        const b = prBadge(pr)
        const n = k.slice(k.lastIndexOf('#') + 1)
        out.push(<Text key={`pd-${g.task}-${k}`} dimColor>{out.length === 0 ? '  ' : ' · '}</Text>)
        out.push(
          <Link key={`pl-${g.task}-${k}`} href={`https://github.com/${k.slice(0, k.lastIndexOf('#'))}/pull/${n}`}>
            <Text {...look(b)}>{`PR #${n}`}</Text>
          </Link>,
        )
        out.push(<Text key={`pb-${g.task}-${k}`} {...look(b)}>{` ${b.text}`}</Text>)
      }
      return out
    }

    // `lead` sits before the tick (a task's fold arrow), `tail` after the text (a task's badges).
    const row = (item: Item, indent = 0, lead: RenderChildren = null, tail: RenderChildren[] = []) => {
      if (editing === item.id && Input !== null) {
        return (
          <Box key={item.id} paddingLeft={indent}>
            <Input
              key={`edit-${item.id}`}
              value={item.text}
              autoFocus
              submitLabel="сохранить"
              onSubmit={async (value: string) => {
                await change($, p => edit(p, item.id, value))
                await update($, editingAtom, () => null)
              }}
            />
          </Box>
        )
      }
      return (
        <Box key={item.id} flexDirection="row" paddingLeft={indent}>
          {lead}
          <Button key={`t-${item.id}`} plain label={item.checked ? '☑' : '☐'} onPress={() => change($, p => toggle(p, item.id))} />
          <Text key={`s-${item.id}`}> </Text>
          {item.href === undefined
            ? <Box key={`b-${item.id}`} flexGrow={1} flexShrink={1}><Text wrap="wrap" dimColor={item.checked && item.kind !== 'done'}>{inline(withLead(linked(runs(item.text), places)), item.id, true)}{tail}</Text></Box>
            : <Box key={`b-${item.id}`} flexGrow={1} flexShrink={1}><Text wrap="wrap">{linkTo(item.href, inline(runs(item.text), item.id, false))}{prState(item.href, item.id)}{tail}</Text></Box>}
          <Text key={`g-${item.id}`}> </Text>
          {Input === null ? null : <Button key={`e-${item.id}`} plain dimColor label="✎" onPress={() => update($, editingAtom, () => item.id)} />}
          <Button key={`d-${item.id}`} plain dimColor label="✕" onPress={() => change($, p => remove(p, item.id))} />
        </Box>
      )
    }

    // One dim line in place of what is folded; pressed, it unfolds in place and turns into the line that folds back.
    const more = (key: string, label: string, count: number) =>
      count === 0 ? null : (
        <Button key={`more-${key}`} plain dimColor label={unfolded.includes(key) ? '▾ свернуть' : label} onPress={() => flip($, key)} />
      )

    // One coarse line per task: fold arrow, the card (or the task id), its badges; its links unfold under it.
    const taskRow = (g: TaskGroup) => {
      const key = `task:${g.task}`
      const isOpen = unfolded.includes(key)
      const arrow =
        g.children.length === 0 ? (
          <Text key={`fa-${g.task}`}>{'  '}</Text>
        ) : (
          <Button key={`f-${g.task}`} plain dimColor label={isOpen ? '▾' : '▸'} onPress={() => flip($, key)} />
        )
      const head =
        g.card !== undefined ? (
          row(g.card, 0, [arrow, <Text key={`fs-${g.task}`}> </Text>], badges(g))
        ) : (
          <Box key={`h-${g.task}`} flexDirection="row">
            {arrow}
            <Text key={`hs-${g.task}`}> </Text>
            <Box key={`hb-${g.task}`} flexGrow={1} flexShrink={1}>
              <Text wrap="wrap"><Text bold>{g.task}</Text>{badges(g)}</Text>
            </Box>
          </Box>
        )
      return [head, ...(isOpen ? g.children.map(c => row(c, 4)) : [])]
    }

    const items = (sec: Section<Item>, key: string) => [
      ...sec.shown.map(i => row(i)),
      ...(unfolded.includes(`more:${key}`) ? sec.rest.map(i => row(i)) : []),
      more(`more:${key}`, `▸ ещё ${sec.rest.length}`, sec.rest.length),
    ]

    const block = (title: string, body: RenderChildren[]) =>
      body.every(b => b === null) ? null : (
        <Box key={title} flexDirection="column" marginTop={1}>
          <Text bold>{title}</Text>
          {body}
        </Box>
      )

    const taskRows = [
      ...v.tasks.shown.flatMap(taskRow),
      ...(unfolded.includes('more:tasks') ? v.tasks.rest.flatMap(taskRow) : []),
      more('more:tasks', `▸ ещё ${v.tasks.rest.length}`, v.tasks.rest.length),
      ...(unfolded.includes('closed') ? v.closed.flatMap(taskRow) : []),
      more('closed', `▸ закрытые: ${v.closed.length}`, v.closed.length),
    ]

    return (
      <Box flexDirection="column">
        {restart === '' ? null : <Text dimColor wrap="wrap">перезапуск: {restart}</Text>}
        {panel.items.length === 0 ? <Text dimColor>Пока пусто: ссылки и итоги из ответов появятся здесь.</Text> : null}
        {block('Задачи', taskRows)}
        {block('Ссылки', items(v.links, 'links'))}
        {block('Заметки', items(v.notes, 'notes'))}
        {block('Сделано', items(v.done, 'done'))}
        {Input === null ? null : (
          <Box marginTop={1}>
            <Input
              key={`add-${addRound}`}
              placeholder="+ строка или ссылка"
              submitLabel="добавить"
              onSubmit={async (value: string) => {
                addRound++
                await change($, p => addOwnerLine(p, value, pattern))
              }}
            />
          </Box>
        )}
      </Box>
    )
  })
}
