// The colours — the one place to edit them. A change shows in sessions started (or respawned) after it.
//
// MARKS are what carries meaning: the model wraps a whole phrase in one (taught by hooks/instruction.ts), the mod
// draws the phrase in the mark's colour and hides the mark characters. RULES only tag things a regex can find
// reliably (task ids, URLs, paths), and never inside a marked phrase.
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

export type Mark = {
  readonly name: string
  readonly open: string
  readonly close: string
  readonly color: string
}

// Inline marks the model writes: `{+деплой прошёл+}`. Open and close are two characters each; the planner and
// the stripper read them from here, so a change of colour is one line. Changing the characters also needs the
// instruction text changed.
export const MARKS: readonly Mark[] = [
  { name: 'good', open: '{+', close: '+}', color: PALETTE.green },
  { name: 'bad', open: '{-', close: '-}', color: PALETTE.red },
  { name: 'act', open: '{!', close: '!}', color: PALETTE.yellow },
]

export const RULES: readonly Rule[] = [
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
]

// A line whose text (after a list marker, quote marks and an opening `**`) starts like this is drawn whole in bold accent.
export const LINE_RULE: Rule = {
  name: 'verdict',
  color: PALETTE.accent,
  bold: true,
  pattern: '^(?:result:|needs input:|failed:|жд[её]т тебя|тво[её] решение)',
}
