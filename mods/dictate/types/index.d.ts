/**
 * A batch of dictated prompts held back from the model until released.
 *
 * `startedAt` is when batch mode was switched on (ms since the epoch); a batch
 * older than 12 h is discarded. `messages` are the held prompts, in order.
 */
export type DictateBatch = {
  startedAt: number
  messages: string[]
}

/**
 * The last chunk held in the pack, shown above the prompt until the next one:
 * `stop` = who ended it (`own` = the person, `cap` = voice mode's 2-minute
 * limit, `silence` = its 15 s pause); `excerpt` = the chunk's last sentences.
 */
export type DictateCut = {
  stop: 'own' | 'cap' | 'silence'
  excerpt: string
}

declare module 'claude-code' {
  interface PluginState {
    /** `batch` is null while batch mode is off; `cut` null before the first chunk of a pack. */
    dictate: { batch: DictateBatch | null; cut: DictateCut | null }
  }
}
