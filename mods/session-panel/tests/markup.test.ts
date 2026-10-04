import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { capture, emptyPanel, merge, taskRegex } from '../hooks/logic'
import { plain, runs, withLead } from '../hooks/markup'
import type { Run } from '../hooks/markup'
import type { Panel } from '../types'

// The «Сделано» lines of a real panel, as replies' `result:` lines wrote them.
const DONE = [
  'ID для respawn: coder — `549ced52`, orchestration — `05d4c69d`; фоновую сессию перезапускает только `claude respawn <id задачи>` (или `--all`), `/exit` её не перезапускает',
  'в панели сессии включён перенос длинных строк, шапка показывает готовую команду перезапуска сессии; ID для respawn: coder `549ced52`, orchestration `05d4c69d`; чтобы увидеть фикс здесь — `claude respawn 5c2ac763`',
  'мод прогрева кэша `/warm` собран и подключён (2 ч по умолчанию, окно и режим задаются для каждой сессии); в уже запущенных фоновых сессиях заработает после `claude respawn`',
  '`/warm` теперь принимает окно в часах и минутах вместе (`1h 30m`, `90m`, `1ч 30мин`) и так же его показывает; kit 74c9268 запушен',
  'сделал глобального агента `mod-builder`: просьба «поправь/сделай мод» из любой сессии уходит ему в фон, он сам пишет код и тесты, проверяет, коммитит и говорит, какие сессии перезапустить (kit b40f819)',
  'Агент mod-builder теперь учится и на упавших проверках, и на твоих замечаниях про моды (хук `mod-remark-capture`); в instructions-tuning 1.5.0 взяты практики из skill-creator и добавлен хук-валидатор frontmatter. Всё в ките: d0c697d, fc31674.',
]

const lead = (list: Run[]) => list.filter(r => r.bold === true).map(r => r.text).join('')

describe('a line is drawn, not shown raw', () => {
  test('no backtick survives on the real lines; each code span is its own run, its text whole', () => {
    for (const line of DONE) {
      const list = runs(line)
      expect(list.some(r => r.text.includes('`'))).toBe(false)
      const spans = [...line.matchAll(/`([^`]+)`/g)].map(m => m[1])
      expect(list.filter(r => r.code === true).map(r => r.text)).toEqual(spans)
      // Nothing is lost but the marks.
      expect(plain(line)).toBe(line.replace(/`/g, ''))
    }
  })

  test('the lead of each real line, up to its first clause break, is bold', () => {
    expect(DONE.map(l => lead(withLead(runs(l))))).toEqual([
      'ID для respawn',
      'в панели сессии включён перенос длинных строк',
      'мод прогрева кэша /warm собран и подключён',
      '/warm теперь принимает окно в часах и минутах вместе',
      'сделал глобального агента mod-builder',
      'Агент mod-builder теперь учится и на упавших проверках',
    ])
  })

  test('a break inside code does not end the lead; a too-short or too-late break gives none', () => {
    expect(lead(withLead(runs('стенд `https://a.b: x, y` поднят: всё ок')))).toBe('стенд https://a.b: x, y поднят')
    expect(lead(withLead(runs('Да, это короткое начало, а дальше длинный хвост строки')))).toBe('Да, это короткое начало')
    expect(lead(withLead(runs('PH-95 переводы названий собраны и задеплоены')))).toBe('')
    expect(lead(withLead(runs(`${'слово '.repeat(16)}и потом: хвост`)))).toBe('')
  })

  test('**bold**, *italic* and a link; an unpaired ** is dropped, a lone * stays', () => {
    expect(runs('собран **мод `/warm`** и *проверен*')).toEqual([
      { text: 'собран ' },
      { text: 'мод ', bold: true },
      { text: '/warm', code: true, bold: true },
      { text: ' и ' },
      { text: 'проверен', italic: true },
    ])
    expect(plain('итог** готов')).toBe('итог готов')
    expect(plain('2 * 3 = 6 и snake*case')).toBe('2 * 3 = 6 и snake*case')
    expect(runs('см. [PR **#41**](https://github.com/a/b/pull/41) ок')).toEqual([
      { text: 'см. ' },
      { text: 'PR #41', href: 'https://github.com/a/b/pull/41' },
      { text: ' ок' },
    ])
  })
})

