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

declare module 'claude-code' {
  interface PluginState {
    /** `batch` is null while batch mode is off. */
    dictate: { batch: DictateBatch | null }
  }
}
