// A line names places without marking them up: a PR as `#140`, a commit by its sha, a file by its path, a bare
// address, a task by its id. Each becomes a link where it stands, not only in the links section. Only what is known to
// lead somewhere is linked: a sha git has as a commit, a path that exists — a job id or `PH-96/97` looks the same and
// stays text.
import type { Refs } from '../types'
import { SCHEMES } from './markup'
import type { Run } from './markup'

// Refs (kept in state, filled by git and the disk): `repo` is `https://github.com/<owner>/<name>` or '' when unknown,
// `commits` the shas as written that git has as commits, `files` a path as written (no `:line`) → what exists there.
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

/** What a line names that must be checked before it is linked: shas for git, paths for the disk. */
export function candidates(text: string): { shas: string[]; paths: string[] } {
  return {
    shas: [...text.matchAll(SHA)].map(m => m[0]).filter(shaLike),
    paths: paths(text).map(h => h.path),
  }
}

function encodePath(abs: string): string {
  return abs.split('/').map(s => encodeURIComponent(s)).join('/')
}

/** A file opens in the IDE at its line; a folder in Finder, never an app bundle — opening one runs it. */
export function fileHref(file: { abs: string; dir: boolean }, line?: string): string | undefined {
  if (file.dir) return /\.app$/i.test(file.abs) ? undefined : `file://${encodePath(file.abs)}`
  return `webstorm://open?file=${encodePath(file.abs)}${line === undefined ? '' : `&line=${line}`}`
}

type Span = { start: number; end: number; href: string }

/** Where each place the text names starts and ends, and where it leads; overlapping hits keep the earliest, longest. */
export function spans(text: string, at: Places): Span[] {
  const all: Span[] = []
  for (const m of text.matchAll(URL_RE)) {
    const href = m[0].replace(/[.,;:!?*_]+$/u, '')
    all.push({ start: m.index, end: m.index + href.length, href })
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
    if (href !== undefined && m[0] !== '') all.push({ start: m.index, end: m.index + m[0].length, href })
  }
  all.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: Span[] = []
  for (const s of all) if (s.start >= (out.at(-1)?.end ?? 0)) out.push(s)
  return out
}

/** The runs with every place they name made a link where it stands; a run that is a link already stays whole. */
export function linked(list: Run[], at: Places): Run[] {
  return list.flatMap(run => {
    if (run.href !== undefined) return [run]
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
