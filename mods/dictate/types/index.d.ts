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
 * Where voice mode last stopped a recording by itself, shown above the prompt
 * until the next chunk: `cap` = its 2-minute limit, `silence` = 15 s pause;
 * `excerpt` = the chunk's last sentences.
 */
export type DictateCut = {
  stop: 'cap' | 'silence'
  excerpt: string
}

declare module 'claude-code' {
  interface PluginState {
    /** `batch` is null while batch mode is off; `cut` null when the last chunk was not cut. */
    dictate: { batch: DictateBatch | null; cut: DictateCut | null }
  }
}
