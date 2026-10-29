/** `wait`: a line of the reply's «Ждёт тебя» block — replaced whole by the next reply that carries the block. */
export type ItemKind = 'link' | 'note' | 'done' | 'wait'

export type Item = {
  id: string
  kind: ItemKind
  text: string
  href?: string
  task?: string
  checked: boolean
  by: 'auto' | 'tool' | 'owner'
  /** The main thread's reply that last carried it (`Panel.turn` then); absent on lines stored before replies were counted — old. */
  seen?: number
}

/** A task a reply named by its id: `seen` is that reply's `Panel.turn`. */
export type Mention = { task: string; seen: number }

/** What a task's card says (see hooks/cards.ts): its status and title, and its vault address when it is a vault note. */
export type Card = { status?: string; title?: string; href?: string }

/** Something only the owner can physically do; one per key, up until the condition is seen gone. */
export type Blocker = {
  /** `chrome`, `login:<host>`, `vpn`, `app:<name>`…: a later call with the same key rewrites or clears it. */
  key: string
  text: string
  href?: string
  /** When it first went up. */
  since: number
  by: 'detector' | 'tool'
}

export type Panel = {
  items: Item[]
  /** Absent on panels stored before blockers existed. */
  blockers?: Blocker[]
  /**
   * Tasks the replies named in passing, with a card behind them: each with the reply that last named it. The latest
   * reply's ids come last, in the order it named them. Absent on panels stored before mentions counted.
   */
  mentioned?: Mention[]
  /** Addresses the owner deleted: a later reply carrying them again does not bring them back. */
  dropped: string[]
  /** The owner's changes not yet shown to the model. */
  report: string[]
  seq: number
  at: number
  /** Main-thread replies counted so far: freshness is measured in work done, not in clock time. */
  turn: number
}

/** A GitHub pull request as `gh pr view` last reported it; `at` is when it was asked. */
export type Pr = {
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  review: string
  draft: boolean
  base: string
  at: number
}

/** A checked place on disk: where it really is, a folder or a file, and for a vault note its vault and note path. */
export type Target = { abs: string; dir: boolean; vault?: { name: string; note: string } }

/** What the session knows about the places its lines name (see hooks/refs.ts). */
export type Refs = {
  repo: string
  commits: readonly string[]
  files: Readonly<Record<string, Target>>
}

declare module 'claude-code' {
  interface PluginState {
    'session-panel': {
      panel: Panel
      editing: string | null
      /** A task id → what its card says, for every task the panel names that has a card file. */
      cards: Record<string, Card>
      /** `owner/repo#n` → the pull request's state. */
      prs: Record<string, Pr>
      /** What the owner unfolded: `more:<section>`, `closed`, `task:<id>`. */
      open: string[]
      refs: Refs
    }
  }
}
