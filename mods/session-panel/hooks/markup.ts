// A panel line keeps the raw text a reply or the owner wrote; this turns its inline markdown into styled runs at
// draw time, so stored panels need no migration and the edit field still shows what was typed.

/** One run of a line: plain, a code span, bold, italic, or a link's label. */
export type Run = { text: string; code?: true; bold?: true; italic?: true; href?: string }

// One left-to-right scan: a code span or a markdown link is atomic (no marks inside count), `**` toggles bold.
const TOKEN = /`([^`\n]+)`|\[([^\]\n]+)\]\(((?:https?|obsidian):\/\/[^)\s]+)\)|\*\*/g
// `*word*` italic only when flanked like emphasis, so `a * b` and `snake*case` stay as written.
const ITALIC = /(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])/g

function plainRuns(text: string, bold: boolean): Run[] {
  const out: Run[] = []
  let at = 0
  for (const m of text.matchAll(ITALIC)) {
    if (m.index > at) out.push(style({ text: text.slice(at, m.index) }, bold))
    out.push(style({ text: m[1]!, italic: true }, bold))
    at = m.index + m[0].length
  }
  if (at < text.length) out.push(style({ text: text.slice(at) }, bold))
  return out
}

function style(run: Run, bold: boolean): Run {
  return bold ? { ...run, bold: true } : run
}

/**
 * The inline markdown of one line as runs: `code`, **bold**, *italic*, [label](url). A `**` without its pair is
 * dropped rather than shown, as is a link's markup; anything else unrecognised stays as written.
 */
export function runs(text: string): Run[] {
  const tokens = [...text.matchAll(TOKEN)]
  const marks = tokens.filter(t => t[0] === '**').length
  // An odd count leaves the last `**` unpaired: it is dropped and toggles nothing.
  const lastMark = marks % 2 === 1 ? tokens.findLastIndex(t => t[0] === '**') : -1
  const out: Run[] = []
  let bold = false
  let at = 0
  tokens.forEach((t, n) => {
    if (t.index > at) out.push(...plainRuns(text.slice(at, t.index), bold))
    at = t.index + t[0].length
    if (t[1] !== undefined) out.push(style({ text: t[1], code: true }, bold))
    else if (t[2] !== undefined) out.push(style({ text: t[2].replace(/[*`]/g, ''), href: t[3]! }, bold))
    else if (n !== lastMark) bold = !bold
  })
  if (at < text.length) out.push(...plainRuns(text.slice(at), bold))
  return merged(out)
}

function same(a: Run, b: Run): boolean {
  return a.code === b.code && a.bold === b.bold && a.italic === b.italic && a.href === b.href
}

function merged(list: Run[]): Run[] {
  const out: Run[] = []
  for (const r of list) {
    if (r.text === '') continue
    const prev = out.at(-1)
    if (prev !== undefined && same(prev, r)) out[out.length - 1] = { ...prev, text: prev.text + r.text }
    else out.push(r)
  }
  return out
}

/** The line as plain text: what it says once its marks are drawn. Two lines that differ only in marks are one line. */
export function plain(text: string): string {
  return runs(text).map(r => r.text).join('')
}

/** A lead shorter than this is a word like «Да,» and a longer one is no lead: the next break or none is used. */
export const LEAD_MIN = 8
export const LEAD_MAX = 80
// Where a clause ends: a dash between spaces, a colon, semicolon or comma before a space, an aside opening.
const BREAK = /\s[—–-]\s|[:;,](?=\s)|\s\(/g

/**
 * The line with its lead bold: the text up to its first clause break (« — », «: », «; », «, », « (») that leaves
 * a lead of LEAD_MIN..LEAD_MAX characters. A break inside a code span or a link label does not count. No such
 * break, no lead — a short line reads at a glance anyway.
 */
export function withLead(list: Run[]): Run[] {
  let offset = 0
  for (let i = 0; i < list.length; i++) {
    const run = list[i]!
    if (run.code === undefined && run.href === undefined) {
      for (const m of run.text.matchAll(BREAK)) {
        const cut = offset + m.index
        if (cut < LEAD_MIN) continue
        if (cut > LEAD_MAX) return list
        const head = run.text.slice(0, m.index)
        const lead = [...list.slice(0, i), ...(head === '' ? [] : [{ ...run, text: head }])]
        return merged([...lead.map(r => style(r, true)), { ...run, text: run.text.slice(m.index) }, ...list.slice(i + 1)])
      }
    }
    offset += run.text.length
    if (offset > LEAD_MAX) return list
  }
  return list
}
