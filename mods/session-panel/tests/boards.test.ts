import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { cardBadge, cardStatus } from '../hooks/status'
import { FRESH_REPLIES } from '../hooks/logic'
import { fixturePath } from './fixture-path'

// Two boards: a project's cards, reached through a folder linked into the vault, and the vault's own boards of the
// other projects (`01 projects/tasks/<project>/<epic>/<ID>.md`, statuses idea/active/paused/done/dropped).
const SID = 'sess-boards'
const HOME = '/home/fake'
const VAULT = `${HOME}/mind`
const PROJECT = `${HOME}/proj/brain/tasks`
const PROJECT_REAL = `${VAULT}/01 projects/proj/tasks`
const BOARDS = `${VAULT}/01 projects/tasks`
const OPTIONS = {
  cardsDir: [PROJECT, '~/mind/01 projects/tasks'],
  vault: '~/mind',
  linkRoots: [],
  doneStatuses: ['Done', 'dropped'],
}

const card = (id: string, title: string, status: string) => `---\nkind: task\nid: ${id}\ntitle: "${title}"\nstatus: ${status}\n---\n\n# ${id}\n`

type Node = { kind: 'file' | 'dir'; text?: string }

function world(on: On): { store: Map<string, unknown>; disk: Map<string, Node> } {
  const store = new Map<string, unknown>()
  const disk = new Map<string, Node>()
  const dir = (p: string) => disk.set(p, { kind: 'dir' })
  const file = (p: string, text: string) => disk.set(p, { kind: 'file', text })
  for (const d of [VAULT, `${VAULT}/01 projects`, PROJECT, BOARDS, `${BOARDS}/мозг`, `${BOARDS}/мозг/agent-infra`, `${BOARDS}/фабрика`]) dir(d)
  file(`${PROJECT}/PH-197.md`, card('PH-197', 'Товари постачальника', 'In Progress'))
  file(`${BOARDS}/мозг.md`, '---\nkind: project\n---\n')
  file(`${BOARDS}/мозг/agent-infra/MIND-80.md`, card('MIND-80', 'Доска сессии видит задачи всех проектов', 'active        # active | paused | done'))
  file(`${BOARDS}/мозг/agent-infra/MIND-81.md`, card('MIND-81', 'Идея на потом', 'idea'))
  file(`${BOARDS}/фабрика/FAB-3.md`, card('FAB-3', 'Старый план фабрики', 'dropped'))

  mock.env(on, { HOME })
  mock.clock(on, { now: 1_000 })
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
  on('session.id', () => ({ value: SID }))
  on('fs.list', (_$, e) => {
    const at = fixturePath(e.path).replace(/\/+$/, '')
    if (disk.get(at)?.kind !== 'dir') return { deny: `ENOENT ${e.path}` }
    const entries = [...disk]
      .filter(([p]) => p.startsWith(`${at}/`) && !p.slice(at.length + 1).includes('/'))
      .map(([p, n]) => ({ name: p.slice(at.length + 1), kind: n.kind, size: 1, mtimeMs: 0, isLink: false }))
    return { value: entries }
  })
  on('fs.read', (_$, e) => {
    const text = disk.get(fixturePath(e.path))?.text
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.stat', (_$, raw) => {
    const path = fixturePath(raw.path)
    const real = path.startsWith(PROJECT) ? `${PROJECT_REAL}${path.slice(PROJECT.length)}` : path
    const node = disk.get(path)
    return node === undefined
      ? { deny: `ENOENT ${raw.path}` }
      : { value: { kind: node.kind, size: 1, mtimeMs: 0, isLink: false, ...(raw.resolve ? { realPath: real } : {}) } }
  })
  on('process.run', () => ({ deny: 'not here' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__session-panel__${e.name}` } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { opened: true } }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return { store, disk }
}

const start = ($: Engine) => $.session.start({ cwd: `${HOME}/proj`, surface: 'terminal', isInteractive: true })
const reply = ($: Engine, answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
const PANE = { plugin: 'session-panel', component: 'Pane', requestId: 'session-panel', surface: 'terminal', props: { title: 'Сессия', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } } as const
const note = (...segments: string[]) => `obsidian://vault/mind/${segments.map(encodeURIComponent).join('/')}`

/** The task rows as drawn, top to bottom (a mounted Link's text is its address before its label: cut off), and every link. */
async function drawn($: Engine): Promise<{ rows: string[]; links: { href: string; label: string }[] }> {
  const ui = await $.ui.mount(PANE)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text.replace(/^obsidian:\/\/\S*?(?=[A-Z]{2,}-\d+ )/, ''))
  const links = (await ui.findAll({ type: 'Link' })).map(l => {
    const href = String(l.props.href)
    return { href, label: l.text.startsWith(href) ? l.text.slice(href.length) : l.text }
  })
  await ui.unmount()
  return { rows: [...new Set(texts.filter(t => /^[A-Z]{2,}-\d+ /.test(t)))], links }
}

describe('tasks of every board in the vault', () => {
  test('a task only named in a reply gets its row from whichever board holds its card: link, status, title', { options: OPTIONS }, async ($, on) => {
    world(on)
    await start($)
    await reply($, 'Чиню MIND-80, заодно PH-197.')
    const { rows, links } = await drawn($)
    expect(rows).toEqual(['MIND-80  ⚙ в работе  Доска сессии видит задачи всех проектов', 'PH-197  ⚙ в работе  Товари постачальника'])
    expect(links).toContainEqual({ href: note('01 projects', 'tasks', 'мозг', 'agent-infra', 'MIND-80'), label: 'MIND-80' })
    expect(links).toContainEqual({ href: note('01 projects', 'proj', 'tasks', 'PH-197'), label: 'PH-197' })
  })

  test('a task a result line names is a row with its card behind it too', { options: OPTIONS }, async ($, on) => {
    world(on)
    await start($)
    await reply($, 'Готово.\n\nresult: MIND-81 — записал идею в карточку')
    const { rows, links } = await drawn($)
    expect(rows).toContain('MIND-81  💡 идея  Идея на потом')
    expect(links.map(l => l.href)).toContain(note('01 projects', 'tasks', 'мозг', 'agent-infra', 'MIND-81'))
  })

  test('a dropped vault task closes like a done one: below the open, folded once replies move on', { options: OPTIONS }, async ($, on) => {
    world(on)
    await start($)
    await reply($, 'FAB-3 отменили, MIND-80 в работе')
    expect((await drawn($)).rows).toEqual(['MIND-80  ⚙ в работе  Доска сессии видит задачи всех проектов', 'FAB-3  ✖ отменено  Старый план фабрики'])
    for (let n = 0; n < FRESH_REPLIES; n++) await reply($, n === FRESH_REPLIES - 1 ? 'MIND-80 дальше' : 'ок')
    expect((await drawn($)).rows).toEqual(['MIND-80  ⚙ в работе  Доска сессии видит задачи всех проектов'])
  })

  test('one folder as a plain string, as configured before, still finds its cards', { options: { ...OPTIONS, cardsDir: '~/mind/01 projects/tasks' } }, async ($, on) => {
    world(on)
    await start($)
    await reply($, 'MIND-80 и PH-197')
    expect((await drawn($)).rows).toEqual(['MIND-80  ⚙ в работе  Доска сессии видит задачи всех проектов'])
  })
})

describe('a vault card status', () => {
  test('is read as YAML reads it: a trailing comment and quotes are not part of it', () => {
    expect(cardStatus('---\nstatus: active        # active | paused | done\n---\n')).toBe('active')
    expect(cardStatus("---\nstatus: 'Verified by Denis'\n---\n")).toBe('Verified by Denis')
    expect(cardStatus('---\nstatus:\n---\n')).toBeUndefined()
  })

  test('each word of the vault schema has its badge', () => {
    expect(['idea', 'draft', 'active', 'paused', 'done', 'dropped'].map(s => cardBadge(s).text)).toEqual([
      '💡 идея',
      '✏ черновик',
      '⚙ в работе',
      '⏸ на паузе',
      '✅ готово',
      '✖ отменено',
    ])
  })
})
