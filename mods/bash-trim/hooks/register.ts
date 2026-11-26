import type { EngineInterface as Engine, Register } from 'claude-code'

import { appendBounded, cutStream, fullPathFor, fullText, journalLine, summarize, THRESHOLD, toolResultsDir } from './trim'

const DAY_MS = 24 * 60 * 60 * 1000
let journalQueue: Promise<void> = Promise.resolve()

/** HOME is unset in the Claude process on Windows; USERPROFILE is its home there. */
async function homeDir($: Engine): Promise<string | undefined> {
  const home = (await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined))
  return home ? home.replace(/\\/g, '/').replace(/\/+$/, '') : undefined
}

function debug($: Engine, text: string): void {
  try {
    $.ui.log(text, { to: 'debug' })
  } catch {
    // logging must never fail a call
  }
}

const journalPath = (home: string) => `${home}/.claude/state/bash-trim/trims.jsonl`

/** Where this session keeps full outputs: its transcript's tool-results folder, else its scratchpad, else the state dir. */
async function outputDir($: Engine): Promise<string | undefined> {
  const info = await $.session.info().catch(() => undefined)
  const beside = info?.transcriptPath ? toolResultsDir(info.transcriptPath) : undefined
  if (beside) return beside
  if (info?.scratchpadDir) return `${info.scratchpadDir.replace(/\\/g, '/')}/bash-trim`
  const home = await homeDir($)
  return home ? `${home}/.claude/state/bash-trim/outputs` : undefined
}

async function record($: Engine, entry: { before: number; after: number; ms: number; command: string }): Promise<void> {
  try {
    const home = await homeDir($)
    if (!home) return
    const [session, now] = await Promise.all([$.session.id().catch(() => '?'), $.clock.now().catch(() => Date.now())])
    const line = journalLine({ ts: new Date(now).toISOString(), session, ...entry })
    const path = journalPath(home)
    const write = journalQueue.then(async () => {
      const old = await $.fs.read(path).catch(() => '')
      await $.fs.write(path, appendBounded(typeof old === 'string' ? old : '', line))
    })
    journalQueue = write.catch(() => undefined)
    await write
  } catch (err) {
    debug($, `bash-trim journal write failed: ${String(err)}`)
  }
}

type BashRecord = { stdout?: unknown; stderr?: unknown; isImage?: boolean; backgroundTaskId?: string; structuredContent?: unknown[]; persistedOutputPath?: string }

/** The record to give the model in place of `r`, with what it cost; null leaves the result as core made it. */
async function trimmed($: Engine, id: string, r: BashRecord): Promise<{ record: BashRecord; before: number; after: number } | null> {
  if (typeof r.stdout !== 'string' || typeof r.stderr !== 'string') return null
  if (r.isImage || r.backgroundTaskId || (r.structuredContent?.length ?? 0) > 0) return null
  const before = r.stdout.length + r.stderr.length
  if (before <= THRESHOLD) return null
  // The engine already keeps a huge output whole; else the full text goes beside the transcript first, and a failed
  // write leaves the output uncut: nothing is hidden that the model could not read back.
  let path = r.persistedOutputPath
  if (!path) {
    const dir = await outputDir($)
    if (!dir) return null
    path = fullPathFor(dir, id)
    await $.fs.write(path, fullText(r.stdout, r.stderr))
  }
  const out = cutStream(r.stdout, path)
  // stderr is where the errors are: kept whole unless it alone is over the threshold.
  const err = r.stderr.length > THRESHOLD ? cutStream(r.stderr, path) : null
  if (!out && !err) return null
  const record = { ...r, stdout: out?.text ?? r.stdout, stderr: err?.text ?? r.stderr }
  return { record, before, after: record.stdout.length + record.stderr.length }
}

async function commandText($: Engine): Promise<string> {
  const home = await homeDir($)
  if (!home) return 'журнал недоступен (нет HOME)'
  const raw = await $.fs.read(journalPath(home)).catch(() => '')
  const now = await $.clock.now().catch(() => Date.now())
  const s = summarize(typeof raw === 'string' ? raw : '', now - 7 * DAY_MS)
  return [
    `Порог: ${THRESHOLD} символов stdout+stderr, только основная сессия, только успешные вызовы.`,
    `За 7 дней обрезано: ${s.n}; символов было ${s.before}, стало ${s.after}.`,
    `Последняя обрезка: ${s.last ?? 'не было'}; самая долгая: ${s.maxMs} мс.`,
    `Журнал: ${journalPath(home)}`,
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'bash-trim', description: 'How many Bash outputs bash-trim cut in the last 7 days' }).catch(() => undefined)
    return result
  })

  on('command.run', { command: 'bash-trim' }, async $ => {
    try {
      return { text: await commandText($) }
    } catch (err) {
      return { text: `не получилось: ${String(err)}` }
    }
  })

  // Main loop only: a subagent's context dies with it, and its report is what reaches the main one.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || r.deny !== undefined || r.isError) return r
    const started = Date.now()
    try {
      const cut = await trimmed($, e.tool_use_id ?? 'call', r.result as BashRecord)
      if (!cut) return r
      const ms = Date.now() - started
      await record($, { before: cut.before, after: cut.after, ms, command: e.command })
      return { result: cut.record as typeof r.result, ...(r.context ? { context: r.context } : {}) }
    } catch (err) {
      debug($, `bash-trim skipped: ${String(err)}`)
      return r
    }
  })
}
