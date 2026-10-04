// The stop-point mod's $.state contract: one value per session, held by the host, so a hot reload of the
// module keeps it. Everything that used to live in ~/.claude/state/*stop-point*/<sid>.* files is here.

/** What the agent has been asked for and not yet delivered. `owner`: the next write of the point engages the hold. */
export type StopPointRequest = 'none' | 'owner'

/** The point as written in the current cycle (since the last compaction). */
export type StopPointRecord = {
  /** The file as the agent wrote it. */
  path: string
  /** When, ms since the epoch. */
  writtenAt: number
  /** Context tokens at the write (input + cache read + cache write of the last response); null when unknown. */
  tokens: number | null
}

export type StopPointSession = {
  /** Written in this cycle; reset by a compaction, so a point from before the last one never counts as fresh. */
  point: StopPointRecord | null
  /** Context at the last threshold request (mid-turn or at Stop); the next one waits for +growth. */
  askedAt: number | null
  /** Context at the first deferral of an auto-compaction; null while the gate is not waiting. */
  need: number | null
  /** Context at the last mid-turn reminder while the gate waits (one per 20k of growth). */
  naggedAt: number | null
  /** A Stop block was already spent on the current owner request or gate wait. */
  stopNagged: boolean
  /** A turn ended on an API error while the gate was waiting: the next auto-compaction passes. */
  escape: boolean
  request: StopPointRequest
  /** The owner's point is written: only reads and the point itself until the owner prompts or compacts. */
  hold: boolean
  /** Compactions begun in this session (main thread); the post-compaction injection is matched against it. */
  compactSeq: number
  /** The compactSeq whose point classic SessionStart(compact) already injected. */
  injectedSeq: number
  /** The point of the last compaction still has to reach the model (SessionStart did not carry it). */
  pointDue: boolean
  /** Model-only blocks waiting for the next main tool call or prompt (files and links the summary dropped). */
  pending: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'stop-point': { session: StopPointSession }
  }
}
