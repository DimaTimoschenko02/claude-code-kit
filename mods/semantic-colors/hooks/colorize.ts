// Pure planning: which blocks of a reply get coloured runs and which stay with the engine's own markdown renderer.
// No `$` here, so the tests and the sample command run the same code the render hook does.

import { LINE_RULE, RULES } from './rules'
import type { Rule } from './rules'

export type Run = {
  readonly text: string
  readonly color?: string
  readonly bold?: boolean
  readonly italic?: boolean
  readonly strike?: boolean
  readonly code?: boolean
  readonly href?: string
}

export type Line = {
  readonly prefix: string
  readonly runs: readonly Run[]
  readonly accent?: { readonly color: string; readonly bold: boolean }
}

export type Segment = { readonly kind: 'markdown'; readonly text: string } | { readonly kind: 'colored'; readonly lines: readonly Line[] }

type Compiled = { readonly rule: Rule; readonly re: RegExp }

export type RuleSet = { readonly rules: readonly Compiled[]; readonly line: Compiled | null; readonly broken: readonly string[] }

// The theme key the engine draws inline code in, so a coloured block keeps the owner's code colour.
export const CODE_COLOR = 'permission'

// Past this a reply is left to the engine whole: scanning stays cheap on a hot render path.
export const MAX_SCAN = 60_000

