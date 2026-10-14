export type ItemKind = 'link' | 'note' | 'done'

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

export type Panel = {
  items: Item[]
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
      /** A task id → its card's frontmatter `status:`, for every task the panel names that has a card file. */
      statuses: Record<string, string>
      /** `owner/repo#n` → the pull request's state. */
      prs: Record<string, Pr>
      /** What the owner unfolded: `more:<section>`, `closed`, `task:<id>`. */
      open: string[]
      refs: Refs
    }
  }
}
