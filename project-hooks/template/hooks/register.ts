// project-hooks, the Claude Code shell: runs this project's hook table (../core/index.mjs) inside the session.
// A pure row costs no process; a `script` row starts its process only when its matcher and `when` let it.
// The same table runs under Codex through ../node/runner.mjs, so a check is written once for both agents.
// Loaded by Claude Code from the project's .claude/skills/ (a trusted workspace only).
// Copied from claude-code-kit/project-hooks: change the kit, then `project-hooks install`, not this copy.
import type { EngineInterface, PreToolUseResult, Register } from 'claude-code'
import { HOOKS } from '../core/index.mjs'
import type { HookInput, HookIo, HookSpec } from './contract'
import { eventsOf, mergeModResult, normalPath, runEvent, toModResult } from './engine.mjs'

const TABLE = HOOKS as readonly HookSpec[]
const READ_LIMIT = 3.5 * 1024 * 1024 // $.fs.read refuses a file over 4 MiB

type Platform = HookIo['platform']
type Host = { root: string; platform: Platform; home: string }
type ModResult = Record<string, unknown> & { additionalContext?: string[]; block?: string }

let host: Host | undefined
let bashPath: string | undefined
/** Base fields of the last classic event that had them: classic.PreToolUse carries none. */
let base: { session_id?: string; transcript_path?: string; permission_mode?: string } = {}
/** tool_use_id → agentId: tool.call knows the loop, classic.PreToolUse (inside it) does not. */
const loops = new Map<string, string>()

async function hostOf($: EngineInterface): Promise<Host> {
  if (host) return host
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const home = (isWindows ? await $.env.get('USERPROFILE') : undefined) ?? (await $.env.get('HOME')) ?? ''
  const platform: Platform = isWindows ? 'win32' : home.startsWith('/Users/') ? 'darwin' : 'linux'
  // the plugin is <root>/.claude/skills/<name>
  const root = normalPath($.plugin.root, platform).replace(/\/+$/, '').split('/').slice(0, -3).join('/')
  host = { root, platform, home: normalPath(home, platform) }
  return host
}

async function findBash($: EngineInterface, platform: Platform): Promise<string> {
  if (bashPath) return bashPath
  if (platform !== 'win32') return (bashPath = 'bash')
  const given = await $.env.get('CLAUDE_CODE_GIT_BASH_PATH')
  const dirs = String((await $.env.get('PATH')) ?? '').split(';')
    .filter((d) => d && !/[\\/](System32|WindowsApps)([\\/]|$)/i.test(d))
    .map((d) => `${d.replace(/[\\/]+$/, '')}/bash.exe`)
  for (const candidate of [given, ...dirs, 'C:/Program Files/Git/bin/bash.exe']) {
    if (candidate && (await $.fs.exists(candidate).catch(() => false))) return (bashPath = normalPath(candidate, platform))
  }
  return (bashPath = 'bash')
}

/**
 * The variables a row may read. The engine takes only literal names (so what a module reads can be listed):
 * a new name goes here, in the kit, and into contract.ts.
 */
async function envOf($: EngineInterface, name: string): Promise<string | undefined> {
  switch (name) {
    case 'CCLL_INACTIVE': return $.env.get('CCLL_INACTIVE')
    case 'CCLL_ENABLED': return $.env.get('CCLL_ENABLED')
    case 'CCLL_THRESHOLD': return $.env.get('CCLL_THRESHOLD')
    case 'CCLL_STALE_LOCK_MINUTES': return $.env.get('CCLL_STALE_LOCK_MINUTES')
    case 'CLAUDE_PROJECT_DIR': return $.env.get('CLAUDE_PROJECT_DIR')
    case 'CLAUDE_CONFIG_DIR': return $.env.get('CLAUDE_CONFIG_DIR')
    case 'PATH': return $.env.get('PATH')
    case 'HOME': return $.env.get('HOME')
    default:
      $.ui.log(`project-hooks: env ${name} is not in the list a mod may read`, { to: 'debug' })
      return undefined
  }
}

async function ioOf($: EngineInterface): Promise<HookIo> {
  const { root, platform, home } = await hostOf($)
  const read = (p: string): Promise<string | null> => ($.fs.read(p) as Promise<string>).then((t) => t, () => null)
  const stat = (p: string) => $.fs.stat(p).then((s) => ({ kind: String(s.kind), size: s.size, mtimeMs: s.mtimeMs }), () => null)
  return {
    root, platform, home, codex: false,
    env: (name) => envOf($, name),
    read,
    write: (p, text) => $.fs.write(p, text),
    async append(p, text) {
      const st = await stat(p)
      if (!st) return $.fs.write(p, text)
      if (st.size < READ_LIMIT) return $.fs.write(p, `${(await read(p)) ?? ''}${text}`)
      const r = await $.process.run(['node', '-e', 'require("fs").appendFileSync(process.argv[1], process.argv[2])', p, text])
      if (r.exitCode !== 0) throw new Error(`append to ${p} failed: ${r.stderr.trim()}`)
    },
    exists: (p) => $.fs.exists(p).catch(() => false),
    stat,
    list: (dir) => $.fs.list(dir).then((es) => es.map((e) => ({ name: e.name, kind: String(e.kind) })), () => []),
    run: (argv, init) => $.process.run(argv, init).then((r) => ({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr })),
    bash: () => findBash($, platform),
    path: (p) => normalPath(p, platform),
    now: () => new Date(),
    log: (line) => $.ui.log(line, { to: 'debug' }),
  }
}

