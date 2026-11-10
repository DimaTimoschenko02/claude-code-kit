// The colour rules — the one place to edit them. A change shows in sessions started (or respawned) after it.
//
// Each rule colours what its `pattern` finds in a reply's prose; code spans and code blocks are never touched.
// `pattern` is a JavaScript regex source, matched with the `u` flag and, unless `caseSensitive`, the `i` flag.
// `\b` does not see Cyrillic letters: wrap words in `word(...)`, which puts letter-free edges around them.
// Where two rules match overlapping text, the match that starts first wins, then the longer one, then the earlier rule.
// A pattern that does not compile is skipped and named by `/semantic-colors`.

export type Rule = {
  readonly name: string
  readonly color: string
  readonly bold?: boolean
  readonly pattern: string
  readonly caseSensitive?: boolean
}

// Letter-free edges, so `упал` matches «упал» and «упала» but not inside «выпало».
export const word = (alternatives: string): string => `(?<![\\p{L}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{N}_])`

// The owner's neon Zed theme.
export const PALETTE = {
  red: '#ff77a6',
  green: '#a0ed83',
  purple: '#b68cff',
  cyan: '#60d1ff',
  yellow: '#ffe082',
  accent: '#5ce5dc',
} as const

export const RULES: readonly Rule[] = [
  {
    name: 'bad',
    color: PALETTE.red,
    pattern: word(
      [
        'не\\s+(?:работа\\p{L}*|взлет\\p{L}*|запуска\\p{L}*|проход\\p{L}*)',
        'слома\\p{L}*',
        'упал\\p{L}*',
        'упад\\p{L}*',
        'ошибк\\p{L}*',
        'ошибок',
        'errors?',
        'fail(?:ed|s|ing|ure)?',
        'про[её]б\\p{L}*',
        'бля(?:ть|дь)?',
      ].join('|'),
    ),
  },
  {
    name: 'good',
    color: PALETTE.green,
    pattern: `${word(
      ['работа(?:ет|ют)', 'заработал\\p{L}*', 'взлетел\\p{L}*', 'готово', 'почин\\p{L}+', 'зел[её]н\\p{L}*', 'passed', 'passing'].join('|'),
    )}|✅`,
  },
  {
    name: 'task',
    color: PALETTE.purple,
    bold: true,
    caseSensitive: true,
    pattern: `${word('(?:PH|KM|KN)-\\d+')}|(?<![\\p{L}\\p{N}_&#/])#\\d+(?![\\p{L}\\p{N}_])`,
  },
  {
    name: 'url',
    color: PALETTE.cyan,
    pattern: 'https?://[^\\s<>"\'`()\\[\\]]*[^\\s<>"\'`()\\[\\].,;:!?»]',
  },
  {
    name: 'path',
    color: PALETTE.cyan,
    pattern: [
      // C:\x\y, C:/x/y
      '(?<![\\p{L}\\p{N}_])[A-Za-z]:[\\\\/][^\\s<>"\'`|*?]*[^\\s<>"\'`|*?.,;:!?»)]',
      // ~/x, /srv/app/x (two segments at least, so `/compact` stays prose), ./x, ../x
      '(?<![\\p{L}\\p{N}_/.~:-])(?:~|\\.{1,2})/[\\w.@+-]+(?:/[\\w.@+-]+)*(?::\\d+(?::\\d+)?)?',
      '(?<![\\p{L}\\p{N}_/.~:-])/[\\w.@+-]+(?:/[\\w.@+-]+)+(?::\\d+(?::\\d+)?)?',
      // hooks/register.tsx:42, a/b/c — a slash and a file extension, or two slashes
      '(?<![\\p{L}\\p{N}_/.~:-])[\\w.@-]+(?:/[\\w.@-]+)+\\.[A-Za-z]\\w{0,5}(?::\\d+(?::\\d+)?)?(?![\\w/])',
      '(?<![\\p{L}\\p{N}_/.~:-])[\\w.@-]+(?:/[\\w.@-]+){2,}/?(?![\\w/])',
      // register.ts:42 — a file with a line
      '(?<![\\p{L}\\p{N}_/.~:-])[\\w.-]+\\.[A-Za-z]\\w{0,5}:\\d+(?::\\d+)?(?![\\w])',
    ].join('|'),
  },
  {
    name: 'amount',
    color: PALETTE.yellow,
    pattern: [
      // 350 МБ, 12 дн, 40%, 1.5 GB, 200ms, 3 ч, 100 грн — longer units first
      '(?<![\\p{L}\\p{N}_.,])\\d+(?:[.,]\\d+)?\\s?(?:ГБ|МБ|КБ|ТБ|GB|MB|KB|TB|мс|ms|сек\\p{L}{0,4}|мин\\p{L}{0,4}|дн\\p{L}{0,3}|час\\p{L}{0,3}|грн|ч|с)(?![\\p{L}\\p{N}_])',
      '(?<![\\p{L}\\p{N}_.,])\\d+(?:[.,]\\d+)?\\s?[%₴$]',
      '[₴$]\\s?\\d+(?:[.,]\\d+)?(?![\\p{N}])',
    ].join('|'),
  },
]

// A line whose text (after a list marker, quote marks and an opening `**`) starts like this is drawn whole in bold accent.
export const LINE_RULE: Rule = {
  name: 'verdict',
  color: PALETTE.accent,
  bold: true,
  pattern: '^(?:result:|needs input:|failed:|жд[её]т тебя|тво[её] решение)',
}
