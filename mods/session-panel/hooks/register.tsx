// A side panel per session: the links the main thread's replies carried, grouped under their task, and one line per
// `result:` the replies delivered. The owner ticks, rewrites, deletes and adds lines in place; what they changed reaches
// the model with their next message. The panel lives in $.store per session id, so it outlives restarts and reloads.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Item, Panel } from '../types'
import {
  addNote,
  addOwnerLine,
  capture,
  cardTasks,
  edit,
  emptyPanel,
  isDoneCard,
  merge,
  remove,
  reportText,
  taskRegex,
  toggle,
  view,
} from './logic'

type Engine = EngineInterface

const PANE = 'session-panel'
export const COMMAND = 'sp'
export const TOOL = 'add'
const KEY = 'panel:'
const TTL_MS = 30 * 86_400_000
/** Wide enough for a card title and its three buttons; the owner's drag or key resize wins and is kept. */
const COLUMNS = 48

const panelAtom = atom({ plugin: 'session-panel', key: 'panel' } as const, emptyPanel(0))
const editingAtom = atom({ plugin: 'session-panel', key: 'editing' } as const, null)
const doneAtom = atom({ plugin: 'session-panel', key: 'doneTasks' } as const, [])

function isPanel(value: unknown): value is Panel {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return Array.isArray(v.items) && Array.isArray(v.dropped) && Array.isArray(v.report) && typeof v.seq === 'number'
}

type Config = { pattern: RegExp; cardsDir: string; doneStatuses: string[] }
let cfg: Config = { pattern: taskRegex(undefined), cardsDir: '', doneStatuses: ['Done'] }
// Bumped per owner line so the add field empties; an auto capture mid-typing leaves it alone.
let addRound = 0
// The session the atom holds; `/clear` starts a new id, whose panel is loaded fresh.
let sid = ''

async function sync($: Engine): Promise<void> {
  const id = await $.session.id()
  if (id === sid) return
  sid = id
  const stored = await $.store.get(`${KEY}${id}`)
  await update($, panelAtom, () => (isPanel(stored) ? stored : emptyPanel(0)))
  await update($, editingAtom, () => null)
  await refreshCards($)
}

async function change($: Engine, fn: (p: Panel) => Panel): Promise<void> {
  await sync($)
  const before = await read($, panelAtom)
  const after = fn(before)
  if (after === before) return
  const stamped = { ...after, at: await $.clock.now() }
  await update($, panelAtom, () => stamped)
  await $.store.set(`${KEY}${sid}`, stamped)
}

async function refreshCards($: Engine): Promise<void> {
  if (cfg.cardsDir === '') return
  const tasks = cardTasks(await read($, panelAtom))
  const done: string[] = []
  for (const task of tasks) {
    const text = await $.fs.read(`${cfg.cardsDir}/${task}.md`).catch(() => null)
    if (text !== null && isDoneCard(text, cfg.doneStatuses)) done.push(task)
  }
  await update($, doneAtom, () => done)
}

async function togglePane($: Engine): Promise<boolean> {
  if ((await $.ui.panes()).some(p => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return false
  }
  await $.ui.open({ id: PANE, title: 'Сессия', columns: COLUMNS })
  return true
}

export const register: Register = (on, options) => {
  cfg = {
    pattern: taskRegex(typeof options.taskPattern === 'string' ? options.taskPattern : undefined),
    cardsDir: typeof options.cardsDir === 'string' ? options.cardsDir.replace(/\/+$/, '') : '',
    doneStatuses: Array.isArray(options.doneStatuses)
      ? options.doneStatuses.filter((s): s is string => typeof s === 'string')
      : ['Done'],
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
    await sync($)
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
    if (got.links.length > 0 || got.results.length > 0) await change($, p => merge(p, got, pattern))
    await refreshCards($)
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
    const v = view(panel, await read($, doneAtom))

    const row = (item: Item, indent = 0) => {
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
          <Button key={`t-${item.id}`} plain label={item.checked ? '☑' : '☐'} onPress={() => change($, p => toggle(p, item.id))} />
          <Text key={`s-${item.id}`}> </Text>
          {item.href === undefined
            ? <Text key={`x-${item.id}`} wrap="truncate-end" dimColor={item.checked && item.kind !== 'done'}>{item.text}</Text>
            : <Link key={`l-${item.id}`} href={item.href} label={item.text} />}
          <Text key={`g-${item.id}`}> </Text>
          {Input === null ? null : <Button key={`e-${item.id}`} plain dimColor label="✎" onPress={() => update($, editingAtom, () => item.id)} />}
          <Button key={`d-${item.id}`} plain dimColor label="✕" onPress={() => change($, p => remove(p, item.id))} />
        </Box>
      )
    }

    const section = (title: string, body: RenderChildren[]) =>
      body.length === 0 ? null : (
        <Box key={title} flexDirection="column" marginTop={1}>
          <Text bold>{title}</Text>
          {body}
        </Box>
      )

    const taskRows = v.tasks.flatMap(g => {
      if (g.card === undefined) {
        return [<Text key={`h-${g.task}`} dimColor>{g.task}</Text>, ...g.children.map(c => row(c, 2))]
      }
      return [row(g.card), ...(g.folded ? [] : g.children.map(c => row(c, 2)))]
    })

    return (
      <Box flexDirection="column">
        {panel.items.length === 0 ? <Text dimColor>Пока пусто: ссылки и итоги из ответов появятся здесь.</Text> : null}
        {section('Задачи', taskRows)}
        {section('Ссылки', v.links.map(i => row(i)))}
        {section('Заметки', v.notes.map(i => row(i)))}
        {section('Сделано', v.done.map(i => row(i)))}
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
