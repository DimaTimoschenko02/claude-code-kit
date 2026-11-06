import type { EngineInterface, Register } from 'claude-code'

import { ancestors, appendBounded, hintText, isRun, logLine, pickRunnerFile, runnerName } from './classify'

const MAX_FIRES_PER_PROMPT = 3
/** Prompt origins that start a new task: the owner's own (terminal, phone, `-p` host) and a scheduled prompt. */
const OWNER_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'scheduled-trigger'])

// Per process (one session): a reload starts the count over, which only delays one hint.
let runs = 0
let nextAt = 0
let fires = 0
const runners = new Map<string, string | undefined>()
let logPath: string | undefined

/** The first `.claude/agents/*-runner.md` walking up from `cwd`, cached per cwd (looked up only when a hint fires). */
async function findRunner($: EngineInterface, cwd: string): Promise<string | undefined> {
  if (runners.has(cwd)) return runners.get(cwd)
  let found: string | undefined
  for (const dir of ancestors(cwd)) {
    const agents = `${dir.replace(/\/$/, '')}/.claude/agents`
    const entries = await $.fs.list(agents).catch(() => [])
    const file = pickRunnerFile(entries.filter(en => en.kind === 'file').map(en => en.name))
    if (file === undefined) continue
    const content = await $.fs.read(`${agents}/${file}`).catch(() => undefined)
    found = runnerName(file, typeof content === 'string' ? content : undefined)
    if (found !== undefined) break
  }
  runners.set(cwd, found)
  return found
}

async function fireLog($: EngineInterface): Promise<string | undefined> {
  if (logPath !== undefined) return logPath
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined))
  if (home === undefined || home === '') return undefined
  logPath = `${home.replace(/\\/g, '/').replace(/\/$/, '')}/.claude/state/run-loop-hint/fires.log`
  return logPath
}

async function writeFire($: EngineInterface, cwd: string, count: number): Promise<void> {
  const path = await fireLog($)
  if (path === undefined) return
  const sessionId = await $.session.id().catch(() => '?')
  const old = await $.fs.read(path).catch(() => '')
  const now = await $.clock.now().catch(() => Date.now())
  const line = logLine(new Date(now).toISOString(), sessionId, cwd, count)
  await $.fs.write(path, appendBounded(typeof old === 'string' ? old : '', line))
}

/** The hint for this run, or undefined; every engine call inside is fail-open. */
async function hintFor($: EngineInterface, count: number): Promise<string | undefined> {
  const cwd = await $.session.cwd().catch(() => '')
  const runner = cwd === '' ? undefined : await findRunner($, cwd).catch(() => undefined)
  await writeFire($, cwd, count).catch(() => undefined)
  return hintText(count, runner)
}

export const register: Register = (on, options) => {
  const threshold =
    typeof options.threshold === 'number' && Number.isFinite(options.threshold) && options.threshold >= 1
      ? Math.floor(options.threshold)
      : 8
  nextAt = threshold

  const restart = (newPrompt: boolean) => {
    runs = 0
    nextAt = threshold
    if (newPrompt) fires = 0
  }

  on('session.start', async ($, e, next) => {
    await $.command
      .register({ name: 'run-loop-hint', description: 'Runs in a row on the main context, the threshold and the runner agent found' })
      .catch(() => undefined)
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    if (OWNER_ORIGINS.has(e.origin.kind) && e.isMeta !== true && e.command?.name !== 'run-loop-hint') restart(true)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, ($, e, next) => {
    if (e.agentId === undefined) restart(false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Workflow' }, ($, e, next) => {
    if (e.agentId === undefined) restart(false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const isARun = isRun(e.command)
    const ran = await next(e)
    if (!isARun || ran.deny !== undefined) return ran

    runs += 1
    if (runs < nextAt || fires >= MAX_FIRES_PER_PROMPT) return ran
    nextAt += threshold
    fires += 1
    const count = runs

    try {
      const hint = await hintFor($, count)
      return hint === undefined ? ran : { ...ran, context: [...(ran.context ?? []), hint] }
    } catch {
      return ran
    }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'run-loop-hint' }, async $ => {
    const cwd = await $.session.cwd().catch(() => '')
    const runner = cwd === '' ? undefined : await findRunner($, cwd).catch(() => undefined)
    const path = await fireLog($).catch(() => undefined)
    return {
      text: [
        `${runs} run(s) in a row on the main context · hint at ${nextAt} (every ${threshold}), ${fires}/${MAX_FIRES_PER_PROMPT} this prompt`,
        `runner agent: ${runner ?? 'none found above the cwd — the hint names general-purpose/sonnet'}`,
        `fires log: ${path ?? 'no HOME'}`,
      ].join('\n'),
    }
  })
}
