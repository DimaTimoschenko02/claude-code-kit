import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { capture, emptyPanel, merge, remove, taskRegex, view } from '../hooks/logic'
import type { Panel } from '../types'

const SID = 'sess-1'
const CARDS = '/home/fake/vault/tasks'
const OPTIONS = { cardsDir: CARDS, doneStatuses: ['Done', 'Verified by Owner'] }
const CARD = 'obsidian://open?vault=v&file=proj%2Ftasks%2FPH-95'
const PR = 'https://github.com/acme/app/pull/41'
const DESIGN = 'https://github.com/acme/app/blob/main/docs/design/PH-95-schema.md'

const ANSWER = [
  '### Сделано',
  `- **карточка** — [PH-95 переводы](${CARD})`,
  `- **PR** — [PR PH-95](${PR}), схема ${DESIGN}.`,
  '- пример в коде `https://example.com/not-a-place` и стенд https://stand.example.com/products',
  '',
  '---',
  'result: PH-95 переводы названий собраны и задеплоены',
].join('\n')

type World = { store: Map<string, unknown>; files: Map<string, string>; prompts: { text: string; context: readonly string[] }[]; opened: string[] }

function world(on: On): World {
  const w: World = { store: new Map(), files: new Map(), prompts: [], opened: [] }
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
  mock.clock(on, { now: 1_000 })
  on('session.id', () => ({ value: SID }))
  on('fs.read', (_$, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__session-panel__${e.name}` } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', (_$, e) => {
    w.opened.push(e.id)
    return { value: { opened: true } } as never
  })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => {
    w.prompts.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }
  })
  return w
}

const start = ($: Engine) => $.session.start({ cwd: '/home/fake/proj', surface: 'terminal', isInteractive: true })
const reply = ($: Engine, answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
const prompt = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } as never })
const stored = (w: World) => w.store.get(`panel:${SID}`) as Panel
const PANE = { plugin: 'session-panel', component: 'Pane', requestId: 'session-panel', props: { title: 'Сессия', isFocused: true, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

describe('capture', () => {
  test('takes markdown and bare links and result lines, never a URL inside a code span', () => {
    const got = capture(ANSWER)
    expect(got.links.map(l => l.href)).toEqual([CARD, PR, DESIGN, 'https://stand.example.com/products'])
    expect(got.links[1]!.label).toBe('PR PH-95')
    expect(got.links[2]!.label).toBe('github.com/acme/app/blob/main/docs/design/PH-95-schema.md')
    expect(got.results).toEqual(['PH-95 переводы названий собраны и задеплоены'])
  })

  test('a done card folds its PR and design away; a task without its card keeps them', () => {
    const p = merge(emptyPanel(0), capture(ANSWER), taskRegex(undefined))
    const open = view(p, [])
    expect(open.tasks[0]!.card?.href).toBe(CARD)
    expect(open.tasks[0]!.children.map(c => c.href)).toEqual([PR, DESIGN])
    expect(open.links.map(l => l.href)).toEqual(['https://stand.example.com/products'])
    expect(view(p, ['PH-95']).tasks[0]!.folded).toBe(true)
    const noCard = merge(emptyPanel(0), { links: [{ href: DESIGN, label: 'design' }], results: [] }, taskRegex(undefined))
    expect(view(noCard, ['PH-95']).tasks[0]).toMatchObject({ card: undefined, folded: false })
  })

  test('a link the owner deleted does not come back with the next reply', () => {
    const re = taskRegex(undefined)
    const p = merge(emptyPanel(0), capture(ANSWER), re)
    const gone = remove(p, p.items.find(i => i.href === PR)!.id)
    const again = merge(gone, capture(ANSWER), re)
    expect(again.items.some(i => i.href === PR)).toBe(false)
    expect(again.report).toEqual([`удалил «PR PH-95» (${PR})`])
  })
})

describe('session', () => {
  test('a reply fills the panel and the card file decides the fold', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    w.files.set(`${CARDS}/PH-95.md`, '---\nname: PH-95\nstatus: Done\n---\nbody\n')
    await start($)
    expect(w.opened).toEqual(['session-panel'])
    await reply($, ANSWER)
    const p = stored(w)
    expect(p.items).toHaveLength(5)
    // The terminal makes an OSC 8 link of any scheme; desktop draws obsidian:// as plain text.
    const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await term.find({ type: 'Link', text: /PH-95 переводы/ })).toBeDefined()
    await term.unmount()
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ text: /PH-95 переводы/ })).toBeDefined()
      expect(await ui.find({ text: /schema/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /задеплоены/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test("the owner's ticks and lines reach the model with their next message, once", { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await start($)
    await reply($, ANSWER)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const card = (stored(w)).items.find(i => i.href === CARD)!
    await ui.press({ key: `t-${card.id}` })
    await ui.input({ key: 'add-0', text: 'позвонить поставщику про теги' })
    await ui.unmount()
    const p = stored(w)
    expect(p.items.find(i => i.id === card.id)!.checked).toBe(true)
    expect(p.items.at(-1)).toMatchObject({ kind: 'note', text: 'позвонить поставщику про теги', by: 'owner' })

    await prompt($, 'дальше')
    expect(w.prompts[0]!.context.join('\n')).toContain('отметил «PH-95 переводы»')
    expect(w.prompts[0]!.context.join('\n')).toContain('добавил строку «позвонить поставщику про теги»')
    await prompt($, 'ещё')
    expect(w.prompts[1]!.context).toEqual([])
  })

  test('the model adds what no reply carried through its tool', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await start($)
    await $.tool.call({ tool: 'mcp__session-panel__add', text: 'стенд', href: 'https://stand.example.com' } as never)
    await $.tool.call({ tool: 'mcp__session-panel__add', text: 'PH-96 сопоставление по всем названиям', done: true } as never)
    const p = stored(w)
    expect(p.items.map(i => [i.kind, i.by])).toEqual([['link', 'tool'], ['done', 'tool']])
    expect(p.report).toEqual([])
  })
})
