// The wake-resume mod's $.state contract: one value per session, held by the host, so a reload keeps a waiting cut.

/** A main turn the Mac's sleep cut, waiting for the Mac to be fully awake. */
export type WakeCut = {
  /** The cut turn's id; `stop:<ms>` while only StopFailure has named it. */
  turnId: string
  /** ms since the epoch, when the session saw the cut (at the next wake, often a dark one). */
  at: number
  /** ms since the epoch, when the cut turn began. */
  startedAt: number
}

export type WakeResumeSession = {
  /** The cut waiting for a full wake; null when none. */
  pending: WakeCut | null
  /** Turn ids already continued, newest last: one auto-continue per cut. */
  continued: string[]
  /** Auto-continues since the owner last wrote. */
  streak: number
}

declare module 'claude-code' {
  interface PluginState {
    'wake-resume': { session: WakeResumeSession }
  }
}
