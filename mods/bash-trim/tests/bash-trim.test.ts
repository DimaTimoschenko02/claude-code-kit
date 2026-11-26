import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { cutStream, HEAD, TAIL, THRESHOLD } from '../hooks/trim'

const HOME = '/home/fake'
const TRANSCRIPT = '/home/fake/.claude/projects/-game/sess-1.jsonl'
const RESULTS = '/home/fake/.claude/projects/-game/sess-1/tool-results'
const JOURNAL = `${HOME}/.claude/state/bash-trim/trims.jsonl`

type World = { files: Map<string, string> }
type Core = { stdout: string; stderr?: string; isError?: boolean; extra?: Record<string, unknown> }

const key = (p: string) => p.replace(/\\/g, '/').replace(/^(?:.*\/)?[A-Za-z]:(?=\/)/, '')

function world(on: On, core: Core, opts: { writeFails?: boolean; noTranscript?: boolean } = {}): World {
  const w: World = { files: new Map() }
  mock.env(on, { HOME })
  mock.clock(on, { now: Date.UTC(2026, 10, 26, 10, 0, 0) })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.info', () => ({ value: { transcriptPath: opts.noTranscript ? '' : TRANSCRIPT } as never }))
  on('fs.read', (_$, e) => {
    const text = w.files.get(key(e.path))
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', (_$, e) => {
    if (opts.writeFails) return { deny: 'EACCES' }
    w.files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('tool.call', () => {
    if (core.isError) return { isError: true, result: core.stdout, text: core.stdout } as never
    return { result: { stdout: core.stdout, stderr: core.stderr ?? '', interrupted: false, ...core.extra }, text: core.stdout } as never
  })
  return w
}

const bash = ($: Engine, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'Bash', command: 'sed -n 1,400p big.ts', tool_use_id: 'toolu_01', ...extra } as never) as Promise<{
    result?: { stdout: string; stderr: string; interrupted: boolean; gitOperation?: unknown }
    deny?: string
  }>

const lines = (n: number, text = (i: number) => `line ${i} of a long file with some code in it`) =>
  Array.from({ length: n }, (_, i) => text(i)).join('\n') + '\n'

test('an output over the threshold is cut to head and tail, the full text saved beside the transcript', async ($, on) => {
  const big = lines(400)
  const w = world(on, { stdout: big })
  const r = await bash($)
  const out = r.result!.stdout
  expect(big.length).toBeGreaterThan(THRESHOLD)
  expect(out.length).toBeLessThan(HEAD + TAIL + 400)
  expect(out.startsWith('line 0 of')).toBe(true)
  expect(out.endsWith('line 399 of a long file with some code in it\n')).toBe(true)
  expect(out).toContain(`${RESULTS}/bash-trim-toolu_01.txt`)
  expect(out).toMatch(/\[bash-trim: \d+ lines, \d+ of \d+ chars left out/)
  expect(w.files.get(`${RESULTS}/bash-trim-toolu_01.txt`)).toBe(big)
  expect(r.result!.interrupted).toBe(false)
  const j = JSON.parse(w.files.get(JOURNAL)!.trim()) as Record<string, unknown>
  expect(j).toMatchObject({ session: 'sess-1', before: big.length, after: out.length, command: 'sed -n 1,400p big.ts' })
})

test('error-looking lines of the cut middle are carried into the reply, bounded', async ($, on) => {
  const text = lines(400, i => (i === 150 ? 'src/a.ts(12,3): error TS2322: bad type' : i % 7 === 0 && i > 100 && i < 300 ? `FAIL test ${i}` : `ok ${i} ${'x'.repeat(30)}`))
  world(on, { stdout: text })
  const out = (await bash($)).result!.stdout
  expect(out).toContain('src/a.ts(12,3): error TS2322: bad type')
  expect(out).toContain('FAIL test 105')
  expect(out).toMatch(/\[error-looking lines of the cut part: \d+ of \d+\]/)
})

test('stderr stays whole next to a cut stdout; both are in the file', async ($, on) => {
  const w = world(on, { stdout: lines(400), stderr: 'warning: deprecated flag\n' })
  const r = await bash($)
  expect(r.result!.stderr).toBe('warning: deprecated flag\n')
  expect(w.files.get(`${RESULTS}/bash-trim-toolu_01.txt`)).toContain('--- stderr ---\nwarning: deprecated flag\n')
})

test('short outputs, failed calls, subagents, images and background runs are left as core made them', async ($, on) => {
  const big = lines(400)
  const core: Core = { stdout: 'short\n' }
  const w = world(on, core)
  expect((await bash($)).result!.stdout).toBe('short\n')
  core.stdout = big
  expect((await bash($, { agentId: 'agent-1' })).result!.stdout).toBe(big)
  core.extra = { isImage: true }
  expect((await bash($)).result!.stdout).toBe(big)
  core.extra = { backgroundTaskId: 'b1' }
  expect((await bash($)).result!.stdout).toBe(big)
  core.extra = undefined
  core.isError = true
  const failed = (await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 't2' } as never)) as { isError?: boolean; text?: string }
  expect(failed.isError).toBe(true)
  expect(failed.text).toBe(big)
  expect(w.files.size).toBe(0)
})

test('the engine-persisted path is reused and no output file is written', async ($, on) => {
  const big = lines(400)
  const core: Core = { stdout: big, extra: { persistedOutputPath: '/tmp/persisted.txt' } }
  const w = world(on, core)
  const r = await bash($)
  expect(r.result!.stdout).toContain('/tmp/persisted.txt')
  expect([...w.files.keys()].filter(k => k !== JOURNAL)).toEqual([])
})

test('a write that fails keeps the whole output', async ($, on) => {
  const big = lines(400)
  world(on, { stdout: big }, { writeFails: true })
  expect((await bash($)).result!.stdout).toBe(big)
})

test('no transcript: the full output goes under the state dir', async ($, on) => {
  const w = world(on, { stdout: lines(400) }, { noTranscript: true })
  await bash($)
  expect(w.files.has(`${HOME}/.claude/state/bash-trim/outputs/bash-trim-toolu_01.txt`)).toBe(true)
})

test('/bash-trim reports the last 7 days from the journal', async ($, on) => {
  const w = world(on, { stdout: lines(400) })
  await $.session.start({ cwd: '/home/fake/game', surface: 'terminal', isInteractive: true })
  await bash($)
  w.files.set(JOURNAL, `${JSON.stringify({ ts: '2026-10-01T00:00:00.000Z', before: 9, after: 1, ms: 1 })}\n${w.files.get(JOURNAL)}`)
  const out = (await $.command.run({ command: 'bash-trim', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })).text ?? ''
  expect(out).toContain('За 7 дней обрезано: 1;')
  expect(out).toContain('2026-11-26T10:00:00.000Z')
})

test('one huge line is cut by characters, not lost', () => {
  const one = 'x'.repeat(20000)
  const c = cutStream(one, '/f')!
  expect(c.text.startsWith('x'.repeat(HEAD))).toBe(true)
  expect(c.text.endsWith('x'.repeat(TAIL))).toBe(true)
  expect(c.omittedChars).toBe(20000 - HEAD - TAIL)
})
