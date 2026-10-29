import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { cardTitle, idOfFile, mentionedIds } from '../hooks/cards'
import { FRESH_REPLIES, taskRegex } from '../hooks/logic'
import type { Panel } from '../types'

const SID = 'sess-tasks'
// The project reaches the cards through a folder linked into the vault; epics are folders of their tasks.
const CARDS = '/home/fake/proj/brain/tasks'
const VAULT = '/home/fake/mind'
const REAL = `${VAULT}/proj/tasks`
const OPTIONS = { cardsDir: CARDS, vault: VAULT, linkRoots: [], doneStatuses: ['Done', 'Verified by Owner'] }

const card = (id: string, title: string, status: string) => `---\nkind: task\nid: ${id}\ntitle: "${title}"\nstatus: ${status}\nparent: PH-161\n---\n\nbody\n`

type Node = { kind: 'file' | 'dir'; text?: string }
type World = { store: Map<string, unknown>; disk: Map<string, Node>; lists: number; clock: ReturnType<typeof mock.clock> }

function world(on: On): World {
  const w: World = { store: new Map(), disk: new Map(), lists: 0, clock: mock.clock(on, { now: 1_000 }) }
  const put = (rel: string, node: Node) => w.disk.set(rel === '' ? CARDS : `${CARDS}/${rel}`, node)
  put('', { kind: 'dir' })
  put('PH-161 Редизайн списков', { kind: 'dir' })
  put('PH-161 Редизайн списков/PH-197.md', { kind: 'file', text: card('PH-197', '«Товари постачальника»: все строки по умолчанию, свои книги сверху', 'In Progress') })
  put('PH-161 Редизайн списков/PH-198.md', { kind: 'file', text: card('PH-198', 'Книга в строке — обложка, звезда, метки', 'Done') })
  put('PH-174 Ячейки склада', { kind: 'dir' })
  put('PH-174 Ячейки склада/PH-199.md', { kind: 'file', text: card('PH-199', 'Ячейки: выбрать книги галочками — перенести или снять', 'Review') })
  put('PH-174 Ячейки склада/PH-174.md', { kind: 'file', text: card('PH-174', 'Ячейки склада', 'In Progress') })
  put('KM-4.md', { kind: 'file', text: card('KM-4', 'Редиректы со старых адресов книг', 'Verified by Owner') })
  put('img', { kind: 'dir' })
  put('img/PH-197 screen.png', { kind: 'file' })

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
  on('fs.list', (_$, e) => {
    w.lists++
    const dir = e.path.replace(/\/+$/, '')
    if (w.disk.get(dir)?.kind !== 'dir') return { deny: `ENOENT ${e.path}` }
    const entries = [...w.disk]
      .filter(([p]) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
      .map(([p, n]) => ({ name: p.slice(dir.length + 1), kind: n.kind, size: 1, mtimeMs: 0, isLink: false }))
    return { value: entries }
  })
  on('fs.read', (_$, e) => {
    const text = w.disk.get(e.path)?.text
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.stat', (_$, e) => {
    const real = (p: string) => (p.startsWith(CARDS) ? `${REAL}${p.slice(CARDS.length)}` : p)
    const node = e.path === VAULT ? { kind: 'dir' as const } : w.disk.get(e.path)
    return node === undefined
      ? { deny: `ENOENT ${e.path}` }
      : { value: { kind: node.kind, size: 1, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: real(e.path) } : {}) } }
  })
  on('process.run', () => ({ deny: 'not here' }))
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
const stored = (w: World) => w.store.get(`panel:${SID}`) as Panel
const PANE = { plugin: 'session-panel', component: 'Pane', requestId: 'session-panel', surface: 'terminal', props: { title: 'Сессия', isFocused: true, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } } as const

/** The task rows as drawn, top to bottom: one line each, the id first. */
async function taskLines($: Engine): Promise<string[]> {
  const ui = await $.ui.mount(PANE)
  const all = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  // A mounted Link's text is its address followed by its label: the row reads from the label on.
  const lines = all.map(t => t.text.replace(/^obsidian:\/\/\S*?(?=(?:PH|KM)-\d+ )/, '')).filter(t => /^(?:PH|KM)-\d+ /.test(t))
  return [...new Set(lines)]
}

const PH197 = 'PH-197  ⚙ в работе  «Товари постачальника»: все строки по умолчанию, свои книги сверху'
const PH199 = 'PH-199  👀 ждёт ревью  Ячейки: выбрать книги галочками — перенести или снять'

