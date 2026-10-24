// A fake disk of Codex rollout files and wrapper files, with the engine nouns the mod calls answered over it.
import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { FsEntry, On, ProcessRunResult } from 'claude-code'

export const HOME = '/home/fake'
export const DAY = `${HOME}/.codex/sessions/2026/10/24`
export const WRAP = `${HOME}/wrap`
export const T0 = Date.UTC(2026, 9, 24, 11, 56, 36)
export const THREAD = '01a16dc5-1c6a-7772-a7a2-b541ef2c0fb1'

export const PANE = {
  plugin: 'codex-agents',
  component: 'Pane',
  requestId: 'codex',
  props: { title: 'Codex', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const iso = (ms: number) => new Date(ms).toISOString()

/** Rollout lines in Codex's own key order (what the mod's greps rely on). */
export const line = {
  meta: (thread: string, at: number, cwd: string, origin = 'codex_exec') =>
    JSON.stringify({ timestamp: iso(at), ordinal: 0, type: 'session_meta', payload: { session_id: thread, id: thread, timestamp: iso(at), cwd, originator: origin, base_instructions: { text: 'You are Codex' } } }),
  prompt: (at: number, text: string) =>
    JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text }] } } }),
  started: (at: number) => JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', started_at: Math.floor(at / 1000) } }),
  js: (at: number, input: string) => JSON.stringify({ timestamp: iso(at), type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', name: 'exec', input } }),
  command: (at: number, cmd: string) =>
    JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/zsh', '-lc', cmd], aggregated_output: 'SECRET OUTPUT LINE', exit_code: 0 } } }),
  message: (at: number, text: string) =>
    JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'm1', content: [{ type: 'Text', text }], phase: 'commentary' } } }),
  tokens: (at: number, total: number, used = 7, plan = 'prolite') =>
    JSON.stringify({
      timestamp: iso(at),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total } },
        rate_limits: { limit_id: 'codex', primary: { used_percent: used, window_minutes: 10080, resets_at: Math.floor(Date.UTC(2026, 9, 31, 12, 43) / 1000) }, secondary: null, plan_type: plan, rate_limit_reached_type: null },
      },
    }),
  complete: (at: number, last: string | null, error?: string) =>
    JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: last, ...(error === undefined ? {} : { error: { message: 'You hit your usage limit. Visit https://example.com', codex_error_info: error } }) } }),
}

export type World = { files: Map<string, string>; mtimes: Map<string, number>; opened: string[]; placed: boolean; clock: MockClock; runs: string[][] }

function grep(argv: readonly string[], files: Map<string, string>): string {
  const patterns: string[] = []
  const paths: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-e') patterns.push(argv[++i]!)
    else if (a.startsWith('-')) continue
    else if (patterns.length === 0) patterns.push(a)
    else paths.push(a)
  }
  const out: string[] = []
  for (const p of paths) {
    const text = files.get(p)
    if (text === undefined) continue
    for (const l of text.split('\n')) {
      const hits: { at: number; text: string }[] = []
      for (const pat of patterns) for (const m of l.matchAll(new RegExp(pat, 'g'))) hits.push({ at: m.index, text: m[0] })
      if (hits.length === 0) continue
      for (const h of hits.sort((a, b) => a.at - b.at)) out.push(`${p}:${h.text}`)
      break
    }
  }
  return out.join('\n')
}

function headTail(argv: readonly string[], files: Map<string, string>): string {
  const n = Number(argv[2])
  const paths = argv.slice(3)
  const cut = (t: string) => (argv[0] === 'tail' ? t.slice(-n) : t.slice(0, n))
  if (paths.length === 1) return cut(files.get(paths[0]!) ?? '')
  return paths.map(p => `==> ${p} <==\n${cut(files.get(p) ?? '')}`).join('\n')
}

/** The engine beneath the mod over a fake disk; `placed: false` plays a session with no surface (`claude -p`). */
export function world(on: On, now = T0 + 23 * 60_000): World {
  const w: World = { files: new Map(), mtimes: new Map(), opened: [], placed: true, clock: mock.clock(on, { now }), runs: [] }
  mock.env(on, { HOME })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('ui.panes', () => ({ value: w.opened.map(id => ({ id, title: 'Codex', isShown: true, isFocused: false, isPlaced: w.placed })) }))
  on('ui.open', (_$, e) => {
    if (!w.opened.includes(e.id)) w.opened.push(e.id)
    return { value: w.placed ? { isPlaced: true } : { isPlaced: false, reason: 'no-surface' } } as never
  })
  on('ui.close', (_$, e) => {
    w.opened = w.opened.filter(id => id !== e.id)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: [...w.files.keys()].some(p => p === e.path || p.startsWith(`${e.path}/`)) }))
  on('fs.read', (_$, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.list', (_$, e) => {
    const out = new Map<string, FsEntry>()
    for (const [p, text] of w.files) {
      if (!p.startsWith(`${e.path}/`)) continue
      const rest = p.slice(e.path.length + 1)
      const name = rest.split('/')[0]!
      const isFile = !rest.includes('/')
      out.set(name, { name, kind: isFile ? 'file' : 'dir', size: isFile ? text.length : 0, mtimeMs: isFile ? (w.mtimes.get(p) ?? 0) : 0, isLink: false })
    }
    return { value: [...out.values()] }
  })
  on('process.run', (_$, e) => {
    w.runs.push([...e.argv])
    const tool = e.argv[0]
    const stdout = tool === 'date' ? '+0200\n' : tool === 'grep' ? grep(e.argv, w.files) : tool === 'tail' || tool === 'head' ? headTail(e.argv, w.files) : ''
    const res: ProcessRunResult = { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    return { value: res }
  })
  return w
}

/** Writes a file on the fake disk, stamped with the clock's now (or `at`). */
export function put(w: World, path: string, lines: string[], at = w.clock.now()): void {
  w.files.set(path, `${lines.join('\n')}\n`)
  w.mtimes.set(path, at)
}

export function append(w: World, path: string, lines: string[], at = w.clock.now()): void {
  w.files.set(path, `${w.files.get(path) ?? ''}${lines.join('\n')}\n`)
  w.mtimes.set(path, at)
}

export const rollout = (thread: string) => `${DAY}/rollout-2026-10-24T13-56-36-${thread}.jsonl`

/** The owner's running task 02a, launched through the wrapper: it names the thread on its event log's first line. */
export function running02a(w: World): string {
  const path = rollout(THREAD)
  put(w, `${WRAP}/codex-02a.jsonl`, [`{"type":"thread.started","thread_id":"${THREAD}"}`, '{"type":"turn.started"}'])
  put(w, path, [
    line.meta(THREAD, T0, '/home/fake/proj/shop'),
    line.started(T0),
    line.prompt(T0, '# Задача 02a — платформа Nest\n\nДлинная спека, которую нельзя показывать целиком'),
    line.message(T0 + 5_000, 'Сначала проверю рабочую копию'),
    line.command(T0 + 60_000, 'git status --short'),
    line.tokens(T0 + 61_000, 5_900_000),
    line.js(T0 + 22 * 60_000, 'text(await tools.exec_command({cmd:"DATABASE_URL=postgres://u:hunter2@db/x pnpm vitest run apps/core","max_output_tokens":3000}));'),
  ])
  return path
}

export const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: '/home/fake/proj', surface: isInteractive ? 'terminal' : null, isInteractive })

export const cx = ($: Engine) => $.command.run({ command: 'cx', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
