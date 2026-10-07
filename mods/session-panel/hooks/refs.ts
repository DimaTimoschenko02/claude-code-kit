// A line names places without marking them up: a PR as `#140`, a commit by its sha, a file by its path, a bare
// address, a task by its id. Each becomes a link where it stands, not only in the links section. Only what is known to
// lead somewhere is linked: a sha git has as a commit, a path that exists — a job id or `PH-96/97` looks the same and
// stays text.
//
// The text comes from model replies, and through them from pages and tool output: it is untrusted. Every address the
// pane draws passes one gate, `gate()`: the web, the vault's `open`, and an editor link only to a file this mod found
// inside an allowed root and judged unable to run. Anything else draws as plain text.
import type { Refs } from '../types'
import { runs, SCHEMES } from './markup'
import type { Run } from './markup'

// Refs (kept in state, filled by git and the disk): `repo` is `https://github.com/<owner>/<name>` or '' when unknown,
// `commits` the shas as written that git has as commits, `files` a path as written (no `:line`) → where it really is,
// for a path that passed every check of `blocked`, `within` and the exec bit.
export type { Refs }

export type Places = Refs & {
  /** A task id → its card's address, for the tasks whose card is in the panel. */
  cards: ReadonlyMap<string, string>
  task: RegExp
}

export const NO_REFS: Refs = { repo: '', commits: [], files: {} }

