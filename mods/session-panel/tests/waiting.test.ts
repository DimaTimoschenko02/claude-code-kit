import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { emptyPanel, nextTurn, normalize, setWaiting, toggle, view } from '../hooks/logic'
import { markerRegex, waitingLines } from '../hooks/waiting'
import type { Panel } from '../types'

const M = markerRegex(undefined)
const read = (answer: string) => waitingLines(answer, M)
const NONE = { statuses: {}, prs: {}, doneStatuses: ['Done'] }

describe('the shapes a reply opens «Ждёт тебя» with', () => {
  test('inline: bold with the colon inside, plain colon, a key and a dash; ё or е', () => {
    expect(read('**Ждёт тебя:** удалить пустую строку в Notion? — рекомендую да.\n\nДальше текст.')).toEqual([
      'удалить пустую строку в Notion? — рекомендую да.',
    ])
    expect(read('Ждёт тебя: храним все файлы? — рекомендую да.\n\n1. **X-GM-MSGID** — номер письма.')).toEqual([
      'храним все файлы? — рекомендую да.',
    ])
    expect(read('**Ждет тебя** — правила доски — в отдельный скилл?')).toEqual(['правила доски — в отдельный скилл?'])
  })

  test('a heading and its list, blank lines between, up to the next heading', () => {
    const answer = [
      '### Ждёт тебя',
      '',
      '- **Ревью [#132](https://github.com/acme/app/pull/132)** — прайс-файлы, 10 файлов.',
      '',
      '- **Апрув #134** — если объяснение ок,',
      '  смёржу.',
      '',
      '### Сделано',
      '',
      '- **#132, #133 смёржены**',
    ].join('\n')
    expect(read(answer)).toEqual([
      '**Ревью [#132](https://github.com/acme/app/pull/132)** — прайс-файлы, 10 файлов.',
      '**Апрув #134** — если объяснение ок, смёржу.',
    ])
  })

  test('a list ends at a rule or a paragraph; a bold opener alone or with «утром:» takes the numbered list under it', () => {
    expect(read('## Ждёт тебя\n1. Ноут на зарядку.\n2. Сброс лимита.\n---\n- чужой пункт\nresult: аудит')).toEqual(['Ноут на зарядку.', 'Сброс лимита.'])
    expect(read('### Ждёт тебя\n\n---\n\n- чужой пункт')).toEqual([])
    expect(read('**Ждёт тебя:**\n1. **Час на оценку — дашь?** Рекомендую да.\nЭто уже абзац.\n- не наш пункт')).toEqual([
      '**Час на оценку — дашь?** Рекомендую да.',
    ])
    expect(read('**Ждёт тебя утром:**\n1. «Да» или «нет» по пяти предложениям.\n\n---\n\nresult: x')).toEqual([
      '«Да» или «нет» по пяти предложениям.',
    ])
    expect(read('**Ждёт тебя** — ревью по порядку:\n\n1. [#119](https://github.com/acme/app/pull/119) — шаг 3.\n2. #120.')).toEqual([
      '[#119](https://github.com/acme/app/pull/119) — шаг 3.',
      '#120.',
    ])
  })

  test('as real replies spell it: a hyphenated qualifier, a bold that runs past the marker', () => {
    expect(read('Ждёт тебя по-прежнему одно: «да» на approve групп 1–3.')).toEqual(['«да» на approve групп 1–3.'])
    expect(read('**Ждёт тебя: первый скелет — [PR #120](https://github.com/acme/app/pull/120)**, один формат.')).toEqual([
      'первый скелет — [PR #120](https://github.com/acme/app/pull/120), один формат.',
    ])
  })

  test('mid-sentence, in a table, in a code block or a code span it is no block', () => {
    expect(read('Раздел «Ждёт тебя» теперь наверху панели. Ждёт тебя: не здесь.')).toBeNull()
    expect(read('| «Ждёт тебя» | вопросы |')).toBeNull()
    expect(read('```\n**Ждёт тебя:** пример\n```')).toBeNull()
    expect(read('`Ждёт тебя: пример` в тексте')).toBeNull()
    expect(read('Ждёт тебя ревью, и это просто фраза')).toBeNull()
  })

  test('«от тебя ничего» and «ничего» say nothing waits; a reply without the block says nothing at all', () => {
    expect(read('**Ждёт тебя:** от тебя ничего.')).toEqual([])
    expect(read('### Ждёт тебя\n\nНичего\n\n### Сделано')).toEqual([])
    expect(read('Принял отчёт агента, жду второго.')).toBeNull()
    // As real replies write it: the reason after a stop still means nothing waits.
    expect(read('**Ждёт тебя:** от тебя ничего — чиню шаг 2, остальное стоит.')).toEqual([])
    expect(read('Ждёт тебя: от тебя ничего, mod-builder собирает.')).toEqual([])
    expect(read('**Ждёт тебя:** ничего не сломалось, но глянь #140')).toEqual(['ничего не сломалось, но глянь #140'])
  })

  test('another marker from the config; an empty one turns the block off', () => {
    expect(waitingLines('**Waiting on you:** pick a name', markerRegex('Waiting on you'))).toEqual(['pick a name'])
    expect(waitingLines('**Ждёт тебя:** x', markerRegex(''))).toBeNull()
  })
})

