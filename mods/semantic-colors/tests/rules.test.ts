import { expect, test } from 'claude-code/testing'

import { compileRules, plan, splitBlocks } from '../hooks/colorize'
import type { Line, Segment } from '../hooks/colorize'
import { PALETTE } from '../hooks/rules'
import { SAMPLE } from '../hooks/sample'

const RULES = compileRules()

const colored = (segments: readonly Segment[] | null): Line[] =>
  (segments ?? []).flatMap(s => (s.kind === 'colored' ? [...s.lines] : []))

// Every run of a reply with the colour it is drawn in, `text=colour`, colourless runs left out.
function paint(text: string): string[] {
  return colored(plan(text, RULES)).flatMap(line => line.runs.filter(r => r.color).map(r => `${r.text}=${r.color}`))
}

test('failures are red, Russian stems and English words, any case', () => {
  const runs = paint('Тесты упали, ошибка в парсере, сломалось всё, Error и FAILED, проёб, бля')
  for (const word of ['упали', 'ошибка', 'сломалось', 'Error', 'FAILED', 'проёб', 'бля']) expect(runs).toContain(`${word}=${PALETTE.red}`)
})

test('«не работает» and «не взлетело» are red as a whole, not green under «работает»', () => {
  expect(paint('опять не работает')).toEqual([`не работает=${PALETTE.red}`])
  expect(paint('и не взлетело')).toEqual([`не взлетело=${PALETTE.red}`])
})

test('successes are green', () => {
  const runs = paint('Теперь работает, взлетело, готово, починил, всё зелёное, passed ✅')
  for (const word of ['работает', 'взлетело', 'готово', 'починил', 'зелёное', 'passed', '✅']) expect(runs).toContain(`${word}=${PALETTE.green}`)
})

test('a stem inside another word stays prose', () => {
  expect(paint('выпало окно, переработает позже, бляха')).toEqual([])
})

test('task ids and PR refs are bold purple', () => {
  const lines = colored(plan('Закрыл PH-12, KM-7 и KN-3, PR #140', RULES))
  const runs = lines.flatMap(l => l.runs).filter(r => r.color === PALETTE.purple)
  expect(runs.map(r => `${r.text}${r.bold ? ' bold' : ''}`)).toEqual(['PH-12 bold', 'KM-7 bold', 'KN-3 bold', '#140 bold'])
})

test('URLs, paths and file:line are cyan; a URL keeps a link', () => {
  const text = 'См. https://example.com/docs, D:\\work\\game\\main.ts, ~/claude-code-kit/mods, /c/fake/repo, hooks/register.tsx:42 и colorize.ts:118.'
  const runs = colored(plan(text, RULES)).flatMap(l => l.runs).filter(r => r.color === PALETTE.cyan)
  expect(runs.map(r => r.text)).toEqual([
    'https://example.com/docs',
    'D:\\work\\game\\main.ts',
    '~/claude-code-kit/mods',
    '/c/fake/repo',
    'hooks/register.tsx:42',
    'colorize.ts:118',
  ])
  expect(runs[0]?.href).toBe('https://example.com/docs')
})

test('a slash command, «и/или» and a lone word with a slash stay prose', () => {
  expect(paint('запусти /compact, и/или /semantic-colors')).toEqual([])
})

test('numbers with units are yellow, longer units first', () => {
  const runs = paint('Занимает 350 МБ, 1.5 GB, 12 дн, 40%, 200 мс, 200ms, 3 ч, 5 сек, 100 грн, $25, 25$, ₴80')
  expect(runs).toEqual(
    ['350 МБ', '1.5 GB', '12 дн', '40%', '200 мс', '200ms', '3 ч', '5 сек', '100 грн', '$25', '25$', '₴80'].map(t => `${t}=${PALETTE.yellow}`),
  )
})

test('a bare number or a version is no amount', () => {
  expect(paint('версия 2.1 и 42 файла, v3 сборка')).toEqual([])
})

test('verdict lines are bold accent whole, their ids still purple inside', () => {
  const lines = colored(plan('result: PH-12 собран\n- **Ждёт тебя:** ответ\nТвоё решение: да\nneeds input: бакет\nfailed: деплой\nобычная строка с ошибкой', RULES))
  expect(lines.map(l => (l.accent ? `${l.accent.color}${l.accent.bold ? ' bold' : ''}` : '-'))).toEqual([
    `${PALETTE.accent} bold`,
    `${PALETTE.accent} bold`,
    `${PALETTE.accent} bold`,
    `${PALETTE.accent} bold`,
    `${PALETTE.accent} bold`,
    '-',
  ])
  expect(lines[0]?.runs.find(r => r.text === 'PH-12')?.color).toBe(PALETTE.purple)
})

