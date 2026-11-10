import { expect, test } from 'claude-code/testing'

import { compileRules, hasMarkers, plan, splitBlocks, stripMarkers } from '../hooks/colorize'
import type { Line, Segment } from '../hooks/colorize'
import { PALETTE, RULES as RULE_LIST } from '../hooks/rules'
import { SAMPLE } from '../hooks/sample'

const RULES = compileRules()

const colored = (segments: readonly Segment[] | null): Line[] =>
  (segments ?? []).flatMap(s => (s.kind === 'colored' ? [...s.lines] : []))

const markdown = (segments: readonly Segment[] | null): string[] =>
  (segments ?? []).flatMap(s => (s.kind === 'markdown' ? [s.text] : []))

// Every run of a reply with the colour it is drawn in, `text=colour`, colourless runs left out.
function paint(text: string): string[] {
  return colored(plan(text, RULES)).flatMap(line => line.runs.filter(r => r.color).map(r => `${r.text}=${r.color}`))
}

// What a reader sees of each coloured line: its runs joined, mark characters gone.
const shown = (text: string): string[] => colored(plan(text, RULES)).map(l => l.runs.map(r => r.text).join(''))

test('the word rules are gone: a lone word or an amount is no colour', () => {
  expect(RULE_LIST.map(r => r.name)).toEqual(['task', 'url', 'path'])
  expect(plan('Тесты упали, ошибка в парсере, теперь работает, готово, занимает 350 МБ, 40%', RULES)).toBeNull()
})

test('each mark colours its whole phrase and hides its characters', () => {
  const text = 'Итог: {+все 14 миграций прошли+}, но {-деплой упал на миграции-}; {!реши, сносим ли индекс!} сегодня.'
  expect(paint(text)).toEqual([
    `все 14 миграций прошли=${PALETTE.green}`,
    `деплой упал на миграции=${PALETTE.red}`,
    `реши, сносим ли индекс=${PALETTE.yellow}`,
  ])
  expect(shown(text)).toEqual(['Итог: все 14 миграций прошли, но деплой упал на миграции; реши, сносим ли индекс сегодня.'])
})

test('bold, italic and a link inside a mark keep their style in the mark colour; a code span keeps the code colour', () => {
  const runs = colored(plan('{+тесты **зелёные** и *быстрые* после `npm run fix`, [лог](https://example.com/log)+} дальше', RULES)).flatMap(l => l.runs)
  expect(runs).toEqual([
    { text: 'тесты ', color: PALETTE.green, marked: true },
    { text: 'зелёные', bold: true, color: PALETTE.green, marked: true },
    { text: ' и ', color: PALETTE.green, marked: true },
    { text: 'быстрые', italic: true, color: PALETTE.green, marked: true },
    { text: ' после ', color: PALETTE.green, marked: true },
    { text: 'npm run fix', code: true, color: 'permission' },
    { text: ', ', color: PALETTE.green, marked: true },
    { text: 'лог', href: 'https://example.com/log', color: PALETTE.green, marked: true },
    { text: ' дальше' },
  ])
})

test('no rule recolours text inside a mark: the mark colour wins over task ids, paths and URLs', () => {
  expect(paint('{-PH-12 упал в hooks/a.ts:3 на https://example.com/x-} и PH-13')).toEqual([
    `PH-12 упал в hooks/a.ts:3 на https://example.com/x=${PALETTE.red}`,
    `PH-13=${PALETTE.purple}`,
  ])
})

test('an unclosed mark colours to the end of its line and no further', () => {
  const text = 'сборка: {-ещё идёт, пока падает на линтере\nследующая строка'
  expect(paint(text)).toEqual([`ещё идёт, пока падает на линтере=${PALETTE.red}`])
  expect(shown(text)).toEqual(['сборка: ещё идёт, пока падает на линтере', 'следующая строка'])
})

test('a reply that stops right after an opener shows no raw opener', () => {
  expect(shown('Итог: {+')).toEqual(['Итог: '])
})