describe('a task named in a reply', () => {

  test('gets a row with its card status and title, however deep its card sits, opening the card', { options: OPTIONS }, async ($, on) => {
    world(on)
    await start($)
    await reply($, 'Закрыл ревью по PH-197, дальше `PH-199`. Кодировка UTF-8, хэш SHA-256.\n\n```\nbc3ec631 PH-150: старый коммит\n```')
    expect(await taskLines($)).toEqual([PH197, PH199])
    const ui = await $.ui.mount(PANE)
    const links = await ui.findAll({ type: 'Link' })
    const note = encodeURIComponent('proj/tasks/PH-161 Редизайн списков/PH-197')
    expect(links.some(l => l.props.href === `obsidian://open?vault=mind&file=${note}` && /PH-197$/.test(l.text))).toBe(true)
    await ui.unmount()
  })

  test('the task named most recently comes first; one named in no reply yet is not there', { options: OPTIONS }, async ($, on) => {
    world(on)
    await start($)
    await reply($, 'PH-197 и PH-199 в работе')
    await reply($, 'Вернулся к PH-199: галочки')
    expect(await taskLines($)).toEqual([PH199, PH197])
  })

  test('a done or accepted task sinks below the open ones, and folds once replies move on', { options: OPTIONS }, async ($, on) => {
    world(on)
    await start($)
    await reply($, 'KM-4 принят, PH-198 влит, PH-197 в работе')
    expect(await taskLines($)).toEqual([
      PH197,
      'KM-4  ✅ принято  Редиректы со старых адресов книг',
      'PH-198  ✅ готово  Книга в строке — обложка, звезда, метки',
    ])
    for (let n = 0; n < FRESH_REPLIES; n++) await reply($, n === FRESH_REPLIES - 1 ? 'PH-197 дальше' : 'ок')
    expect(await taskLines($)).toEqual([PH197])
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ text: /▸ закрытые: 2/ })).toBeDefined()
    await ui.unmount()
  })

  test('the list outlives a reload and a compaction: it is the session’s, kept in the store', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await start($)
    await reply($, 'PH-197')
    expect(stored(w).mentioned).toEqual([{ task: 'PH-197', seen: 1 }])
    await start($)
    expect(await taskLines($)).toEqual([PH197])
  })

  test('a card made after the session started is found by one more walk', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await start($)
    w.disk.set(`${CARDS}/PH-174 Ячейки склада/PH-200.md`, { kind: 'file', text: card('PH-200', 'Новая задача', 'To Do') })
    await w.clock.advance(31_000)
    await reply($, 'Завёл PH-200')
    expect(await taskLines($)).toEqual(['PH-200  📋 к работе  Новая задача'])
  })

  test('ids no card stands behind never walk the folder on every reply', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await start($)
    const walked = w.lists
    await w.clock.advance(31_000)
    await reply($, 'ISO-8601 и UTF-8')
    await w.clock.advance(31_000)
    await reply($, 'UTF-8 снова')
    expect(w.lists).toBe(walked)
    expect(stored(w).mentioned ?? []).toEqual([])
  })

  test('✕ hides a task named in passing until a reply names it again', { options: OPTIONS }, async ($, on) => {
    world(on)
    await start($)
    await reply($, 'PH-197 и PH-199')
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'hx-PH-199' })
    await ui.unmount()
    expect(await taskLines($)).toEqual([PH197])
    await reply($, 'Снова PH-199')
    expect(await taskLines($)).toEqual([PH199, PH197])
  })
})

describe('the card', () => {
  test('its title is read as YAML writes it, one bounded line', () => {
    expect(cardTitle('---\nid: PH-1\ntitle: "Сказал \\"да\\" — и всё"\n---\n')).toBe('Сказал "да" — и всё')
    expect(cardTitle("---\ntitle: 'It''s here'\n---\n")).toBe("It's here")
    expect(cardTitle('---\ntitle: Bare words # note\n---\n')).toBe('Bare words')
    expect(cardTitle('no frontmatter\ntitle: x')).toBeUndefined()
    expect(cardTitle(`---\ntitle: "${'я'.repeat(400)}"\n---\n`)!.length).toBe(160)
  })

  test('a file is a card only when its whole name is a task id', () => {
    const re = taskRegex(undefined)
    expect(idOfFile('PH-197.md', re)).toBe('PH-197')
    expect(idOfFile('PH-1 Схема БД по фазам.md', re)).toBeUndefined()
    expect(idOfFile('PH-197 screen.png', re)).toBeUndefined()
  })

  test('ids are taken in the order the reply names them, outside fenced blocks', () => {
    expect(mentionedIds('PH-2, `PH-1`, PH-2\n```\nPH-3\n```\nKM-4', taskRegex(undefined))).toEqual(['PH-2', 'PH-1', 'KM-4'])
  })
})
