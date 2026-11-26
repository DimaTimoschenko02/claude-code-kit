// Pure parts of bash-trim: when an output is cut and what the model reads in its place. No `$` here.

/**
 * Outputs above this many characters (stdout + stderr) are cut. From the Smash Karts audit (26.11.2026, 26 520 Bash
 * calls of main sessions): p90 is 5.4k, p95 8k; above 6k sit 8.5% of the calls and 40% of all Bash output, and
 * cutting them to head + tail removes 28% of it. 4k would cut twice the calls for 6 points more; 8k only 21%.
 */
export const THRESHOLD = 6000
/** Characters kept from the start and from the end of a cut stream. */
export const HEAD = 2000
export const TAIL = 1000
/** Error-looking lines of the cut middle carried into the reply, each to this many characters. */
export const ERROR_LINES_MAX = 40
export const ERROR_LINE_CHARS = 300

const ERROR = /\b(error|errors|fail|failed|failure|failing|fatal|exception|traceback|panic|denied|cannot|unable|segfault|abort(ed)?)\b|err!|not found|no such file|✗|✘|❌/i

export const isErrorLine = (line: string): boolean => ERROR.test(line)

export type Cut = { text: string; omittedLines: number; omittedChars: number; errorLines: number }

/** Where the head ends: the last newline within HEAD, or HEAD itself when the lines are too long. */
function headEnd(text: string): number {
  const nl = text.lastIndexOf('\n', HEAD)
  return nl >= HEAD / 2 ? nl + 1 : HEAD
}

/** Where the tail starts: the first newline within the last TAIL characters, or exactly TAIL from the end. */
function tailStart(text: string): number {
  const from = text.length - TAIL
  const nl = text.indexOf('\n', from)
  return nl >= 0 && nl < text.length - TAIL / 2 ? nl + 1 : from
}

/** The error-looking lines of `middle`, bounded, as the reply shows them. */
function errorBlock(middle: string): { lines: string[]; total: number } {
  const all = middle.split('\n').filter(isErrorLine)
  const lines = all.slice(0, ERROR_LINES_MAX).map(l => (l.length > ERROR_LINE_CHARS ? `${l.slice(0, ERROR_LINE_CHARS - 1)}…` : l))
  return { lines, total: all.length }
}

/** One stream cut to head + a marker naming the full file + its error lines + tail; null when it is short enough. */
export function cutStream(text: string, fullPath: string): Cut | null {
  if (text.length <= HEAD + TAIL + 500) return null
  const h = headEnd(text)
  const t = tailStart(text)
  const middle = text.slice(h, t)
  const omittedLines = middle.split('\n').length - (middle.endsWith('\n') ? 1 : 0)
  const errors = errorBlock(middle)
  const marker = [
    `… [bash-trim: ${omittedLines} lines, ${middle.length} of ${text.length} chars left out; the full output is in ${fullPath} — Read it with offset/limit when you need more] …`,
    ...(errors.total > 0
      ? [`[error-looking lines of the cut part: ${errors.lines.length} of ${errors.total}]`, ...errors.lines, '[end of error-looking lines]']
      : []),
  ].join('\n')
  const glueHead = text.slice(0, h).endsWith('\n') ? '' : '\n'
  return { text: `${text.slice(0, h)}${glueHead}${marker}\n${text.slice(t)}`, omittedLines, omittedChars: middle.length, errorLines: errors.total }
}

/** What the full-output file holds: stdout, then stderr under a line of its own. */
export function fullText(stdout: string, stderr: string): string {
  return stderr === '' ? stdout : `${stdout}${stdout.endsWith('\n') || stdout === '' ? '' : '\n'}--- stderr ---\n${stderr}`
}

/** The file beside the session's transcript where the engine keeps its own persisted tool outputs. */
export function fullPathFor(base: string, toolUseId: string): string {
  const safe = toolUseId.replace(/[^A-Za-z0-9_-]/g, '_') || 'call'
  return `${base.replace(/\\/g, '/').replace(/\/+$/, '')}/bash-trim-${safe}.txt`
}

/** `<project>/<session>.jsonl` → `<project>/<session>/tool-results`, the engine's own folder for big outputs. */
export function toolResultsDir(transcriptPath: string): string | undefined {
  const p = transcriptPath.replace(/\\/g, '/')
  return /\.jsonl$/.test(p) ? `${p.replace(/\.jsonl$/, '')}/tool-results` : undefined
}

/** One trim as a journal line. */
export function journalLine(entry: { ts: string; session: string; before: number; after: number; ms: number; command: string }): string {
  return `${JSON.stringify({ ...entry, command: entry.command.replace(/\s+/g, ' ').trim().slice(0, 80) })}\n`
}

/** The journal with one line added, its oldest lines dropped past `cap` characters. */
export function appendBounded(old: string, line: string, cap = 256 * 1024): string {
  const text = old + line
  if (text.length <= cap) return text
  const tail = text.slice(text.length - Math.floor(cap / 2))
  return tail.slice(tail.indexOf('\n') + 1)
}

/** Trims since `sinceMs`: how many, characters before and after, the latest time, the slowest. */
export function summarize(text: string, sinceMs: number): { n: number; before: number; after: number; last?: string; maxMs: number } {
  const out = { n: 0, before: 0, after: 0, last: undefined as string | undefined, maxMs: 0 }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const e = JSON.parse(line) as { ts?: string; before?: number; after?: number; ms?: number }
      const at = Date.parse(e.ts ?? '')
      if (!Number.isFinite(at) || at < sinceMs) continue
      out.n += 1
      out.before += e.before ?? 0
      out.after += e.after ?? 0
      out.maxMs = Math.max(out.maxMs, e.ms ?? 0)
      out.last = e.ts
    } catch {
      // a torn line from a concurrent writer
    }
  }
  return out
}
