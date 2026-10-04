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

declare module 'claude-code' {
  interface PluginState {
    'session-panel': { panel: Panel; editing: string | null; doneTasks: string[] }
  }
}