/** classic.PreToolUse's envelope ({ tool, tool_use_id, ...args }) as the stdin of a PreToolUse command hook. */
async function preToolInput($: EngineInterface, e: Record<string, unknown>, io: HookIo): Promise<HookInput> {
  const { tool, tool_use_id: toolUseId, ...args } = e
  const sessionId = base.session_id ?? (await $.session.id())
  const cwd = await $.session.cwd()
  const transcript = base.transcript_path
    ?? `${io.home}/.claude/projects/${(await $.session.root()).replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}.jsonl`
  const agentId = loops.get(String(toolUseId))
  const agentType = agentId ? (await $.agent.list().catch(() => [])).find((a) => a.id === agentId)?.type : undefined
  return {
    session_id: sessionId,
    transcript_path: transcript,
    cwd,
    ...(base.permission_mode ? { permission_mode: base.permission_mode } : {}),
    ...(agentId ? { agent_id: agentId, ...(agentType ? { agent_type: agentType } : {}) } : {}),
    hook_event_name: 'PreToolUse',
    tool_name: String(tool),
    tool_input: args,
    tool_use_id: String(toolUseId),
  }
}

/** Our PreToolUse answer laid over the one beneath: a deny beneath stands, an ask beats an allow. */
function mergePreToolUse(beneath: PreToolUseResult, ours: ModResult): PreToolUseResult {
  const additionalContext = [...(beneath.additionalContext ?? []), ...((ours.additionalContext as string[]) ?? [])]
  const extra = {
    ...(additionalContext.length ? { additionalContext } : {}),
    ...(beneath.updatedInput || ours.updatedInput ? { updatedInput: (ours.updatedInput ?? beneath.updatedInput) as Record<string, unknown> } : {}),
  }
  if (beneath.deny) return { deny: beneath.deny, ...extra }
  if (typeof ours.ask === 'string') return { ask: ours.ask, ...extra }
  if (beneath.ask) return { ask: beneath.ask, ...extra }
  if (ours.allow || beneath.allow) return { allow: true, ...extra }
  return extra
}

/** The events a table row may name: each is hooked with a literal name, as the engine reads a module. */
export const EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'SessionStart', 'SessionEnd',
  'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact', 'Notification'] as const

type Next = (e: never) => Promise<unknown>

/** One non-PreToolUse event: our rows and the hooks beneath run at once, the answers merge. */
async function classicEvent(event: string, $: EngineInterface, e: Record<string, unknown>, next: Next): Promise<never> {
    const io = await ioOf($)
    if (e.session_id) {
      base = { session_id: String(e.session_id), transcript_path: String(e.transcript_path ?? ''), permission_mode: e.permission_mode ? String(e.permission_mode) : undefined }
    }
    const input = { ...e, hook_event_name: event } as HookInput
    const [beneath, out] = await Promise.all([next(e as never), runEvent(TABLE, event, input, io)])
    return mergeModResult(beneath as ModResult, toModResult(event, out) as ModResult | null) as never
}

export const register: Register = (on) => {
  const events = new Set(eventsOf(TABLE))
  // A PreToolUse row needs the session's base fields, which only the other events carry: watch two of them.
  if (events.has('PreToolUse')) for (const e of ['SessionStart', 'UserPromptSubmit']) events.add(e)
  if (events.has('PreToolUse')) {
    on('tool.call', async ($, e, next) => {
      const id = String(e.tool_use_id ?? '')
      if (!e.agentId || !id) return next(e)
      loops.set(id, String(e.agentId))
      try {
        return await next(e)
      } finally {
        loops.delete(id)
      }
    })
    on('classic.PreToolUse', async ($, e, next) => {
      const io = await ioOf($)
      const input = await preToolInput($, e as unknown as Record<string, unknown>, io)
      const ours = toModResult('PreToolUse', await runEvent(TABLE, 'PreToolUse', input, io)) as ModResult | null
      if (typeof ours?.deny === 'string') {
        return { deny: ours.deny, ...(ours.additionalContext ? { additionalContext: ours.additionalContext } : {}) }
      }
      const beneath = await next(e)
      return ours ? mergePreToolUse(beneath, ours) : beneath
    })
  }
  if (events.has('PostToolUse')) on('classic.PostToolUse', ($, e, next) => classicEvent('PostToolUse', $, e as unknown as Record<string, unknown>, next as Next))
  if (events.has('PostToolUseFailure')) on('classic.PostToolUseFailure', ($, e, next) => classicEvent('PostToolUseFailure', $, e as unknown as Record<string, unknown>, next as Next))
  if (events.has('UserPromptSubmit')) on('classic.UserPromptSubmit', ($, e, next) => classicEvent('UserPromptSubmit', $, e as unknown as Record<string, unknown>, next as Next))
  if (events.has('SessionStart')) on('classic.SessionStart', ($, e, next) => classicEvent('SessionStart', $, e as unknown as Record<string, unknown>, next as Next))
  if (events.has('SessionEnd')) on('classic.SessionEnd', ($, e, next) => classicEvent('SessionEnd', $, e as unknown as Record<string, unknown>, next as Next))
  if (events.has('Stop')) on('classic.Stop', ($, e, next) => classicEvent('Stop', $, e as unknown as Record<string, unknown>, next as Next))
  if (events.has('SubagentStart')) on('classic.SubagentStart', ($, e, next) => classicEvent('SubagentStart', $, e as unknown as Record<string, unknown>, next as Next))
  if (events.has('SubagentStop')) on('classic.SubagentStop', ($, e, next) => classicEvent('SubagentStop', $, e as unknown as Record<string, unknown>, next as Next))
  if (events.has('PreCompact')) on('classic.PreCompact', ($, e, next) => classicEvent('PreCompact', $, e as unknown as Record<string, unknown>, next as Next))
  if (events.has('Notification')) on('classic.Notification', ($, e, next) => classicEvent('Notification', $, e as unknown as Record<string, unknown>, next as Next))
}
