// The «Ждёт тебя» block of a reply: what the session waits on the owner for — questions and forks, not only tasks.
import { plain } from './markup'

export const DEFAULT_WAIT_MARKER = 'Ждёт тебя'
/** A line of the block drawn in the pane; a longer one is cut (the reply keeps it whole). */
const MAX_LINE = 400

/** The marker as a pattern: spelt with ё or е, any case. '' turns the block off. */
export function markerRegex(marker: string | undefined): RegExp | null {
  const m = (marker ?? DEFAULT_WAIT_MARKER).trim()
  if (m === '') return null
  const src = m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[её]/giu, '[её]').replace(/\s+/g, '\\s+')
  return new RegExp(`^${src}`, 'iu')
}

const LIST_ITEM = /^(?:[-*+]|\d{1,3}[.)])\s+(.*)$/
const HEADING = /^\s{0,3}#{1,6}\s/
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/

/**
 * «ничего», or «от тебя ничего» alone or with its reason after a stop («от тебя ничего — чиню шаг 2»), whatever marks
 * it carries: replies write it both ways.
 */
function isNothing(text: string): boolean {
  const t = plain(text).toLowerCase().replace(/ё/g, 'е').replace(/[«»"'*]+/g, '').trim()
  return /^ничего[.!]?$/.test(t) || /^от тебя ничего(?:$|[.!,;:]|\s[—–-]\s)/.test(t)
}

/**
 * A bold opener that ran past the marker (`**Ждёт тебя: первый скелет — #120**, …`) leaves its closing `**` unpaired
 * once the marker is cut off: that one goes, paired marks stay.
 */
function bound(text: string): string {
  const raw = text.trim()
  const t = ((raw.match(/\*\*/g) ?? []).length % 2 === 1 ? raw.replace('**', '') : raw).trim()
  return t.length > MAX_LINE ? `${t.slice(0, MAX_LINE - 1)}…` : t
}

/** Words between the marker and its separator: «утром», «по-прежнему одно» — letters, spaces, a hyphen inside a word. */
const QUALIFIER = /^[\p{L}\s]*(?:\p{L}-\p{L}[\p{L}\s]*)*$/u

type Head = { heading: boolean; rest: string }

/**
 * A line that opens the block: the marker at the line's start, after a heading's `#` or a bold `**` and nothing else,
 * then `:` or a dash and the text, or nothing (a list follows). A short qualifier before the separator is allowed
 * («Ждёт тебя утром:»); without a separator only a heading or a line holding the marker alone opens it.
 */
function opener(line: string, marker: RegExp): Head | null {
  let s = line.replace(/^\s{0,3}/, '')
  const heading = /^#{1,6}\s+/.test(s)
  s = s.replace(/^#{1,6}\s+/, '').replace(/^(?:\*\*|__)\s*/, '')
  const m = marker.exec(s)
  if (m === null) return null
  s = s.slice(m[0].length)
  const sep = /^([^:—–*_\n]{0,30}?)\s*(?:\*\*|__)?\s*(?::|—|–|\s-\s)\s*(?:\*\*|__)?\s*/u.exec(s)
  if (sep !== null) return QUALIFIER.test(sep[1]!) ? { heading, rest: s.slice(sep[0].length).trim() } : null
  // No separator: the marker alone on its line (a list follows), or a heading with a short qualifier.
  const alone = /^\s*(?:\*\*|__)?\s*$/.test(s) || (heading && s.length <= 30 && QUALIFIER.test(s))
  return alone ? { heading, rest: '' } : null
}

/**
 * The lines of every «Ждёт тебя» block in a reply, in order: `[]` when the blocks say nothing waits, `null` when the
 * reply carries no block (a relay or a mid-turn reply leaves it out on purpose). Code blocks are not read.
 */
export function waitingLines(answer: string, marker: RegExp | null): string[] | null {
  if (marker === null) return null
  const lines = answer.replace(/```[\s\S]*?```/g, '').split('\n')
  let found = false
  const out: string[] = []
  for (let n = 0; n < lines.length; n++) {
    const head = opener(lines[n]!, marker)
    if (head === null) continue
    found = true
    if (head.rest !== '' && !head.rest.endsWith(':')) {
      if (!isNothing(head.rest)) out.push(bound(head.rest))
      continue
    }
    // A list follows (blank lines between items allowed), up to a heading, a rule or a paragraph.
    const items: string[] = []
    let k = n + 1
    for (; k < lines.length; k++) {
      const raw = lines[k]!
      if (raw.trim() === '') continue
      if (HEADING.test(raw) || RULE.test(raw)) break
      const item = LIST_ITEM.exec(raw.replace(/^\s{0,1}/, ''))
      if (item !== null && !/^\s{2,}/.test(raw)) items.push(item[1]!)
      else if (/^\s{2,}/.test(raw) && items.length > 0) items[items.length - 1] += ` ${raw.trim()}`
      else if (items.length === 0 && !head.rest.endsWith(':') && opener(raw, marker) === null) {
        // A heading followed by one paragraph: that paragraph is the line.
        items.push(raw.trim())
        k++
        break
      } else break
    }
    n = k - 1
    if (items.length === 1 && isNothing(items[0]!)) continue
    out.push(...items.map(bound))
  }
  return found ? out : null
}