test('a stray closer, or a closer of another mark, is dropped silently', () => {
  expect(shown('просто текст -} и ещё +}')).toEqual(['просто текст  и ещё '])
  expect(paint('{+готово -} всё+}')).toEqual([`готово  всё=${PALETTE.green}`])
})

test('marks in a code span stay literal and uncoloured; an escaped opener is text', () => {
  const runs = colored(plan('пиши `{+так+}` и {+вот так+}, а \\{+ — буквально', RULES)).flatMap(l => l.runs)
  expect(runs.find(r => r.code)).toEqual({ text: '{+так+}', code: true, color: 'permission' })
  expect(runs.filter(r => r.color === PALETTE.green).map(r => r.text)).toEqual(['вот так'])
  expect(runs.map(r => r.text).join('')).toBe('пиши {+так+} и вот так, а {+ — буквально')
  expect(plan('только код: `{-x-}`', RULES)).toBeNull()
})

test('a fenced block keeps its marks as written, the prose beside it is coloured', () => {
  const text = '{-тест упал-}:\n\n```bash\necho "{-x-}" {+y+}\n```\n\nдальше'
  const segments = plan(text, RULES) ?? []
  expect(segments.map(s => s.kind)).toEqual(['colored', 'markdown'])
  expect(markdown(segments)).toEqual(['```bash\necho "{-x-}" {+y+}\n```\n\nдальше'])
})

test('tables and headings stay with the engine, their marks stripped', () => {
  const text = '## Итог: {-упал PH-1-}\n\n| задача | статус |\n|---|---|\n| PH-1 | {-failed-} `{+code+}` |\n\n{+Всё остальное работает+}.'
  const segments = plan(text, RULES) ?? []
  expect(segments.map(s => s.kind)).toEqual(['markdown', 'colored'])
  expect(markdown(segments)).toEqual(['## Итог: упал PH-1\n\n| задача | статус |\n|---|---|\n| PH-1 | failed `{+code+}` |'])
  expect(paint(text)).toEqual([`Всё остальное работает=${PALETTE.green}`])
})

test('a reply whose only marks sit in a table plans to nothing: the hook strips it whole', () => {
  expect(plan('| a | b |\n|---|---|\n| 1 | {-плохо-} |', RULES)).toBeNull()
})

test('stripMarkers takes the mark characters out of prose only', () => {
  const text = [
    '{+готово+}, {-сломалось-} и {!посмотри!}; стрэй -} и незакрытый {+хвост',
    'код `{-x-}` и \\{+ буквально',
    '```',
    '{+в блоке+}',
    '```',
    '~~~~',
    '{-и тут-}',
    '~~~~',
    '| {!таблица!} |',
  ].join('\n')
  expect(stripMarkers(text)).toBe(
    [
      'готово, сломалось и посмотри; стрэй  и незакрытый хвост',
      'код `{-x-}` и \\{+ буквально',
      '```',
      '{+в блоке+}',
      '```',
      '~~~~',
      '{-и тут-}',
      '~~~~',
      '| таблица |',
    ].join('\n'),
  )
  const plain = 'обычный текст без меток: a-b, {x}, c+d'
  expect(stripMarkers(plain)).toBe(plain)
})

test('hasMarkers is true for any mark token and false for ordinary braces', () => {
  expect(hasMarkers('a {+b+}')).toBe(true)
  expect(hasMarkers('хвост -}')).toBe(true)
  expect(hasMarkers('{x} {a-b} c+d !')).toBe(false)
})

