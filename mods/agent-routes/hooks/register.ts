import type { EngineInterface as Engine, Register } from 'claude-code'

import { codexReason, codexSandboxFix, launcherReason, launchesCodexExec } from './codex'
import {
  ancestors,
  appendBounded,
  countByCheck,
  decideAgent,
  hasEscalate,
  journalLine,
  mergeAgents,
  parseAgent,
  parseRoutes,
  promptSection,
  under,
  type AgentDef,
  type Decision,
  type Routes,
} from './routes'

const DAY_MS = 24 * 60 * 60 * 1000

// Per process (one session). A reload starts these over: at most one catch-all call is denied a second time.
const seenCatchAll = new Set<string>()
const loggedErrors = new Set<string>()
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

type RoutesFound = { path?: string; routes: Routes | null; error?: string }

/** The first `.claude/agent-routes.json` walking up from the session root; an invalid one gives general rules only. */
async function loadRoutes($: Engine, root: string): Promise<RoutesFound> {
  for (const dir of ancestors(root)) {
    const path = under(dir, 'agent-routes.json')
    const text = await $.fs.read(path).catch(() => undefined)
    if (typeof text !== 'string') continue
    const parsed = parseRoutes(text)
    if ('error' in parsed) {
      const key = `${path}\u0000${parsed.error}`
      if (!loggedErrors.has(key)) {
        loggedErrors.add(key)
        debug($, `${path} is invalid, general rules only: ${parsed.error}`)
      }
      return { path, routes: null, error: parsed.error }
    }
    return { path, routes: parsed }
  }
  return { routes: null }
}

/** Every agent file in one folder, parsed; a folder or a file that cannot be read is skipped. */
async function readAgentDir($: Engine, dir: string): Promise<AgentDef[]> {
  const entries = await $.fs.list(dir).catch(() => [])
  const names = entries
    .filter(f => f.name.endsWith('.md') && (f.kind === 'file' || f.isLink))
    .map(f => f.name)
    .sort()
  const out: AgentDef[] = []
  for (const name of names) {
    const text = await $.fs.read(`${dir}/${name}`).catch(() => '')
    const def = typeof text === 'string' ? parseAgent(text, name.replace(/\.md$/, '')) : null
    if (def) out.push(def)
  }
  return out
}

/** Typed agents: every `.claude/agents` at or above the root, nearest first, then the user's own. */
async function loadAgents($: Engine, root: string, home: string | undefined): Promise<AgentDef[]> {
  const dirs = ancestors(root).map(d => under(d, 'agents'))
  if (home) dirs.push(under(home, 'agents'))
  const unique = [...new Set(dirs.map(d => d.toLowerCase()))].map(k => dirs.find(d => d.toLowerCase() === k)!)
  const lists = await Promise.all(unique.map(d => readAgentDir($, d)))
  return mergeAgents(...lists)
}

/** The section as the model gets it, with where its table came from. */
async function currentSection($: Engine): Promise<{ text: string; found: RoutesFound; root: string }> {
  const root = await $.session.root()
  const found = await loadRoutes($, root)
  return { text: promptSection(found.routes), found, root }
}

const journalPath = (home: string) => `${home}/.claude/state/agent-routes/decisions.jsonl`

/** One decision into the journal; writes of one process go one after another. Never throws. */
async function record($: Engine, check: string, subagentType: string | null, action: string, description: string): Promise<void> {
  try {
    const home = await homeDir($)
    if (!home) return
    const [session, cwd, now] = await Promise.all([
      $.session.id().catch(() => '?'),
      $.session.cwd().catch(() => ''),
      $.clock.now().catch(() => Date.now()),
    ])
    const line = journalLine({
      ts: new Date(now).toISOString(),
      session,
      cwd,
      check,
      subagent_type: subagentType,
      action,
      description,
    })
    const path = journalPath(home)
    const write = journalQueue.then(async () => {
      const old = await $.fs.read(path).catch(() => '')
      await $.fs.write(path, appendBounded(typeof old === 'string' ? old : '', line))
    })
    journalQueue = write.catch(() => undefined)
    await write
  } catch (err) {
    debug($, `journal write failed: ${String(err)}`)
  }
}