export function compileRules(rules: readonly Rule[] = RULES, line: Rule | null = LINE_RULE): RuleSet {
  const broken: string[] = []
  const compile = (rule: Rule, flags: string): Compiled | null => {
    try {
      return { rule, re: new RegExp(rule.pattern, `${flags}u${rule.caseSensitive ? '' : 'i'}`) }
    } catch (error) {
      broken.push(`${rule.name}: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }
  const compiled = rules.map(rule => compile(rule, 'g')).filter((c): c is Compiled => c !== null)
  return { rules: compiled, line: line ? compile(line, '') : null, broken }
}

// ---- splitting into blocks ----------------------------------------------------------------------------------------

const FENCE = /^\s*(`{3,}|~{3,})/
const BLANK = /^\s*$/
// A block holding any of these is the engine's to draw: tables, headings, rules, html, setext underlines.
const COMPLEX = [/^\s*\|/, /\S\s*\|\s*\S.*\|/, /^\s{0,3}#{1,6}(\s|$)/, /^\s{0,3}([-*_])(\s*\1){2,}\s*$/, /^\s*</, /^\s{0,3}(=+|-+)\s*$/]
const HEADING = /^\s{0,3}#{1,6}(\s|$)/

type Block = { readonly lines: readonly string[]; readonly fenced: boolean }

export function splitBlocks(text: string): Block[] {
  const blocks: { lines: string[]; fenced: boolean }[] = []
  let current: { lines: string[]; fenced: boolean } | null = null
  let fence: string | null = null
  let blanks: string[] = []
  const close = () => {
    if (current) blocks.push(current)
    current = null
  }
  for (const line of text.split('\n')) {
    if (fence !== null) {
      current?.lines.push(line)
      if (line.trim().startsWith(fence)) fence = null
      continue
    }
    if (BLANK.test(line)) {
      if (current) blanks.push(line)
      continue
    }
    const opens = FENCE.exec(line)
    const indented = /^\s/.test(line)
    // A line indented under the block before a blank (a list item's next paragraph, a fence inside an item)
    // belongs to that block: split there, the engine would read it as an indented code block.
    if (current && blanks.length > 0 && !indented) close()
    if (current && HEADING.test(line)) close()
    if (!current) blanks = []
    if (!current) current = { lines: [], fenced: false }
    current.lines.push(...blanks, line)
    blanks = []
    if (opens) {
      current.fenced = true
      fence = opens[1]?.[0]?.repeat(opens[1].length) ?? '```'
    }
    if (HEADING.test(line)) close()
  }
  close()
  return blocks
}

function isSimple(block: Block): boolean {
  if (block.fenced) return false
  const first = block.lines[0] ?? ''
  // Indented code at the top level: four spaces with no list marker.
  if (/^( {4}|\t)/.test(first) && !LIST.test(first)) return false
  return !block.lines.some(line => COMPLEX.some(re => re.test(line)))
}

// ---- inline markdown ------------------------------------------------------------------------------------------------

const LIST = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/
const QUOTE = /^\s*(?:>\s?)+/

type Style = { bold: boolean; italic: boolean; strike: boolean }

// Inline markdown of one line into styled pieces: code spans, links, bold, italic, strike, escapes.
export function inline(source: string): Run[] {
  const runs: Run[] = []
  const style: Style = { bold: false, italic: false, strike: false }
  let buffer = ''
  const flush = () => {
    if (buffer) runs.push({ text: buffer, ...(style.bold && { bold: true }), ...(style.italic && { italic: true }), ...(style.strike && { strike: true }) })
    buffer = ''
  }
  let i = 0
  while (i < source.length) {
    const ch = source[i] ?? ''
    if (ch === '\\' && i + 1 < source.length && /[!-/:-@[-`{-~]/.test(source[i + 1] ?? '')) {
      buffer += source[i + 1]
      i += 2
      continue
    }
    if (ch === '`') {
      const ticks = /^`+/.exec(source.slice(i))?.[0] ?? '`'
      const end = source.indexOf(ticks, i + ticks.length)
      if (end > 0 && source[end + ticks.length] !== '`') {
        flush()
        const body = source.slice(i + ticks.length, end)
        runs.push({ text: /^ .* $/.test(body) && body.trim() ? body.slice(1, -1) : body, code: true })
        i = end + ticks.length
        continue
      }
      buffer += ticks
      i += ticks.length
      continue
    }
    if (ch === '[') {
      const link = /^\[([^\]\n]+)\]\(\s*<?([^\s()<>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(source.slice(i))
      if (link) {
        flush()
        runs.push({ text: stripMarks(link[1] ?? ''), href: link[2] ?? '' })
        i += link[0].length
        continue
      }
    }
    if (ch === '<') {
      const auto = /^<(https?:\/\/[^\s<>]+)>/.exec(source.slice(i))
      if (auto) {
        flush()
        runs.push({ text: auto[1] ?? '', href: auto[1] ?? '' })
        i += auto[0].length
        continue
      }
    }
    const two = source.slice(i, i + 2)
    if (two === '**' || two === '__' || two === '~~') {
      const key = two === '~~' ? 'strike' : 'bold'
      if (canToggle(source, i, 2, style[key], two)) {
        flush()
        style[key] = !style[key]
        i += 2
        continue
      }
    }
    if (ch === '*' || ch === '_') {
      if (canToggle(source, i, 1, style.italic, ch)) {
        flush()
        style.italic = !style.italic
        i += 1
        continue
      }
    }
    buffer += ch
    i += 1
  }
  flush()
  return runs
}

// An emphasis mark opens before a non-space with a closing mark later on the line, and closes after a non-space.
// `_` never opens or closes inside a word (snake_case stays as written).
function canToggle(source: string, at: number, width: number, isOpen: boolean, mark: string): boolean {
  const before = source[at - 1] ?? ' '
  const after = source[at + width] ?? ' '
  const wordy = /[\p{L}\p{N}]/u
  if (mark[0] === '_' && wordy.test(before) && wordy.test(after)) return false
  if (isOpen) return !/\s/.test(before)
  if (/\s/.test(after) || after === mark[0]) return false
  return source.indexOf(mark, at + width + 1) > 0
}

function stripMarks(label: string): string {
  return label.replace(/\*\*|__|`/g, '')
}

// ---- rules over runs ------------------------------------------------------------------------------------------------

type Hit = { start: number; end: number; order: number; rule: Rule }

export function findHits(text: string, set: RuleSet): Hit[] {
  const hits: Hit[] = []
  set.rules.forEach(({ rule, re }, order) => {
    re.lastIndex = 0
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      if (m[0].length === 0) {
        re.lastIndex += 1
        continue
      }
      hits.push({ start: m.index, end: m.index + m[0].length, order, rule })
    }
  })
  hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.order - b.order)
  const kept: Hit[] = []
  let reach = 0
  for (const hit of hits) {
    if (hit.start < reach) continue
    kept.push(hit)
    reach = hit.end
  }
  return kept
}

function colorRun(run: Run, set: RuleSet): Run[] {
  if (run.code) return [{ ...run, color: CODE_COLOR }]
  if (run.href !== undefined) return [{ ...run, color: urlColor(set) }]
  const hits = findHits(run.text, set)
  if (hits.length === 0) return [run]
  const out: Run[] = []
  let at = 0
  for (const hit of hits) {
    if (hit.start > at) out.push({ ...run, text: run.text.slice(at, hit.start) })
    const piece = run.text.slice(hit.start, hit.end)
    const isUrl = hit.rule.name === 'url'
    out.push({
      ...run,
      text: piece,
      color: hit.rule.color,
      ...(hit.rule.bold && { bold: true }),
      ...(isUrl && { href: piece }),
    })
    at = hit.end
  }
  if (at < run.text.length) out.push({ ...run, text: run.text.slice(at) })
  return out
}

function urlColor(set: RuleSet): string | undefined {
  return set.rules.find(c => c.rule.name === 'url')?.rule.color
}

// ---- the plan -------------------------------------------------------------------------------------------------------

export function hasHit(text: string, set: RuleSet): boolean {
  const prose = text.replace(/`+[^`\n]*`+/g, ' ')
  if (set.line && prose.split('\n').some(line => set.line?.re.test(lineHead(line)))) return true
  return findHits(prose, set).length > 0
}

function lineHead(line: string): string {
  return line
    .replace(QUOTE, '')
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, '')
    .replace(/^(?:\*\*|__)/, '')
    .trimStart()
}

function planLine(raw: string, set: RuleSet): Line {
  const line = raw.replace(QUOTE, '').replace(/\s+$/, '')
  const list = LIST.exec(line)
  const marker = list ? `${list[1] ?? ''}${/\d/.test(list[2] ?? '') ? list[2] : '-'}${' '}` : ''
  const body = list ? (list[4] ?? '') : line.replace(/^\s+/, '')
  const indent = list ? '' : (/^\s*/.exec(line)?.[0] ?? '')
  const runs = inline(body).flatMap(run => colorRun(run, set))
  const isAccent = set.line?.re.test(lineHead(raw)) ?? false
  return {
    prefix: marker || indent,
    runs,
    ...(isAccent && set.line && { accent: { color: set.line.rule.color, bold: set.line.rule.bold ?? false } }),
  }
}

// Null: nothing to colour, the engine draws the reply as it is.
export function plan(text: string, set: RuleSet): Segment[] | null {
  if (text.length > MAX_SCAN || !hasHit(text, set)) return null
  const segments: Segment[] = []
  let pending: string[] = []
  const flushMarkdown = () => {
    if (pending.length > 0) segments.push({ kind: 'markdown', text: pending.join('\n\n') })
    pending = []
  }
  let colored = 0
  for (const block of splitBlocks(text)) {
    const joined = block.lines.join('\n')
    if (isSimple(block) && hasHit(joined, set)) {
      flushMarkdown()
      segments.push({ kind: 'colored', lines: block.lines.map(line => (BLANK.test(line) ? { prefix: '', runs: [] } : planLine(line, set))) })
      colored += 1
    } else {
      pending.push(joined)
    }
  }
  flushMarkdown()
  return colored > 0 ? segments : null
}
