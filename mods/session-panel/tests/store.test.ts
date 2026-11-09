import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { storeProblem } from '../hooks/register'
import { fixturePath } from './fixture-path'

// A crash mid-write left the store's file all NUL bytes; the engine then refuses every store call, keys included.
// The panel must keep linking its tasks for the session it is in, and say once that it is not being saved.
const SID = 'sess-store'
const CARDS = '/home/fake/proj/brain/tasks'
const VAULT = '/home/fake/mind'
const REAL = `${VAULT}/proj/tasks`
const OPTIONS = { cardsDir: CARDS, vault: VAULT, linkRoots: [], doneStatuses: ['Done'] }
const FILE = 'C:\\Users\\fake\\.claude\\plugins\\store\\session-panel_inline-0123456789ab.json'
const REFUSAL = `session-panel@inline: store file ${FILE} is malformed JSON (Unexpected token)`

type World = { broken: boolean; store: Map<string, unknown>; disk: Map<string, string | null> }

function world(on: On): World {
  const w: World = { broken: true, store: new Map(), disk: new Map() }
  mock.clock(on, { now: 1_000 })
  w.disk.set(CARDS, null)
  w.disk.set(`${CARDS}/PH-133 Заказ поставщику`, null)
  w.disk.set(`${CARDS}/PH-133 Заказ поставщику/PH-187.md`, '---\nid: PH-187\ntitle: "График наличия"\nstatus: Review\n---\n')
  const refuse = () => (w.broken ? { deny: REFUSAL } : undefined)
  on('store.get', (_$, e) => refuse() ?? { value: w.store.get(e.key) })
  on('store.set', (_$, e) => {
    const no = refuse()
    if (no !== undefined) return no
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => refuse() ?? (w.store.delete(e.key), { value: undefined }))
  on('store.keys', () => refuse() ?? { value: [...w.store.keys()] })
  on('session.id', () => ({ value: SID }))
  on('fs.list', (_$, e) => {
    const dir = fixturePath(e.path).replace(/\/+$/, '')
    if (!w.disk.has(dir) || w.disk.get(dir) !== null) return { deny: `ENOENT ${e.path}` }
    const entries = [...w.disk]
      .filter(([p]) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
      .map(([p, t]) => ({ name: p.slice(dir.length + 1), kind: t === null ? ('dir' as const) : ('file' as const), size: 1, mtimeMs: 0, isLink: false }))
    return { value: entries }
  })
  on('fs.read', (_$, e) => {
    const text = w.disk.get(fixturePath(e.path))
    return typeof text === 'string' ? { value: text } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.stat', (_$, raw) => {
    const path = fixturePath(raw.path)
    const real = path.startsWith(CARDS) ? `${REAL}${path.slice(CARDS.length)}` : path
    const known = path === VAULT ? null : w.disk.get(path)
    if (known === undefined && path !== VAULT) return { deny: `ENOENT ${raw.path}` }
    const kind = known === null ? ('dir' as const) : ('file' as const)
    return { value: { kind, size: 1, mtimeMs: 0, isLink: false, ...(raw.resolve ? { realPath: real } : {}) } }
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
const PANE = { plugin: 'session-panel', component: 'Pane', requestId: 'session-panel', surface: 'terminal', props: { title: 'Сессия', isFocused: true, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } } as const
const NOTE = `obsidian://open?vault=mind&file=${encodeURIComponent('proj/tasks/PH-133 Заказ поставщику/PH-187')}`

async function drawn($: Engine): Promise<{ links: string[]; texts: string[] }> {
  const ui = await $.ui.mount(PANE)
  const links = (await ui.findAll({ type: 'Link' })).map(l => String(l.props.href))
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  return { links, texts }
}

describe('an unreadable store', () => {
  test('costs only the saving: a task a reply names still opens its card, over several replies', { options: OPTIONS }, async ($, on) => {
    world(on)
    await start($)
    await reply($, 'Закрыл ревью по PH-187.')
    await reply($, 'PH-187 дальше.')
    const { links, texts } = await drawn($)
    expect(links).toContain(NOTE)
    expect(texts.some(t => t.includes('PH-187') && t.includes('График наличия'))).toBe(true)
  })

  test('says on top of the pane that the panel is not saved, and where the file is; a working store again clears it', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await start($)
    await reply($, 'PH-187')
    expect((await drawn($)).texts.some(t => t.startsWith('⚠ панель не сохраняется') && t.includes(FILE))).toBe(true)
    w.broken = false
    await reply($, 'PH-187 ещё раз')
    expect((await drawn($)).texts.some(t => t.startsWith('⚠'))).toBe(false)
    expect(w.store.has(`panel:${SID}`)).toBe(true)
  })

  test('the refusal names the file; any other failure is kept short', () => {
    expect(storeProblem(new Error(REFUSAL))).toBe(FILE)
    expect(storeProblem(new Error('x'.repeat(500))).length).toBe(200)
  })
})