const URL_RE = new RegExp(`${SCHEMES}:\\/\\/[^\\s<>()\`'"\\]«»]+`, 'gu')
// `owner/name#140`: another repo's PR or issue.
const REPO_NUM = /(?<![\p{L}\p{N}_./-])([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)#(\d{1,7})(?![\p{L}\p{N}_])/gu
// `#140`, not an anchor in an address or an HTML entity.
const NUM = /(?<![\p{L}\p{N}_&/#-])#(\d{1,7})(?![\p{L}\p{N}_])/gu
// A hex run standing alone; a UUID's parts are glued to dashes and are no sha.
const SHA = /(?<![\p{L}\p{N}_/.-])[0-9a-f]{7,40}(?![\p{L}\p{N}_-])/gu
// A path with at least one slash, absolute, from home, or relative; `:line` after it.
const PATH = /(?<![\p{L}\p{N}_/.:~@+-])(?:~\/|\/)?[\p{L}\p{N}_.@+-]+(?:\/[\p{L}\p{N}_.@+-]+)*\/?(?::(\d+))?/gu
// An editor link as `ws link` writes it: a file and a line, nothing else.
const IDE = /^(?:webstorm|jetbrains):\/\/open\?file=([^&#\s]+)(?:&line=(\d{1,7}))?$/

/** A folder macOS opens by running it, anywhere along a path. */
const BUNDLE = /\.(?:app|appex|bundle|framework|plugin|kext|pkg|mpkg|workflow|xpc|prefpane|saver|qlgenerator|mdimporter|action|component|scptd)$/i
/** A file a click could run, install or hand to a launcher, whatever app opens it. */
const RUNNABLE = /\.(?:command|sh|bash|zsh|csh|ksh|fish|tool|terminal|webloc|inetloc|fileloc|workflow|pkg|mpkg|dmg|app|scpt|applescript|jar)$/i

/** A sha candidate has a digit and a letter: `1234567` is a number, `defaced` a word. */
function shaLike(text: string): boolean {
  return /\d/.test(text) && /[a-f]/.test(text)
}

type Hit = { start: number; end: number; path: string; line?: string }

function paths(text: string): Hit[] {
  const out: Hit[] = []
  for (const m of text.matchAll(PATH)) {
    // A sentence's full stop or comma after a path is the sentence's.
    const raw = m[1] === undefined ? m[0].replace(/[.,]+$/, '') : m[0]
    const path = (m[1] === undefined ? raw : raw.slice(0, raw.length - m[1].length - 1)).replace(/\/$/, '')
    if (!path.includes('/') || path === '~') continue
    out.push({ start: m.index, end: m.index + raw.length, path, ...(m[1] === undefined ? {} : { line: m[1] }) })
  }
  return out
}

/** The file and line an editor link names, or undefined for any other address or extra parameter. */
export function ideTarget(href: string): { path: string; line?: string } | undefined {
  const m = IDE.exec(href)
  if (m === null) return undefined
  let path: string
  try {
    path = decodeURIComponent(m[1]!)
  } catch {
    return undefined
  }
  return { path, ...(m[2] === undefined ? {} : { line: m[2] }) }
}

/**
 * What a raw line names that must be checked before it is linked: shas for git, paths for the disk — the bare ones,
 * and the files of editor links written as markdown or bare, so those pass the same check.
 */
export function candidates(raw: string): { shas: string[]; paths: string[] } {
  const list = runs(raw)
  const text = list.map(r => r.text).join('')
  const ide = [...list.flatMap(r => (r.href === undefined ? [] : [r.href])), ...[...text.matchAll(URL_RE)].map(m => m[0])]
    .map(h => ideTarget(h)?.path)
    .filter((p): p is string => p !== undefined)
  return {
    shas: [...text.matchAll(SHA)].map(m => m[0]).filter(shaLike),
    paths: [...paths(text).map(h => h.path), ...ide],
  }
}

/** True when `path` is one of `roots` or lies under one; both absolute, compared by whole segments. */
export function within(path: string, roots: readonly string[]): boolean {
  return roots.some(r => r !== '' && (path === r || path.startsWith(r.endsWith('/') ? r : `${r}/`)))
}

/**
 * Where a written path would be, by spelling alone and before any disk access: absolute, from home, or under one of
 * `bases`, and only inside `roots`. A `.` or `..` part is refused rather than folded — what it lands on is the disk's
 * to say, and the disk is asked only about paths inside the roots (no probing a network mount by its name).
 */
export function placeByName(path: string, bases: readonly string[], home: string, roots: readonly string[]): string[] {
  if (path.split('/').some(s => s === '.' || s === '..')) return []
  const spelled = path.startsWith('~/')
    ? home === '' ? [] : [`${home}${path.slice(1)}`]
    : path.startsWith('/') ? [path] : bases.filter(b => b !== '').map(b => `${b}/${path}`)
  return [...new Set(spelled)].filter(p => within(p, roots))
}

/** A target a click must never reach: a bundle anywhere along the path, or a file a launcher would run. */
export function blocked(path: string, dir: boolean): boolean {
  const parts = path.split('/')
  if (parts.some(s => BUNDLE.test(s))) return true
  return !dir && RUNNABLE.test(parts.at(-1) ?? '')
}

/** A unix mode (`%p` of stat, octal) with any execute bit: a file that runs when a launcher opens it. */
export function executable(mode: string): boolean {
  const n = Number.parseInt(mode, 8)
  return Number.isNaN(n) || (n & 0o111) !== 0
}

function encodePath(abs: string): string {
  return abs.split('/').map(s => encodeURIComponent(s)).join('/')
}

/** A checked file opens in the editor at its line; a checked folder in Finder. Nothing else is built here. */
export function fileHref(file: { abs: string; dir: boolean }, line?: string): string | undefined {
  if (blocked(file.abs, file.dir)) return undefined
  if (file.dir) return `file://${encodePath(file.abs)}/`
  return `webstorm://open?file=${encodePath(file.abs)}${line === undefined ? '' : `&line=${line}`}`
}

/**
 * The one gate for every address the pane draws: the web, the vault's `open`, and an editor link only when its file
 * is one this mod checked — rebuilt from that check, so no parameter the text chose survives. Anything else: undefined,
 * drawn as plain text.
 */
export function gate(href: string, files: Refs['files']): string | undefined {
  if (/^https?:\/\/[^\s]+$/i.test(href)) return href
  if (/^obsidian:\/\/open\?[^\s]*$/.test(href)) return href
  const ide = ideTarget(href)
  if (ide === undefined) return undefined
  const file = files[ide.path]
  return file === undefined || file.dir ? undefined : fileHref(file, ide.line)
}

type Span = { start: number; end: number; href: string }

/** Where each place the text names starts and ends, and where it leads; overlapping hits keep the earliest, longest. */
export function spans(text: string, at: Places): Span[] {
  const all: Span[] = []
  for (const m of text.matchAll(URL_RE)) {
    const written = m[0].replace(/[.,;:!?*_]+$/u, '')
    const href = gate(written, at.files)
    if (href !== undefined) all.push({ start: m.index, end: m.index + written.length, href })
  }
  for (const h of paths(text)) {
    const file = at.files[h.path]
    const href = file === undefined ? undefined : fileHref(file, h.line)
    if (href !== undefined) all.push({ start: h.start, end: h.end, href })
  }
  for (const m of text.matchAll(REPO_NUM)) {
    all.push({ start: m.index, end: m.index + m[0].length, href: `https://github.com/${m[1]}/issues/${m[2]}` })
  }
  if (at.repo !== '') {
    // GitHub sends `/issues/N` on to the PR when N is one; `/pull/N` of an issue is not certain to.
    for (const m of text.matchAll(NUM)) all.push({ start: m.index, end: m.index + m[0].length, href: `${at.repo}/issues/${m[1]}` })
    for (const m of text.matchAll(SHA)) {
      if (at.commits.includes(m[0])) all.push({ start: m.index, end: m.index + m[0].length, href: `${at.repo}/commit/${m[0]}` })
    }
  }
  const task = new RegExp(at.task.source, at.task.flags.includes('g') ? at.task.flags : `${at.task.flags}g`)
  for (const m of text.matchAll(task)) {
    const href = at.cards.get(m[0])
    const safe = href === undefined ? undefined : gate(href, at.files)
    if (safe !== undefined && m[0] !== '') all.push({ start: m.index, end: m.index + m[0].length, href: safe })
  }
  all.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: Span[] = []
  for (const s of all) if (s.start >= (out.at(-1)?.end ?? 0)) out.push(s)
  return out
}

/**
 * The runs with every place they name made a link where it stands. A markdown link passes the same gate as a bare
 * address: one that fails draws as its label, plain.
 */
export function linked(list: Run[], at: Places): Run[] {
  return list.flatMap(run => {
    if (run.href !== undefined) {
      const href = gate(run.href, at.files)
      if (href !== undefined) return [{ ...run, href }]
      const { href: _drop, ...plainRun } = run
      void _drop
      return [plainRun]
    }
    const found = spans(run.text, at)
    if (found.length === 0) return [run]
    const out: Run[] = []
    let pos = 0
    for (const s of found) {
      if (s.start > pos) out.push({ ...run, text: run.text.slice(pos, s.start) })
      out.push({ ...run, text: run.text.slice(s.start, s.end), href: s.href })
      pos = s.end
    }
    if (pos < run.text.length) out.push({ ...run, text: run.text.slice(pos) })
    return out
  })
}

/** `https://github.com/<owner>/<name>` from a remote's address, ssh or https; '' for any other host. */
export function githubRepo(remote: string): string {
  const m = /github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.trim())
  return m === null ? '' : `https://github.com/${m[1]}/${m[2]}`
}

/** The repo most of the panel's GitHub links point into: the fallback when the session's folder is no repo. */
export function repoOfLinks(hrefs: readonly string[]): string {
  const count = new Map<string, number>()
  for (const href of hrefs) {
    const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\/(?:pull|issues|commit|blob|tree)\//.exec(href)
    if (m !== null) count.set(m[1]!, (count.get(m[1]!) ?? 0) + 1)
  }
  const best = [...count].sort((a, b) => b[1] - a[1])[0]
  return best === undefined ? '' : `https://github.com/${best[0]}`
}