/** The checks on one Agent call; any error passes the call unchanged. */
async function agentDecision($: Engine, call: { subagent_type?: string; description?: string; prompt?: string; model?: string }): Promise<Decision> {
  try {
    if (hasEscalate(call.description)) return { kind: 'pass' }
    const root = await $.session.root()
    const home = await homeDir($)
    const [found, agents, session] = await Promise.all([
      loadRoutes($, root),
      loadAgents($, root, home),
      $.session.id().catch(() => '?'),
    ])
    // Synchronous from here: parallel calls of one batch cannot both claim the same catch-all key.
    return decideAgent(call, found.routes, agents, key => {
      const k = `${session}\u0000${key}`
      if (seenCatchAll.has(k)) return false
      seenCatchAll.add(k)
      return true
    })
  } catch (err) {
    debug($, `Agent check skipped: ${String(err)}`)
    return { kind: 'pass' }
  }
}

async function commandText($: Engine): Promise<string> {
  const { text, found, root } = await currentSection($)
  const source = found.path
    ? found.error
      ? `${found.path} — невалиден (${found.error}), в промпте только общие правила`
      : found.path
    : `нет: .claude/agent-routes.json не найден от ${root} вверх, в промпте только общие правила`
  const home = await homeDir($)
  let counts = 'журнал недоступен (нет HOME)'
  if (home) {
    const raw = await $.fs.read(journalPath(home)).catch(() => '')
    const now = await $.clock.now().catch(() => Date.now())
    const byCheck = countByCheck(typeof raw === 'string' ? raw : '', now - 7 * DAY_MS)
    const lines = [...byCheck.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}: ${n}`)
    counts = `${journalPath(home)}\n${lines.length > 0 ? lines.join('\n') : '- ни одного'}`
  }
  return [
    'Секция системного промпта, как её получает модель:',
    '',
    text,
    '',
    `Файл маршрутов: ${source}`,
    '',
    `Решения за 7 дней — ${counts}`,
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command
      .register({ name: 'agent-routes', description: 'Show the agent routing section the model gets and how often the checks fired' })
      .catch(() => undefined)
    return result
  })

  on('command.run', { command: 'agent-routes' }, async $ => {
    try {
      return { text: await commandText($) }
    } catch (err) {
      return { text: `не получилось: ${String(err)}` }
    }
  })

  // The routes are in the prompt from the first turn, resent every request: the hooks below only check.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (e.traits.includes('bare')) return result
    try {
      const { text } = await currentSection($)
      return { sections: [...result.sections, { id: 'agent-routes:rules', text, scope: 'session' as const }] }
    } catch (err) {
      debug($, `prompt section skipped: ${String(err)}`)
      return result
    }
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const d = await agentDecision($, e)
    if (d.kind === 'pass') return next(e)
    await record($, d.check, e.subagent_type ?? null, d.kind, e.description ?? '')
    // Deny with the fix, never rewrite the call: auto mode reviews the call as sent, so a changed input gets no
    // verdict and fails anyway, and the rewrite loses fields the event does not carry (run_in_background).
    return { deny: d.reason }
  }).catch(($, e, next) => next(e))

  // Hot path: every Bash call. `codexSandboxFix` returns at once when the text has no `codex`.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    let fix: ReturnType<typeof codexSandboxFix> = null
    try {
      fix = codexSandboxFix(e.command)
    } catch (err) {
      debug($, `codex check skipped: ${String(err)}`)
    }
    // A project that names its own Codex launcher gets it instead of any raw `codex exec`, sandbox right or not.
    let launcher: string | undefined
    try {
      if (launchesCodexExec(e.command)) launcher = (await loadRoutes($, await $.session.root())).routes?.codexLauncher
    } catch (err) {
      debug($, `codex launcher check skipped: ${String(err)}`)
    }
    if (launcher) {
      await record($, 'codex-launcher', null, 'deny', e.command)
      return { deny: launcherReason(launcher) }
    }
    if (!fix) return next(e)
    await record($, 'codex-sandbox', null, 'deny', e.command)
    return { deny: codexReason(fix.problems, fix.fixed) }
  }).catch(($, e, next) => next(e))
}
