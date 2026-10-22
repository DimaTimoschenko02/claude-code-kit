// Turns markdown blockquotes into plain paragraphs, so the terminal draws no quote bar that a mouse copy takes along.

type Fence = { depth: number; char: string; length: number }

const QUOTE = /^( {0,3})>/
const NESTED = /^ {0,3}>/
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/** Strips up to `max` quote markers; `depth` is how many it took off. */
export function stripMarkers(line: string, max: number): { rest: string; depth: number } {
  const head = QUOTE.exec(line)
  if (!head || max < 1) return { rest: line, depth: 0 }

  const indent = head[1] ?? ''
  let rest = line.slice(indent.length)
  let depth = 0
  while (depth < max) {
    const marker = depth === 0 ? /^>/.exec(rest) : NESTED.exec(rest)
    if (!marker) break
    rest = rest.slice(marker[0].length)
    if (rest.startsWith(' ') || rest.startsWith('\t')) rest = rest.slice(1)
    depth += 1
  }

  return { rest: indent + rest, depth }
}

function opening(line: string, depth: number): Fence | undefined {
  const m = OPEN_FENCE.exec(line)
  const run = m?.[1]
  if (!m || !run) return undefined
  const char = run.charAt(0)
  if (char === '`' && (m[2] ?? '').includes('`')) return undefined

  return { depth, char, length: run.length }
}

function closes(line: string, fence: Fence): boolean {
  const run = CLOSE_FENCE.exec(line)?.[1]

  return run !== undefined && run.charAt(0) === fence.char && run.length >= fence.length
}

/**
 * The text with every blockquote's markers taken off, nested ones too; a code fence outside a quote keeps its `>`
 * lines, one inside a quote loses only the quote's own markers. A blank line goes before a quote that followed text
 * directly, so it stays a paragraph of its own. Returns the same string when there is no quote.
 */
export function plainQuotes(text: string): string {
  if (!text.includes('>')) return text

  const out: string[] = []
  let fence: Fence | undefined
  let wasQuoted = false
  let changed = false

  for (const line of text.split('\n')) {
    if (fence) {
      const { rest, depth } = stripMarkers(line, fence.depth)
      if (depth === fence.depth) {
        if (closes(rest, fence)) fence = undefined
        out.push(rest)
        changed ||= depth > 0
        continue
      }
      // The quote ended and closed its fence with it; once unquoted that fence needs its own closing line.
      out.push(fence.char.repeat(fence.length))
      fence = undefined
      wasQuoted = false
    }

    const { rest, depth } = stripMarkers(line, Number.POSITIVE_INFINITY)
    if (depth === 0) {
      out.push(line)
      fence = opening(line, 0)
      if (line.trim() === '') wasQuoted = false
      continue
    }

    const previous = out[out.length - 1]
    if (!wasQuoted && previous !== undefined && previous.trim() !== '') out.push('')
    out.push(rest)
    fence = opening(rest, depth)
    wasQuoted = true
    changed = true
  }

  return changed ? out.join('\n') : text
}

/**
 * The quoted drafts of a reply, each as plain text a paste can send: the quote blocks in order (blocks parted by
 * blank lines alone count as one), markers off, emphasis and code ticks off, a link as `text (address)`.
 * A `>` line inside a code fence outside a quote is no quote.
 */
export function quoteBlocks(text: string): string[] {
  const blocks: string[][] = []
  let current: string[] | undefined
  let blank = false
  let fence: Fence | undefined

  for (const line of text.split('\n')) {
    if (fence) {
      if (closes(line, fence)) fence = undefined
      continue
    }
    if (QUOTE.test(line)) {
      if (!current) blocks.push((current = []))
      else if (blank) current.push('')
      blank = false
      current.push(line)
      continue
    }
    if (line.trim() === '') {
      blank = current !== undefined
      continue
    }
    if (current && !blank) {
      current.push(line)
      continue
    }
    current = undefined
    blank = false
    fence = opening(line, 0)
  }

  return blocks.map(lines => flattenInline(plainQuotes(lines.join('\n'))).trim()).filter(block => block !== '')
}

/** Inline markdown as the screen shows it, outside code fences: `**b**` → b, `` `c` `` → c, `[t](u)` → t (u). */
export function flattenInline(text: string): string {
  let inFence = false

  return text
    .split('\n')
    .map(line => {
      if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line

      return line
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_m, a?: string, b?: string) => a ?? b ?? '')
        .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) =>
          label === href ? href : `${label} (${href})`,
        )
    })
    .join('\n')
}