test('inline code is never coloured by a rule: it keeps the theme code colour', () => {
  const runs = colored(plan('упал `error PH-1 350 МБ` тест', RULES)).flatMap(l => l.runs)
  expect(runs.find(r => r.code)).toEqual({ text: 'error PH-1 350 МБ', code: true, color: 'permission' })
  expect(runs.filter(r => r.color === PALETTE.red).map(r => r.text)).toEqual(['упал'])
})

test('a code fence goes to the engine untouched, the prose beside it is coloured', () => {
  const text = 'Тест упал:\n\n```bash\necho "failed PH-1 350 МБ"\n```\n\nПосле фикса работает.'
  const segments = plan(text, RULES) ?? []
  expect(segments.map(s => s.kind)).toEqual(['colored', 'markdown', 'colored'])
  expect(segments[1]).toEqual({ kind: 'markdown', text: '```bash\necho "failed PH-1 350 МБ"\n```' })
})

test('a fence with blank lines inside stays one block', () => {
  const blocks = splitBlocks('```\nerror\n\nfailed\n```\nтекст')
  expect(blocks[0]?.lines).toEqual(['```', 'error', '', 'failed', '```', 'текст'])
})

test('tables and headings keep the engine renderer even with a hit', () => {
  const text = '## Итог: упал PH-1\n\n| задача | статус |\n|---|---|\n| PH-1 | failed |\n\nВсё работает.'
  const segments = plan(text, RULES) ?? []
  expect(segments.map(s => s.kind)).toEqual(['markdown', 'colored'])
  expect(segments[0]).toEqual({ kind: 'markdown', text: '## Итог: упал PH-1\n\n| задача | статус |\n|---|---|\n| PH-1 | failed |' })
})

test('a reply with nothing to colour is left to the engine whole', () => {
  expect(plan('Просто текст без сигналов.\n\n- пункт\n- ещё пункт', RULES)).toBeNull()
  expect(plan('Только код: `error 350 МБ`', RULES)).toBeNull()
})

test('markdown inside a coloured line still renders: bold, italic, links, escapes, list markers', () => {
  const lines = colored(plan('- **готово** и *почти*, [доки](https://example.com) \\*звёздочка\\*\n  1. вложенный PH-2', RULES))
  expect(lines[0]?.prefix).toBe('- ')
  expect(lines[0]?.runs).toEqual([
    { text: 'готово', bold: true, color: PALETTE.green },
    { text: ' и ' },
    { text: 'почти', italic: true },
    { text: ', ' },
    { text: 'доки', href: 'https://example.com', color: PALETTE.cyan },
    { text: ' *звёздочка*' },
  ])
  expect(lines[1]?.prefix).toBe('  1. ')
})

test('snake_case and a lone asterisk are not emphasis', () => {
  const runs = colored(plan('упал в my_long_name и 2 * 3', RULES)).flatMap(l => l.runs)
  expect(runs.map(r => r.text).join('')).toBe('упал в my_long_name и 2 * 3')
  expect(runs.some(r => r.italic)).toBe(false)
})

test('a quoted draft is drawn as plain lines, its markers off, as plain-quotes draws it', () => {
  const lines = colored(plan('> Тест упал на stage\n> чиню', RULES))
  expect(lines.map(l => l.runs.map(r => r.text).join(''))).toEqual(['Тест упал на stage', 'чиню'])
})

test('the sample shows every rule and the accent', () => {
  const segments = plan(SAMPLE, RULES) ?? []
  const lines = colored(segments)
  const colors = new Set(lines.flatMap(l => l.runs.map(r => r.color)))
  for (const color of [PALETTE.red, PALETTE.green, PALETTE.purple, PALETTE.cyan, PALETTE.yellow]) expect(colors.has(color)).toBe(true)
  expect(lines.filter(l => l.accent).length).toBe(5)
  expect(segments.at(-1)?.kind).toBe('markdown')
})

test('a rule that does not compile is skipped and named, the rest still work', () => {
  const set = compileRules([{ name: 'broken', color: '#000000', pattern: '(' }, { name: 'ok', color: '#111111', pattern: 'упал' }], null)
  expect(set.broken.length).toBe(1)
  expect(set.broken[0]?.startsWith('broken:')).toBe(true)
  expect(colored(plan('упал', set)).flatMap(l => l.runs.map(r => r.color))).toEqual(['#111111'])
})

test('a long reply plans in a few milliseconds', () => {
  const text = Array.from({ length: 400 }, (_, i) => `- строка ${i}: PH-${i} упал, 350 МБ, hooks/a/b.ts:${i}, https://example.com/${i} работает`).join('\n')
  const started = Date.now()
  expect(plan(text, RULES)).not.toBeNull()
  expect(Date.now() - started).toBeLessThan(500)
})
