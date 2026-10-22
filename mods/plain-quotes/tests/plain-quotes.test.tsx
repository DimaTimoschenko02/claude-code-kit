import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { plainQuotes, quoteBlocks } from '../hooks/unquote'

// A draft as the session hands it over: a lead-in, the message in a quote, a remark after it.
const REPLY = [
  'Текст для Slack:',
  '> Привет! Проверил колбек на stage — **доходит**, ответ 200.',
  '>',
  '> Можно закрывать `TASK-0000`.',
  '',
  'Если надо короче — скажи.',
].join('\n')

const PLAIN = [
  'Текст для Slack:',
  '',
  'Привет! Проверил колбек на stage — **доходит**, ответ 200.',
  '',
  'Можно закрывать `TASK-0000`.',
  '',
  'Если надо короче — скажи.',
].join('\n')

test('a quoted draft becomes plain paragraphs, its inline markdown kept for the renderer', () => {
  expect(plainQuotes(REPLY)).toBe(PLAIN)
})

test('a reply without a quote is handed back as the same string', () => {
  const text = 'Готово: `a > b` в условии, и 3 > 2.\n\n- пункт > с угловой скобкой'
  expect(plainQuotes(text)).toBe(text)
})

test('a code fence outside a quote keeps its > lines', () => {
  const text = ['```bash', '> out.log', 'echo hi >> log', '```', '> после фенса'].join('\n')
  expect(plainQuotes(text)).toBe(['```bash', '> out.log', 'echo hi >> log', '```', '', 'после фенса'].join('\n'))
})

test('a fence inside a quote loses only the quote markers, its own > lines stay', () => {
  const text = ['> Команда:', '> ```', '> cat a > b', '> > literal', '> ```', '> Конец.'].join('\n')
  expect(plainQuotes(text)).toBe(['Команда:', '```', 'cat a > b', '> literal', '```', 'Конец.'].join('\n'))
})

test('a fence the quote closed by ending gets its own closing line, so text after it stays text', () => {
  const text = ['> ```', '> x = 1', 'дальше обычный текст', '> снова цитата'].join('\n')
  expect(plainQuotes(text)).toBe(['```', 'x = 1', '```', 'дальше обычный текст', '', 'снова цитата'].join('\n'))
})

test('nested quotes, indented markers and a quote under a list item all come off', () => {
  expect(plainQuotes('> > вложенная\n>> без пробела')).toBe('вложенная\nбез пробела')
  expect(plainQuotes('   > три пробела')).toBe('   три пробела')
  expect(plainQuotes('- пункт\n  > цитата в пункте')).toBe('- пункт\n\n  цитата в пункте')
  expect(plainQuotes('    > код отступом')).toBe('    > код отступом')
})

test('a lazy continuation line stays in the paragraph, no blank pushed into it', () => {
  expect(plainQuotes('> первая строка\nпродолжение\n> ещё')).toBe('первая строка\nпродолжение\nещё')
})

test('no line of a quoted draft starts with a quote marker after the rewrite (property)', () => {
  const pieces = ['> a', '>', '> > b', '  > c', 'text', '', '> ```', '> x', '> ```', '>> d', '> - item', '> 1. one']
  for (let seed = 1; seed < 400; seed += 1) {
    let s = seed
    const lines: string[] = []
    for (let i = 0; i < 8; i += 1) {
      s = (s * 1103515245 + 12345) % 2147483648
      lines.push(pieces[s % pieces.length] ?? '')
    }
    const out = plainQuotes(lines.join('\n'))
    let inFence = false
    for (const line of out.split('\n')) {
      if (/^ {0,3}```/.test(line)) inFence = !inFence
      if (!inFence) expect(/^ {0,3}>/.test(line)).toBe(false)
    }
  }
})

const MESSAGE = {
  plugin: 'plain-quotes',
  component: 'AssistantMessage',
  requestId: 'msg-1',
  props: { text: REPLY, isFirstOfReply: true },
} as const

test('the terminal draws the reply without the quote; desktop gets it untouched', async ($, on) => {
  const drawn: Record<string, string> = {}
  on('ui.render', ($, e) => {
    if (e.component === 'AssistantMessage') drawn[e.surface] = e.props.text
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...MESSAGE, surface })
    await ui.unmount()
  }

  expect(drawn.terminal).toBe(PLAIN)
  expect(drawn.desktop).toBe(REPLY)
})

const TWO_DRAFTS = [
  'В Slack:',
  '> Привет, **колбек** доходит — см. [лог](https://grafana.example/x).',
  '',
  'В тикет:',
  '> Проверено на stage.',
  '>',
  '> Можно в `Ready for QA`.',
].join('\n')

test('quoteBlocks gives each draft as paste-ready text, the screen markup gone', () => {
  expect(quoteBlocks(TWO_DRAFTS)).toEqual([
    'Привет, колбек доходит — см. лог (https://grafana.example/x).',
    'Проверено на stage.\n\nМожно в Ready for QA.',
  ])
  expect(quoteBlocks('```\n> не цитата\n```\nтекст')).toEqual([])
  expect(quoteBlocks('> один\n\n> абзац два')).toEqual(['один\n\nабзац два'])
})

const draft = ($: Engine, args: string) =>
  $.command.run({ command: 'draft', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

function world(on: On, texts: string[], copied: string[]) {
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({
    value: texts.map(text => ({ role: 'assistant' as const, text, toolUses: [] })),
  }))
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
}

test('/draft copies the last draft of the latest reply that has one; /draft 1 the first', async ($, on) => {
  const copied: string[] = []
  world(on, [TWO_DRAFTS, 'Ответ без цитаты'], copied)
  await $.session.start({ cwd: '/home/fake', surface: 'terminal', isInteractive: true })

  const last = await draft($, '')
  expect(copied).toEqual(['Проверено на stage.\n\nМожно в Ready for QA.'])
  expect(last.text ?? '').toContain('скопировал №2')

  await draft($, '1')
  expect(copied[1]).toBe('Привет, колбек доходит — см. лог (https://grafana.example/x).')

  const missing = await draft($, '5')
  expect(missing.text ?? '').toContain('нет №5')
})

test('/draft says so when no recent reply carries a quote', async ($, on) => {
  const copied: string[] = []
  world(on, ['просто текст', 'a > b'], copied)
  await $.session.start({ cwd: '/home/fake', surface: 'terminal', isInteractive: true })

  const answer = await draft($, '')
  expect(copied).toEqual([])
  expect(answer.text ?? '').toContain('нет цитаты')
})
