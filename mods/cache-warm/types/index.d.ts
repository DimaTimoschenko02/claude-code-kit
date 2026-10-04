export type WarmMode = 'auto' | 'on' | 'off'

/** One session's choice, kept across restarts: absent fields fall back to the default. */
export type SessionWarm = { mode: WarmMode; hours?: number; at: number }
