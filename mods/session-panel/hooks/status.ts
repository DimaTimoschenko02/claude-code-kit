// What a task row says about its state: the card's status and each pull request's, as short coloured badges.
import type { Pr } from '../types'

/** A badge: the words, a theme colour (emoji carry colour where a surface draws none), dim when unknown. */
export type Badge = { text: string; color?: string; dim?: true }

const CARD: readonly [RegExp, Badge][] = [
  [/^backlog$/i, { text: '💤 бэклог', dim: true }],
  [/^(?:to ?do|open|new)$/i, { text: '📋 к работе', color: 'inactive' }],
  [/^(?:in ?progress|doing|wip)$/i, { text: '⚙ в работе', color: 'suggestion' }],
  [/^(?:in ?)?review$/i, { text: '👀 ждёт ревью', color: 'warning' }],
  [/^(?:testing|in ?testing|qa)$/i, { text: '🧪 на стенде', color: 'merged' }],
  [/^(?:done|closed|merged)$/i, { text: '✅ готово', color: 'success' }],
  [/^verified\b/i, { text: '✅ принято', color: 'success' }],
]

/** A card status as its badge; a status no rule knows is shown as written, dim. */
export function cardBadge(status: string): Badge {
  const s = status.trim()
  for (const [re, badge] of CARD) if (re.test(s)) return badge
  return { text: s.length > 24 ? `${s.slice(0, 23)}…` : s, dim: true }
}

/** The card's frontmatter `status:`, or undefined when the card has none. */
export function cardStatus(text: string): string | undefined {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const status = head === null ? undefined : /^status:\s*["']?(.+?)["']?\s*$/m.exec(head[1]!)?.[1]
  return status === undefined || status === '' ? undefined : status
}

export function isDoneStatus(status: string | undefined, doneStatuses: readonly string[]): boolean {
  return status !== undefined && doneStatuses.some(s => s.toLowerCase() === status.toLowerCase())
}

// Only these reach `gh` as arguments: a name that starts with a dash would read as an option.
const NAME = '[A-Za-z0-9][A-Za-z0-9_.-]{0,99}'
const PULL = new RegExp(`^https://github\\.com/(${NAME})/(${NAME})/pull/(\\d{1,7})(?:[/?#].*)?$`)

/** A GitHub pull request address as `{ repo, number, key }`; anything else (GitLab, a typo) is not one. */
export function pullOf(href: string): { repo: string; number: string; key: string } | undefined {
  const m = PULL.exec(href)
  if (m === null || m[1]!.includes('..') || m[2]!.includes('..')) return undefined
  const repo = `${m[1]}/${m[2]!.replace(/\.git$/, '')}`
  return { repo, number: m[3]!, key: `${repo}#${m[3]}` }
}

export const GH_FIELDS = 'state,reviewDecision,isDraft,baseRefName,mergedAt'

/** `gh pr view --json` output as a Pr, or null when it is not what gh writes. */
export function parsePr(stdout: string, at: number): Pr | null {
  let v: unknown
  try {
    v = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const state = o.state === 'OPEN' || o.state === 'MERGED' || o.state === 'CLOSED' ? o.state : undefined
  if (state === undefined) return null
  return {
    state,
    review: typeof o.reviewDecision === 'string' ? o.reviewDecision : '',
    draft: o.isDraft === true,
    base: typeof o.baseRefName === 'string' ? o.baseRefName.slice(0, 60) : '',
    at,
  }
}

/** What a pull request's state says after its `PR #n`: merged names the branch it went into. */
export function prBadge(pr: Pr): Badge {
  if (pr.state === 'MERGED') return { text: pr.base === '' ? '→ влит' : `→ ${pr.base}`, color: 'merged' }
  if (pr.state === 'CLOSED') return { text: 'закрыт', dim: true }
  if (pr.draft) return { text: 'черновик', dim: true }
  if (pr.review === 'APPROVED') return { text: 'апрув', color: 'success' }
  if (pr.review === 'CHANGES_REQUESTED') return { text: 'правки', color: 'error' }
  return { text: 'ждёт ревью', color: 'warning' }
}

export function isTerminal(pr: Pr | undefined): boolean {
  return pr !== undefined && pr.state !== 'OPEN'
}
