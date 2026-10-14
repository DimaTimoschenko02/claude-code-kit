import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { FRESH_REPLIES, SECTION_CAP, emptyPanel, merge, nextTurn, normalize, view } from '../hooks/logic'
import { cardBadge, cardStatus, parsePr, prBadge, pullOf } from '../hooks/status'
import type { Panel, Pr } from '../types'
import { taskRegex } from '../hooks/logic'

const SID = 'sess-fresh'
const CARDS = '/home/fake/vault/tasks'
const OPTIONS = { cardsDir: CARDS, doneStatuses: ['Done', 'Verified by Owner'] }
const RE = taskRegex(undefined)
const PR = (n: number) => `https://github.com/acme/app/pull/${n}`
const NONE = { statuses: {}, prs: {}, doneStatuses: ['Done'] }

/** `n` replies, each carrying the given links. */
function replies(p: Panel, n: number, links: { href: string; label: string }[] = [], results: string[] = []): Panel {
  let next = p
  for (let k = 0; k < n; k++) next = merge(nextTurn(next), { links, results }, RE)
  return next
}

const ghJson = (o: Record<string, unknown>) =>
  JSON.stringify({ state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', isDraft: false, baseRefName: 'main', mergedAt: null, ...o })
const pr = (o: Partial<Pr>): Pr => ({ state: 'OPEN', review: '', draft: false, base: 'main', at: 0, ...o })

describe('freshness by work', () => {
  test('a link a later reply carries again is seen in that reply; a repeated result too', () => {
    const link = { href: PR(171), label: 'PR PH-120' }
    let p = replies(emptyPanel(0), 1, [link], ['PH-120 схема согласована'])
    expect(p.items.map(i => i.seen)).toEqual([1, 1])
    p = replies(p, 9)
    p = replies(p, 1, [link], ['PH-120 схема **согласована**'])
    expect(p.items).toHaveLength(2)
    expect(p.items.map(i => i.seen)).toEqual([11, 11])
    // The same reply carrying it twice changes nothing more.
    expect(merge(p, { links: [link], results: [] }, RE)).toBe(p)
  })

  test(`a line stays fresh for ${FRESH_REPLIES} replies of work and then folds, however long the night between`, () => {
    let p = replies(emptyPanel(0), 1, [{ href: 'https://stand.example.com/a', label: 'стенд' }])
    p = replies(p, FRESH_REPLIES - 1)
    expect(view(p, NONE).links.shown).toHaveLength(1)
    p = replies(p, 1)
    expect(view(p, NONE).links).toMatchObject({ shown: [], rest: [{ text: 'стенд' }] })
  })

  test(`a section shows its ${SECTION_CAP} newest fresh lines, the rest behind one line; a ticked link is old at once`, () => {
    let p = emptyPanel(0)
    for (let n = 1; n <= 8; n++) p = replies(p, 1, [{ href: `https://stand.example.com/${n}`, label: `l${n}` }])
    const v = view(p, NONE)
    expect(v.links.shown.map(i => i.text)).toEqual(['l8', 'l7', 'l6', 'l5', 'l4'])
    expect(v.links.rest.map(i => i.text)).toEqual(['l3', 'l2', 'l1'])
    const ticked = { ...p, items: p.items.map(i => (i.text === 'l8' ? { ...i, checked: true } : i)) }
    expect(view(ticked, NONE).links.shown.map(i => i.text)).toEqual(['l7', 'l6', 'l5', 'l4', 'l3'])
  })

  test("the owner's own unticked notes never fold, however old; ticked, they fold like any line", () => {
    const old: Panel = {
      ...emptyPanel(0),
      seq: 2,
      items: [
        { id: 'i1', kind: 'note', text: 'позвонить поставщику', checked: false, by: 'owner' },
        { id: 'i2', kind: 'note', text: 'модель записала', checked: false, by: 'tool', seen: 0 },
      ],
    }
    const later = replies(old, 40)
    expect(view(later, NONE).notes).toMatchObject({ shown: [{ id: 'i1' }], rest: [{ id: 'i2' }] })
    const done = { ...later, items: later.items.map(i => ({ ...i, checked: true })) }
    expect(view(done, NONE).notes.shown).toEqual([])
  })

  test('a panel stored before replies were counted loads with every line old; the next reply starts the count', () => {
    const stored = { items: [{ id: 'i1', kind: 'link', text: 'PR #12', href: PR(12), checked: false, by: 'auto' }], dropped: [], report: [], seq: 1, at: 5 }
    const p = normalize(stored as unknown as Panel)
    expect(p.turn).toBe(0)
    expect(view(p, NONE).links).toMatchObject({ shown: [], rest: [{ id: 'i1' }] })
    const again = replies(p, 1, [{ href: PR(12), label: 'PR #12' }])
    expect(view(again, NONE).links.shown.map(i => i.id)).toEqual(['i1'])
  })
})

describe('task rows', () => {
  test('a card status reads as a short badge; an unknown one is shown as written, dim', () => {
    const map = ['Backlog', 'To Do', 'In Progress', 'Review', 'Testing', 'Done', 'Verified by Owner', 'Blocked'].map(s => cardBadge(s).text)
    expect(map).toEqual(['💤 бэклог', '📋 к работе', '⚙ в работе', '👀 ждёт ревью', '🧪 на стенде', '✅ готово', '✅ принято', 'Blocked'])
    expect(cardBadge('Blocked').dim).toBe(true)
    expect(cardBadge('Review').color).toBe('warning')
    expect(cardStatus('---\nname: PH-120\nstatus: "In Progress"\n---\nbody')).toBe('In Progress')
    expect(cardStatus('no frontmatter\nstatus: Done')).toBeUndefined()
  })

  test('gh says merged with its base branch, approved, waiting, draft, changes asked or closed', () => {
    const b = (o: Record<string, unknown>) => prBadge(parsePr(ghJson(o), 0)!).text
    expect(b({ state: 'MERGED', baseRefName: 'dev', mergedAt: '2026-10-14T09:00:00Z' })).toBe('→ dev')
    expect(b({ reviewDecision: 'APPROVED' })).toBe('апрув')
    expect(b({})).toBe('ждёт ревью')
    expect(b({ reviewDecision: '' })).toBe('ждёт ревью')
    expect(b({ isDraft: true })).toBe('черновик')
    expect(b({ reviewDecision: 'CHANGES_REQUESTED' })).toBe('правки')
    expect(b({ state: 'CLOSED' })).toBe('закрыт')
    expect(parsePr('gh: not logged in', 0)).toBeNull()
    expect(parsePr('{"state":"WEIRD"}', 0)).toBeNull()
  })

  test('only a GitHub pull request address with plain names reaches gh', () => {
    expect(pullOf(`${PR(171)}/files#diff`)).toEqual({ repo: 'acme/app', number: '171', key: 'acme/app#171' })
    expect(pullOf('https://gitlab.example.com/acme/app/-/merge_requests/580')).toBeUndefined()
    expect(pullOf('https://github.com/-x/app/pull/1')).toBeUndefined()
    expect(pullOf('https://github.com/acme/../pull/1')).toBeUndefined()
    expect(pullOf('https://github.com/acme/app/pull/1;rm')).toBeUndefined()
  })

  test('open tasks first, most recently worked first; a closed one stays at the bottom while fresh, then folds', () => {
    let p = emptyPanel(0)
    p = replies(p, 1, [{ href: PR(1), label: 'PR PH-1' }])
    p = replies(p, 1, [{ href: PR(2), label: 'PR PH-2' }])
    p = replies(p, 1, [{ href: PR(3), label: 'PR PH-3' }])
    p = replies(p, 1, [{ href: PR(4), label: 'PR PH-4' }])
    // A result naming PH-1 is work on PH-1: it moves to the top.
    p = replies(p, 1, [], ['PH-1 ревью пройдено'])
    const prs = { 'acme/app#3': pr({ state: 'MERGED' }), 'acme/app#4': pr({ state: 'MERGED' }) }
    // PH-4: merged, no card status → closed. PH-3: merged, but its card still says In Progress → open.
    const v = view(p, { statuses: { 'PH-3': 'In Progress', 'PH-2': 'Done' }, prs, doneStatuses: ['Done'] })
    expect(v.tasks.shown.map(t => [t.task, t.closed])).toEqual([['PH-1', false], ['PH-3', false], ['PH-4', true], ['PH-2', true]])
    const later = view(replies(p, FRESH_REPLIES), { statuses: { 'PH-3': 'In Progress', 'PH-2': 'Done' }, prs, doneStatuses: ['Done'] })
    expect(later.tasks.shown).toEqual([])
    expect(later.tasks.rest.map(t => t.task)).toEqual(['PH-1', 'PH-3'])
    expect(later.closed.map(t => t.task)).toEqual(['PH-4', 'PH-2'])
  })
})

type World = { store: Map<string, unknown>; files: Map<string, string>; gh: string[][]; answers: Map<string, string>; clock: MockClock; noGh: boolean }

function world(on: On): World {
  const w: World = { store: new Map(), files: new Map(), gh: [], answers: new Map(), clock: mock.clock(on, { now: 1_000 }), noGh: false }
  on('store.get', (_$, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_$, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('session.id', () => ({ value: SID }))
  on('fs.read', (_$, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('process.run', (_$, e) => {
    if (!e.argv[0]!.endsWith('gh')) return { deny: 'not here' }
    w.gh.push([...e.argv])
    if (w.noGh) return { deny: `spawn ${e.argv[0]} ENOENT` }
    const out = w.answers.get(e.argv[3]!)
    return { value: { exitCode: out === undefined ? 1 : 0, stdout: out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__session-panel__${e.name}` } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { opened: true } }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return w
}

const start = ($: Engine) => $.session.start({ cwd: '/home/fake/proj', surface: 'terminal', isInteractive: true })
const reply = ($: Engine, answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
const PANE = { plugin: 'session-panel', component: 'Pane', requestId: 'session-panel', surface: 'terminal', props: { title: 'Сессия', isFocused: true, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const
const linkTo = (l: { text: string; props: Record<string, unknown> }, label: string) => l.text === `${String(l.props.href)}${label}`

describe('the pane', () => {
  test('a task row shows its card status and its PR state, the PR number a link; the links under it stay folded', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    // No reply linked PH-120's card; its status still comes from the card file.
    w.files.set(`${CARDS}/PH-120.md`, '---\nname: PH-120\nstatus: Review\n---\n')
    w.answers.set('171', ghJson({ reviewDecision: 'APPROVED' }))
    w.answers.set('170', ghJson({ state: 'MERGED', baseRefName: 'main' }))
    await start($)
    await reply($, `Готово: [PR PH-120](${PR(171)}), до этого [PH-120 миграция](${PR(170)}), схема https://github.com/acme/app/blob/main/docs/PH-120-schema.md\n\nresult: PH-120 API отдаёт теги`)
    await w.clock.settle()
    expect(w.gh.map(a => a.join(' '))).toEqual([
      'gh pr view 171 --repo acme/app --json state,reviewDecision,isDraft,baseRefName,mergedAt',
      'gh pr view 170 --repo acme/app --json state,reviewDecision,isDraft,baseRefName,mergedAt',
    ])
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ type: 'Text', text: /👀 ждёт ревью/ })).toBeDefined()
    const links = await ui.findAll({ type: 'Link' })
    expect(links.some(l => linkTo(l, 'PR #171') && l.props.href === PR(171))).toBe(true)
    expect(await ui.find({ type: 'Text', text: /^ апрув$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ → main$/ })).toBeDefined()
    expect(await ui.find({ text: /PH-120-schema/ })).toBeUndefined()
    await ui.press({ key: 'f-PH-120' })
    expect(await ui.find({ text: /PH-120-schema/ })).toBeDefined()
    await ui.unmount()
  })

  test('gh is asked again for an open PR only after a minute, never again for a merged one; a failure draws no badge', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    w.answers.set('171', ghJson({}))
    w.answers.set('170', ghJson({ state: 'MERGED' }))
    await start($)
    await reply($, `[PR PH-120](${PR(171)}) и [PR PH-121](${PR(170)}) и [PR PH-122](${PR(169)})`)
    await w.clock.settle()
    expect(w.gh.map(a => a[3])).toEqual(['171', '170', '169'])
    await reply($, 'ещё ответ')
    await w.clock.settle()
    expect(w.gh).toHaveLength(3)
    await w.clock.advance(61_000)
    await reply($, 'через минуту')
    await w.clock.settle()
    expect(w.gh.map(a => a[3])).toEqual(['171', '170', '169', '171', '169'])
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ type: 'Text', text: /^ ждёт ревью$/ })).toBeDefined()
    const rows = await ui.findAll({ type: 'Text', text: /PH-122/ })
    expect(rows.length).toBeGreaterThan(0)
    expect(await ui.find({ type: 'Link', text: /PR #169/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a pull request linked inside a «Ждёт тебя» line is asked and carries its state after the link', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    w.answers.set('119', ghJson({ reviewDecision: 'APPROVED' }))
    await start($)
    await reply($, `**Ждёт тебя** — ревью по порядку:\n\n1. [#119](${PR(119)}) — шаг 3 аудита.`)
    await w.clock.settle()
    expect(w.gh.map(a => a[3])).toEqual(['119'])
    const ui = await $.ui.mount(PANE)
    // Once after the link in the «Ждёт тебя» line, once on the PR's own row in «Ссылки».
    expect(await ui.findAll({ type: 'Text', text: /^ апрув$/ })).toHaveLength(2)
    await ui.unmount()
  })

  test('without gh the usual places are tried once, then no badge and no more tries; the pane still draws', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    w.noGh = true
    await start($)
    await w.clock.settle()
    await reply($, `[PR PH-120](${PR(171)}) и [PR PH-121](${PR(170)})`)
    await w.clock.settle()
    expect(w.gh.map(a => a[0])).toEqual(['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'])
    await reply($, 'ещё')
    await w.clock.settle()
    expect(w.gh).toHaveLength(3)
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ text: /PH-121/ })).toBeDefined()
    expect(await ui.find({ text: /ждёт ревью/ })).toBeUndefined()
    await ui.unmount()
  })

  test('folded lines unfold in place under «ещё N» and fold back; a stored panel loads with its lines folded', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    const items = Array.from({ length: 7 }, (_, n) => ({ id: `i${n + 1}`, kind: 'done', text: `итог ${n + 1}`, checked: true, by: 'auto' }))
    w.store.set(`panel:${SID}`, { items, dropped: [], report: [], seq: 7, at: 1_000 })
    await start($)
    await reply($, 'result: свежий итог')
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ text: /итог 3/ })).toBeUndefined()
    expect((await ui.find({ key: 'more-more:done' }))?.props.label).toBe('▸ ещё 7')
    await ui.press({ key: 'more-more:done' })
    expect(await ui.find({ text: /итог 3/ })).toBeDefined()
    expect((await ui.find({ key: 'more-more:done' }))?.props.label).toBe('▾ свернуть')
    await ui.press({ key: 'more-more:done' })
    expect(await ui.find({ text: /итог 3/ })).toBeUndefined()
    await ui.unmount()
    expect((w.store.get(`panel:${SID}`) as Panel).turn).toBe(1)
  })
})
