// The observer mod's $.state contract: per session, held by the host, so a hot reload of the module and a
// compaction keep it.

/** A background check the mod has claimed: its generation and when it started. */
export type ObserverRun = {
  gen: number
  /** ms since the epoch. */
  startedAt: number
}

/** Where the last check's transcript delta ended: the message count then and the last message's fingerprint. */
export type ObserverCursor = {
  count: number
  fp: string
}

/** One thing the mod counts across the session (a Bash command, a hook block, a denial, an API error). */
export type ObserverCounter = {
  /** What it is, in Russian, for the observer and /observer. */
  label: string
  n: number
  /** ms since the epoch: the checks that first and last saw it. */
  first: number
  last: number
  /** The highest threshold (3, 6, 12, …) already passed to the observer; 0 before the first. */
  reported: number
}

export type ObserverFinding = {
  at: number
  kind: 'KNOW' | 'REPEAT'
  text: string
  /** A REPEAT resting on a counted FACT (only those reach the band). */
  fact: boolean
}

/** What the last finished check cost, for /observer. */
export type ObserverLastCheck = {
  at: number
  ms: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  lines: number
}

export type ObserverSession = {
  /** The check in flight (single flight); null when none. */
  checking: ObserverRun | null
  /** A reply ended while a check was in flight: one more check follows it. */
  dirty: boolean
  gen: number
  /** The transcript position the last check covered; null before the first one (or after /clear). */
  cursor: ObserverCursor | null
  /** The observer's own notes for this session, rewritten by every check. */
  notes: string
  /** The owner switched it off for this session (/observer off). */
  off: boolean
  /** The host keeps no transcript for plugins (an SDK run): the mod stands down for the session. */
  noTranscript: boolean
  counters: Record<string, ObserverCounter>
  /** Tool use ids already counted, newest last, bounded: a lost cursor never counts a call twice. */
  seenIds: string[]
  /** Newest last, bounded. */
  findings: ObserverFinding[]
  /** REPEAT lines the main model has not read yet: injected once with the next prompt. */
  unseen: string[]
  checks: number
  last: ObserverLastCheck | null
  error: string | null
}

/** The line in the band above the prompt; null when nothing is shown. */
export type ObserverBand = {
  text: string
  kind: 'KNOW' | 'REPEAT'
  at: number
  /** Owner prompts since it appeared; it goes after BAND_PROMPTS of them. */
  prompts: number
} | null

declare module 'claude-code' {
  interface PluginState {
    observer: { session: ObserverSession; band: ObserverBand }
  }
}
