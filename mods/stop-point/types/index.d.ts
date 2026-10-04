// The stop-point mod's $.state contract: one value per session, held by the host, so a hot reload of the
// module keeps it.

/** A background write the mod has claimed: its generation and when it started. */
export type StopPointRun = {
  gen: number
  /** ms since the epoch. */
  startedAt: number
}

/** Where the last write's transcript delta ended: the message count then and the last message's fingerprint. */
export type StopPointCursor = {
  count: number
  fp: string
}

/** What the last finished run did and cost, for /stop-point and the writes log. */
export type StopPointLastRun = {
  kind: 'written' | 'unchanged'
  /** ms since the epoch, when it finished. */
  at: number
  ms: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type StopPointSession = {
  /** The background write in flight (single flight); null when none. */
  writing: StopPointRun | null
  /** A reply ended while a write was in flight: one more write follows it. */
  dirty: boolean
  /** The last generation claimed (background and compaction writes alike). */
  gen: number
  /** The newest generation whose result landed; an older result that finishes later is dropped. */
  appliedGen: number
  /** The transcript position the point covers; null before the first write of this session (or after /clear). */
  cursor: StopPointCursor | null
  /** The last run that left the point current (written or confirmed unchanged). */
  last: StopPointLastRun | null
  /** Why the last run failed; cleared by the next success. */
  error: string | null
  /** Compactions begun in this session (main thread); the post-compaction injection is matched against it. */
  compactSeq: number
  /** The compactSeq whose point classic SessionStart(compact) already injected. */
  injectedSeq: number
  /** The point of the last compaction still has to reach the model (SessionStart did not carry it). */
  pointDue: boolean
  /** Model-only blocks waiting for the next main tool call or prompt (files and links the summary dropped). */
  pending: string[]
  /**
   * The session has no transcript for plugins (an Agent SDK or headless host: `$.session.messages` is not available).
   * The mod stands down in it for good: no write, no status, no error.
   */
  noTranscript: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'stop-point': { session: StopPointSession }
  }
}
