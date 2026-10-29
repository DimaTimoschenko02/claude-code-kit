// A task the replies name gets a row of its own: its id, its card's status and its card's title, so the owner reads
// what the task is about without remembering numbers. Only an id whose card file exists becomes a row: `UTF-8` or
// `SHA-256` match a task pattern too, and no card stands behind them.

import type { Card } from '../types'

export type { Card }

/** A card title is the owner's one-line summary; anything past this is cut so a broken card cannot flood the pane. */
export const TITLE_MAX = 160

function frontmatter(text: string): string | undefined {
  return /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
}

/** A YAML scalar as written on one line: double-quoted with its escapes, single-quoted with `''`, or bare. */
export function scalar(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\/nt])/g, (_m, c: string) => (c === 'n' || c === 't' ? ' ' : c))
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  return v.replace(/\s+#.*$/, '')
}

/** The card's `title:` as one bounded line, or undefined when the card has none. */
export function cardTitle(text: string): string | undefined {
  const head = frontmatter(text)
  const raw = head === undefined ? undefined : /^title:[ \t]*(.+?)[ \t]*$/m.exec(head)?.[1]
  if (raw === undefined) return undefined
  const flat = scalar(raw).replace(/\s+/g, ' ').trim()
  if (flat === '') return undefined
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat
}

/**
 * The task ids a reply names, first mention first, each once. A fenced code block is left out: a `git log` or a
 * listing pasted there names tasks nobody is working on; an id in a code span or a sentence counts.
 */
export function mentionedIds(answer: string, pattern: RegExp): string[] {
  const text = answer.replace(/```[\s\S]*?```/g, ' ')
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  const out: string[] = []
  for (const m of text.matchAll(re)) if (m[0] !== '' && !out.includes(m[0])) out.push(m[0])
  return out
}

/** `PH-197` → `PH`: an id whose prefix some card carries may be a card not indexed yet. */
export function prefixOf(id: string): string {
  return id.replace(/[-_]?\d+$/, '')
}

/** A card file's name as its task id, when the whole stem is one: `PH-197.md` → `PH-197`, `PH-1 Схема.md` → none. */
export function idOfFile(name: string, pattern: RegExp): string | undefined {
  const stem = /^(.+)\.md$/i.exec(name)?.[1]
  if (stem === undefined) return undefined
  const re = new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace('g', ''))
  return re.test(stem) ? stem : undefined
}