test('a verdict line keeps its accent when it opens with a mark', () => {
  const lines = colored(plan('- {!Твоё решение: сносим индекс?!}\nобычная строка {+ок+}', RULES))
  expect(lines.map(l => (l.accent ? 'accent' : '-'))).toEqual(['accent', '-'])
  expect(lines[0]?.runs[0]).toEqual({ text: 'Твоё решение: сносим индекс?', color: PALETTE.yellow, marked: true })
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

test('verdict lines are bold accent whole, their ids still purple inside', () => {
  const lines = colored(plan('result: PH-12 собран\n- **Ждёт тебя:** ответ\nТвоё решение: да\nneeds input: бакет\nfailed: деплой\nобычная строка с PH-1', RULES))
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

test('a fence with blank lines inside stays one block', () => {
  const blocks = splitBlocks('```\nerror\n\nfailed\n```\nтекст')
  expect(blocks[0]?.lines).toEqual(['```', 'error', '', 'failed', '```', 'текст'])
})

test('a reply with nothing to colour is left to the engine whole', () => {
  expect(plan('Просто текст без сигналов.\n\n- пункт\n- ещё пункт', RULES)).toBeNull()
  expect(plan('Только код: `PH-1 {+x+}`', RULES)).toBeNull()
})

test('markdown inside a coloured line still renders: bold, italic, links, escapes, list markers', () => {
  const lines = colored(plan('- **{+готово+}** и *почти*, [доки](https://example.com) \\*звёздочка\\*\n  1. вложенный PH-2', RULES))
  expect(lines[0]?.prefix).toBe('- ')
  expect(lines[0]?.runs).toEqual([
    { text: 'готово', bold: true, color: PALETTE.green, marked: true },
    { text: ' и ' },
    { text: 'почти', italic: true },
    { text: ', ' },
    { text: 'доки', href: 'https://example.com', color: PALETTE.cyan },
    { text: ' *звёздочка*' },
  ])
  expect(lines[1]?.prefix).toBe('  1. ')
})

test('snake_case and a lone asterisk are not emphasis', () => {
  const runs = colored(plan('{-упал-} в my_long_name и 2 * 3', RULES)).flatMap(l => l.runs)
  expect(runs.map(r => r.text).join('')).toBe('упал в my_long_name и 2 * 3')
  expect(runs.some(r => r.italic)).toBe(false)
})

test('a quoted draft is drawn as plain lines, its markers off, as plain-quotes draws it', () => {
  const lines = colored(plan('> Тест {-упал на stage-}\n> чиню', RULES))
  expect(lines.map(l => l.runs.map(r => r.text).join(''))).toEqual(['Тест упал на stage', 'чиню'])
})

test('the sample shows all three marks, the rules and the accent, and its table and fence come out right', () => {
  const segments = plan(SAMPLE, RULES) ?? []
  const lines = colored(segments)
  const colors = new Set(lines.flatMap(l => l.runs.map(r => r.color)))
  for (const color of [PALETTE.red, PALETTE.green, PALETTE.yellow, PALETTE.purple, PALETTE.cyan, 'permission']) expect(colors.has(color)).toBe(true)
  expect(lines.filter(l => l.accent).length).toBe(2)
  const md = markdown(segments).join('\n')
  expect(md).toContain('| KN-3 | в таблице метка снимается, цвет нет |')
  expect(md).toContain('echo "{-в блоке кода метка остаётся-}"')
  expect(lines.flatMap(l => l.runs).some(r => !r.code && /\{[+!-]|[+!-]\}/.test(r.text))).toBe(false)
})

test('a rule that does not compile is skipped and named, the rest still work', () => {
  const set = compileRules([{ name: 'broken', color: '#000000', pattern: '(' }, { name: 'ok', color: '#111111', pattern: 'упал' }], null)
  expect(set.broken.length).toBe(1)
  expect(set.broken[0]?.startsWith('broken:')).toBe(true)
  expect(colored(plan('упал', set)).flatMap(l => l.runs.map(r => r.color))).toEqual(['#111111'])
})

test('a long reply plans and strips in a few milliseconds', () => {
  const text = Array.from({ length: 400 }, (_, i) => `- строка ${i}: {-PH-${i} упал-}, hooks/a/b.ts:${i}, https://example.com/${i} {+работает+} \`{!x!}\``).join('\n')
  const started = Date.now()
  expect(plan(text, RULES)).not.toBeNull()
  expect(stripMarkers(text).includes('{-PH')).toBe(false)
  expect(Date.now() - started).toBeLessThan(500)
})