describe('capture keeps the marks it can draw', () => {
  test('a wrapped result loses its stray **, paired marks and code stay; a repeat with marks adds nothing', () => {
    const got = capture('**result: собран мод**\n\nresult: **мод** `/warm` собран')
    expect(got.results).toEqual(['собран мод', '**мод** `/warm` собран'])
    const p = merge(emptyPanel(0), { links: [], results: ['мод /warm собран'] }, taskRegex(undefined))
    expect(merge(p, { links: [], results: ['мод `/warm` собран'] }, taskRegex(undefined))).toBe(p)
  })

  test('a link label keeps its code span; a URL in code is still an example, not a place', () => {
    const got = capture('[доки `/warm`](https://example.com/warm) и пример `https://example.com/x`')
    expect(got.links).toEqual([{ href: 'https://example.com/warm', label: 'доки `/warm`' }])
  })
})

// ---- the pane, on the surfaces the owner uses ----

const SID = 'sess-1'
const PANE = { plugin: 'session-panel', component: 'Pane', requestId: 'session-panel', props: { title: 'Сессия', isFocused: true, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

function world(on: On, panel: Panel): Map<string, unknown> {
  const store = new Map<string, unknown>([[`panel:${SID}`, panel]])
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  mock.clock(on, { now: 1_000 })
  on('session.id', () => ({ value: SID }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__session-panel__${e.name}` } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { opened: true } }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return store
}

const start = ($: Engine) => $.session.start({ cwd: '/home/fake/proj', surface: 'terminal', isInteractive: true })

describe('the pane', () => {
  // A panel stored before this change holds raw text: it is drawn formatted with no migration.
  const STORED: Panel = {
    ...emptyPanel(1_000),
    seq: 3,
    items: [
      { id: 'i1', kind: 'done', text: DONE[0]!, checked: true, by: 'auto' },
      { id: 'i2', kind: 'link', text: 'доки `/warm`', href: 'https://example.com/warm', checked: false, by: 'auto' },
      { id: 'i3', kind: 'link', text: 'доска сессии', href: 'obsidian://open?vault=v&file=board', checked: false, by: 'auto' },
    ],
  }

  test('a stored raw line draws without backticks, its code coloured and its lead bold, on every surface', async ($, on) => {
    world(on, STORED)
    await start($)
    for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.drawn()
      const texts = await ui.findAll({ type: 'Text' })
      expect(texts.some(t => t.children.some(c => typeof c === 'string' && c.includes('`')))).toBe(false)
      // The innermost run is the one whose whole text is the span.
      const run = async (text: string) => (await ui.findAll({ type: 'Text', text })).find(t => t.text === text)?.props
      expect(await run('549ced52')).toMatchObject({ color: 'permission' })
      expect(await run('ID для respawn')).toMatchObject({ bold: true })
      expect(await run('/warm')).toMatchObject({ color: 'permission' })
      expect(await ui.find({ type: 'Link', text: /доки \/warm/ })).toBeDefined()
      // The terminal makes an OSC 8 link of any scheme; a remote surface draws an obsidian:// one as its text.
      expect(await ui.find({ type: surface === 'terminal' ? 'Link' : undefined, text: /доска сессии/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('editing a line shows and keeps the raw text the owner typed', async ($, on) => {
    const store = world(on, STORED)
    await start($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'e-i1' })
    expect((await ui.find({ key: 'edit-i1' }))?.props.value).toBe(DONE[0])
    await ui.input({ key: 'edit-i1', text: 'перезапуск: `claude respawn ab12`' })
    await ui.unmount()
    expect((store.get(`panel:${SID}`) as Panel).items[0]!.text).toBe('перезапуск: `claude respawn ab12`')
  })
})
