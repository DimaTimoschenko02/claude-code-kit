/** `stale`: unfinished, but the rollout file has been silent longer than `staleMinutes`. */
export type RunPhase = 'running' | 'starting' | 'stale' | 'done' | 'failed'

/** One Codex thread (one rollout file) as the pane draws it. */
export type Run = {
  thread: string
  /** The task id a wrapper's files name, else the prompt's first line. */
  label: string
  /** Basename of the run's working directory. */
  cwd: string
  /** Who started it when not the plain CLI (`Claude Code` for the codex plugin). */
  origin?: string
  phase: RunPhase
  /** When the current turn started (the thread's start before its first turn). */
  startAt: number
  /** The current turn's time: until now while unfinished, until its end once finished. */
  elapsedMs: number
  /** Since the rollout file last changed. */
  silentMs: number
  /** When the turn finished. */
  endAt?: number
  /** The last command or agent message, one masked line. */
  action: string
  /** A finished turn's final answer, its first line. */
  result?: string
  /** Why a failed run failed, in words (`usage limit reached`, `never started`, `no events for 1h 05m`). */
  reason?: string
  tokens?: number
}

export type UsageWindow = { minutes: number; pct: number; resetsAt?: number }

/** The newest `rate_limits` any rollout carried. */
export type Usage = { plan?: string; windows: UsageWindow[]; reached?: string; at: number }

export type View = {
  /** When the scan ran; 0 before the first one. */
  at: number
  runs: Run[]
  usage?: Usage
  /** Why the scan could not read the sessions folder. */
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'codex-agents': {
      view: Shaped<View>
      /** The moment the pane last redrew its clock: the «updated Ns ago» moves with it between scans. */
      now: number
    }
  }
}
