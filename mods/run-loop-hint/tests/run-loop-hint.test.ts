import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const HOME = '/home/fake'
const CWD = '/home/fake/game/web'
const LOG = `${HOME}/.claude/state/run-loop-hint/fires.log`
const RUNNER_MD = '---\nname: karts-runner\nmodel: sonnet\n---\nRuns a measurement loop.'
const RUN = 'cd /home/fake/game && npx tsx tools/_probe.ts 2>&1 | tail -20'
const READ = 'sed -n 1,30p out/result.txt'

type World = { files: Map<string, string>; lists: string[]; bashRan: number }

// The engine rewrites `/home/x` to `C:\home\x` on Windows: files are kept by the path without drive and backslashes.
const key = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

function world(on: On, files: Record<string, string> = {}): World {
  const w: World = { files: new Map(Object.entries(files)), lists: [], bashRan: 0 }
  mock.env(on, { HOME })
  mock.clock(on, { now: Date.UTC(2026, 10, 6, 10, 0, 0) })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('fs.list', (_$, e) => {
    const dir = key(e.path)
    w.lists.push(dir)
    const names = [...w.files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
    if (names.length === 0) return { deny: 'ENOENT' }
    return { value: names.map(p => ({ name: p.slice(dir.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_$, e) => {
    const text = w.files.get(key(e.path))
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', (_$, e) => {
    w.files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') w.bashRan += 1
    return { result: 'ok', context: ['from below'] } as never
  })
  return w
}

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
const bash = ($: Engine, command: string, agentId?: string) => $.tool.call({ tool: 'Bash', command, ...(agentId === undefined ? {} : { agentId }) })
const prompt = ($: Engine, text = 'дальше') => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
const hintOf = (r: { context?: readonly string[] }) => (r.context ?? []).filter(c => c.startsWith('run-loop-hint ('))

/** Makes `n` runs and answers which of them (1-based) carried the hint. */
async function runs($: Engine, n: number, agentId?: string): Promise<number[]> {
  const hinted: number[] = []
  for (let i = 1; i <= n; i += 1) {
    const r = await bash($, RUN, agentId)
    if (hintOf(r).length > 0) hinted.push(i)
  }
  return hinted
}

test('the 8th run in a row carries one hint naming the runner; the rest of the result is kept', async ($, on) => {
  const w = world(on, { '/home/fake/game/.claude/agents/karts-runner.md': RUNNER_MD })
  await start($)
  await prompt($)
  for (let i = 1; i <= 7; i += 1) expect(hintOf(await bash($, RUN))).toEqual([])
  const eighth = await bash($, RUN)
  expect(eighth.context?.[0]).toBe('from below')
  expect(eighth.result).toBe('ok')
  const [hint] = hintOf(eighth)
  expect(hint).toContain('8 run commands in a row')
  expect(hint).toContain('`karts-runner` agent')
  expect(w.bashRan).toBe(8)
})

test('reads between runs do not count and do not reset the loop', async ($, on) => {
  world(on)
  await start($)
  await prompt($)
  const hinted: number[] = []
  for (let i = 1; i <= 8; i += 1) {
    await bash($, READ)
    await bash($, 'git diff --stat')
    if (hintOf(await bash($, RUN)).length > 0) hinted.push(i)
  }
  expect(hinted).toEqual([8])
})

test('re-arms every further threshold runs, at most 3 times per prompt', async ($, on) => {
  world(on)
  await start($)
  await prompt($)
  expect(await runs($, 40)).toEqual([8, 16, 24])
  await prompt($)
  expect(await runs($, 8)).toEqual([8])
})

test('the threshold comes from the userConfig option', { options: { threshold: 3 } }, async ($, on) => {
  world(on)
  await start($)
  await prompt($)
  expect(await runs($, 12)).toEqual([3, 6, 9])
})

test('an Agent or Workflow call on the main loop resets the count; the per-prompt cap stays', async ($, on) => {
  world(on)
  await start($)
  await prompt($)
  expect(await runs($, 7)).toEqual([])
  await $.tool.call({ tool: 'Agent', description: 'probe sweep', prompt: 'run it', subagent_type: 'karts-runner' })
  expect(await runs($, 7)).toEqual([])
  await $.tool.call({ tool: 'Workflow', script: 'export default 1' } as never)
  expect(await runs($, 8)).toEqual([8])
})

test('a new owner prompt resets the count; a notification-started turn does not', async ($, on) => {
  world(on)
  await start($)
  await prompt($)
  expect(await runs($, 7)).toEqual([])
  await prompt($, 'ок, ещё раз')
  expect(await runs($, 7)).toEqual([])
  await $.prompt.submit({ text: '<task-notification>done</task-notification>', wait: false, origin: { kind: 'task-notification' } })
  expect(await runs($, 1)).toEqual([1])
})

test("a subagent's runs are not counted, hinted or reset anything; its Agent call does not reset the main count", async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($)
  expect(await runs($, 20, 'agent-7')).toEqual([])
  expect(w.bashRan).toBe(20)
  expect(await runs($, 5)).toEqual([])
  await $.tool.call({ tool: 'Agent', description: 'nested', prompt: 'x', agentId: 'agent-7' } as never)
  expect(await runs($, 3)).toEqual([3])
})

test('no runner agent above the cwd: the hint omits that clause and looks no further after the first fire', async ($, on) => {
  const w = world(on, { '/home/fake/game/.claude/agents/karts-coder.md': '---\nname: karts-coder\n---' })
  await start($)
  await prompt($)
  const hinted: string[] = []
  for (let i = 0; i < 16; i += 1) hinted.push(...hintOf(await bash($, RUN)))
  expect(hinted.length).toBe(2)
  expect(hinted[0]).not.toContain('runner')
  expect(hinted[0]).toContain('`general-purpose` with model: sonnet')
  const walked = w.lists.length
  expect(walked).toBeGreaterThan(3)
  for (let i = 0; i < 8; i += 1) await bash($, RUN)
  expect(w.lists.length).toBe(walked)
})

test('each fire is one line in the fires log: time, session, cwd, count', async ($, on) => {
  const w = world(on, { [LOG]: 'older\tline\there\t8\n' })
  await start($)
  await prompt($)
  await runs($, 16)
  expect(w.files.get(LOG)).toBe(
    'older\tline\there\t8\n' + `2026-11-06T10:00:00.000Z\tsess-1\t${CWD}\t8\n` + `2026-11-06T10:00:00.000Z\tsess-1\t${CWD}\t16\n`,
  )
})

test('fails open: a broken disk and a broken session still return the Bash result, hint included', async ($, on) => {
  const w: World = { files: new Map(), lists: [], bashRan: 0 }
  mock.env(on, {})
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ deny: 'no' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('session.cwd', () => ({ deny: 'gone' }))
  on('session.id', () => ({ deny: 'gone' }))
  on('fs.list', () => ({ deny: 'EIO' }))
  on('fs.read', () => ({ deny: 'EIO' }))
  on('fs.write', () => ({ deny: 'EIO' }))
  on('tool.call', () => {
    w.bashRan += 1
    return { result: 'ok' } as never
  })
  await start($)
  await prompt($)
  const all = []
  for (let i = 0; i < 8; i += 1) all.push(await bash($, RUN))
  expect(all.every(r => r.result === 'ok')).toBe(true)
  expect(hintOf(all[7] ?? {}).length).toBe(1)
  expect(w.bashRan).toBe(8)
})

test('a failing run (non-zero exit, an errored result) still counts and gets the hint beside its error', async ($, on) => {
  mock.env(on, { HOME })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.list', () => ({ deny: 'ENOENT' }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.call', () => ({ isError: true, result: 'Exit code 1', text: 'Exit code 1, 2 failed' }) as never)
  await start($)
  await prompt($)
  const all = []
  for (let i = 0; i < 8; i += 1) all.push(await bash($, 'npm run gate'))
  const last = all[7] as { isError?: boolean; text?: string; context?: readonly string[] }
  expect(last.isError).toBe(true)
  expect(last.text).toBe('Exit code 1, 2 failed')
  expect(hintOf(last).length).toBe(1)
})

test('/run-loop-hint shows the count, the threshold, the runner and the log', async ($, on) => {
  world(on, { '/home/fake/game/.claude/agents/karts-runner.md': RUNNER_MD })
  await start($)
  await prompt($)
  await runs($, 3)
  const r = await $.command.run({ command: 'run-loop-hint', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
  const text = (r as { text?: string }).text ?? ''
  expect(text).toContain('3 run(s) in a row')
  expect(text).toContain('hint at 8')
  expect(text).toContain('runner agent: karts-runner')
  expect(text).toContain('fires.log')
})