describe('the section', () => {
  test('a block replaces the section whole; no block keeps it; «ничего» clears it', () => {
    let p = setWaiting(nextTurn(emptyPanel(0)), ['удалить строку в Notion?', 'правила доски — в скилл?'])
    expect(view(p, NONE).waiting.map(i => i.text)).toEqual(['удалить строку в Notion?', 'правила доски — в скилл?'])
    p = setWaiting(nextTurn(p), null)
    expect(view(p, NONE).waiting).toHaveLength(2)
    p = setWaiting(nextTurn(p), ['ревью #140'])
    expect(view(p, NONE).waiting.map(i => i.text)).toEqual(['ревью #140'])
    // Old waiting lines never fold, however many replies pass without a block.
    for (let n = 0; n < 40; n++) p = setWaiting(nextTurn(p), null)
    expect(view(p, NONE).waiting).toHaveLength(1)
    p = setWaiting(nextTurn(p), [])
    expect(view(p, NONE).waiting).toEqual([])
  })

  test('a tick reaches the model as answered; a stored panel from before the section takes a block', () => {
    const stored = normalize({ items: [{ id: 'i1', kind: 'done', text: 'итог', checked: true, by: 'auto' }], dropped: [], report: [], seq: 1, at: 5 } as unknown as Panel)
    const p = setWaiting(nextTurn(stored), ['удалить строку в Notion?'])
    expect(p.items.map(i => i.kind)).toEqual(['done', 'wait'])
    const ticked = toggle(p, p.items[1]!.id)
    expect(ticked.report).toEqual(['отметил как отвеченное в «Ждёт тебя» «удалить строку в Notion?»'])
  })
})

type World = { store: Map<string, unknown>; prompts: readonly string[][] }

function world(on: On): World {
  const prompts: string[][] = []
  const w: World = { store: new Map(), prompts }
  mock.clock(on, { now: 1_000 })
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
  on('session.id', () => ({ value: 'sess-wait' }))
  on('process.run', () => ({ deny: 'no processes here' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__session-panel__${e.name}` } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { opened: true } }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => {
    prompts.push([...(e.context ?? [])])
    return { text: e.text }
  })
  return w
}

const start = ($: Engine) => $.session.start({ cwd: '/home/fake/proj', surface: 'terminal', isInteractive: true })
const reply = ($: Engine, answer: string, agentId?: string) =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...(agentId === undefined ? {} : { agentId }) } as never)
const PANE = { plugin: 'session-panel', component: 'Pane', requestId: 'session-panel', surface: 'terminal', props: { title: 'Сессия', isFocused: true, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

describe('the pane', () => {
  test('«Ждёт тебя» sits above the tasks; a subagent reply does not touch it; a tick reaches the model', async ($, on) => {
    const w = world(on)
    await start($)
    await reply($, '### Ждёт тебя\n\n- **Notion** — удалить пустую строку?\n- **Доска** — правила в отдельный скилл?\n\n### Сделано\n\n- [PR PH-7](https://github.com/acme/app/pull/7)')
    await reply($, '**Ждёт тебя:** от агента, не тебе', 'agent-1')
    const ui = await $.ui.mount(PANE)
    const titles = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => t === 'Ждёт тебя' || t === 'Задачи')
    expect(titles).toEqual(['Ждёт тебя', 'Задачи'])
    expect(await ui.find({ text: /от агента/ })).toBeUndefined()
    const line = (w.store.get('panel:sess-wait') as Panel).items.find(i => i.kind === 'wait')!
    await ui.press({ key: `t-${line.id}` })
    await ui.unmount()
    await $.prompt.submit({ text: 'дальше', wait: false, origin: { kind: 'composer' } as never })
    expect(w.prompts[0]!.join('\n')).toContain('отметил как отвеченное в «Ждёт тебя» «**Notion** — удалить пустую строку?»')
  })
})
