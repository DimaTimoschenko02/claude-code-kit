export type ItemKind = 'link' | 'note' | 'done'

export type Item = {
  id: string
  kind: ItemKind
  text: string
  href?: string
  task?: string
  checked: boolean
  by: 'auto' | 'tool' | 'owner'
}

export type Panel = {
  items: Item[]
  /** Addresses the owner deleted: a later reply carrying them again does not bring them back. */
  dropped: string[]
  /** The owner's changes not yet shown to the model. */
  report: string[]
  seq: number
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
    'session-panel': { panel: Panel; editing: string | null; doneTasks: string[]; refs: Refs }
  }
}
