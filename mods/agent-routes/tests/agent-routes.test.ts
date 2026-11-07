import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const HOME = '/home/fake'
const PROJ = '/home/fake/game'
const ROOT = '/home/fake/game/web'
const JOURNAL = `${HOME}/.claude/state/agent-routes/decisions.jsonl`

const md = (name: string, description: string, model?: string) =>
  `---\nname: ${name}\ndescription: ${description}\n${model ? `model: ${model}\n` : ''}---\nbody model: opus\n`

const KARTS_ROUTES = JSON.stringify({
  routes: [
    {
      work: 'Код по численной спеке',
      default: 'Sol: `bash .claude/bin/sol-coder.sh <спека> <имя> <out-dir> [часть]`',
      fallback: 'красный вердикт → `karts-coder` + `escalate: <почему>`',
      agent: 'karts-coder',
      sol: true,
      marker: '[sonnet-coder]',
    },
    {
      work: 'Скульптор рельефа',
      default: 'Sol: `bash .claude/bin/sol-coder.sh --role terrain-sculptor <бриф.md> <имя> <out-dir>`',
      agent: 'terrain-sculptor',
      sol: true,
      marker: '[claude-sculptor]',
    },
    {
      work: 'Физика',
      default: 'Sol: `bash .claude/bin/sol-physicist.sh <task.md> <out-dir>`',
      agent: 'karts-physicist',
      sol: true,
      marker: '[opus-compare]',
    },
    {
      work: 'Проверка спеки строителем',
      default: 'Sol: `bash .claude/bin/sol-run.sh <task.md> <out-dir> --role spec-builder-check`',
      agent: 'spec-builder-check',
      sol: true,
      marker: '[claude-check]',
    },
  ],
  notes: ['Ревью — не больше двух раундов на шаг'],
})

const BASE_FILES: Record<string, string> = {
  [`${PROJ}/.claude/agents/karts-coder.md`]: md('karts-coder', 'Writes code from a numeric spec. Never designs.', 'sonnet'),
  [`${PROJ}/.claude/agents/checker.md`]: md('checker', 'Checks a spec against the code.', 'sonnet'),
  [`${PROJ}/.claude/agents/coder.md`]: md('coder', 'Heavy coder.', 'opus'),
  [`${PROJ}/.claude/agents/free.md`]: md('free', 'Inherits the parent model.'),
  [`${PROJ}/.claude/agents/karts-reviewer.md`]: md('karts-reviewer', 'Reviews a diff.', 'opus'),
  [`${HOME}/.claude/agents/checker.md`]: md('checker', 'Shadowed user checker.', 'opus'),
  [`${HOME}/.claude/agents/global-reader.md`]: md('global-reader', 'Reads things cheaply.', 'haiku'),
}

type Call = Record<string, unknown>
type World = { files: Map<string, string>; calls: Call[] }

// The engine rewrites `/home/x` to `C:\home\x` on Windows: files are kept by the path without drive and backslashes.
const key = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

function world(on: On, files: Record<string, string> = BASE_FILES, opts: { rootFails?: boolean; writeFails?: boolean } = {}): World {
  const w: World = { files: new Map(Object.entries(files)), calls: [] }
  mock.env(on, { HOME })
  mock.clock(on, { now: Date.UTC(2026, 10, 7, 10, 0, 0) })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.root', () => (opts.rootFails ? { deny: 'boom' } : { value: ROOT }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.list', (_$, e) => {
    const dir = key(e.path)
    const names = [...w.files.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
    if (names.length === 0) return { deny: 'ENOENT' }
    return { value: names.map(p => ({ name: p.slice(dir.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_$, e) => {
    const text = w.files.get(key(e.path))
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', (_$, e) => {
    if (opts.writeFails) return { deny: 'EACCES' }
    w.files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base prompt', scope: 'shared' as const }] }))
  on('tool.call', (_$, e) => {
    w.calls.push({ ...e })
    return { result: 'ok', context: ['from below'] } as never
  })
  return w
}

const COMPOSE = { model: 'claude-sonnet-5', promptModel: 'claude-sonnet-5', surfaces: ['terminal' as const], tools: ['Agent', 'Bash'], outputStyle: null, traits: [] }
const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
const agent = ($: Engine, input: { subagent_type?: string; description: string; prompt?: string; model?: 'sonnet' | 'opus' | 'haiku' | 'fable' }) =>
  $.tool.call({ tool: 'Agent', prompt: 'do it', ...input })
const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const run = ($: Engine) =>
  $.command.run({ command: 'agent-routes', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
const journal = (w: World) =>
  (w.files.get(JOURNAL) ?? '')
    .split('\n')
    .filter(l => l !== '')
    .map(l => JSON.parse(l) as Record<string, unknown>)
const notes = (r: { context?: readonly string[] }) => (r.context ?? []).filter(c => c.startsWith('agent-routes ('))

// ---- the prompt section ----

test('the prompt gets the general rules only when no routes file is above the root', async ($, on) => {
  world(on)
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections[0]?.id).toBe('intro')
  const own = sections.find(s => s.id === 'agent-routes:rules')
  expect(own?.scope).toBe('session')
  expect(own?.text).toContain('Codex — всегда `-s danger-full-access`')
  expect(own?.text).not.toContain('| Работа |')
  expect(sections[sections.length - 1]?.id).toBe('agent-routes:rules')
})

test('a bare prompt gets no section', async ($, on) => {
  world(on)
  const { sections } = await $.prompt.compose({ ...COMPOSE, traits: ['bare'] })
  expect(sections.map(s => s.id)).toEqual(['intro'])
})

test('the first routes file walking up from the root adds the table; an invalid one gives general rules only', async ($, on) => {
  const w = world(on, { ...BASE_FILES, [`${PROJ}/.claude/agent-routes.json`]: KARTS_ROUTES, [`${HOME}/.claude/agent-routes.json`]: '{"notes":["home"]}' })
  const text = async () => (await $.prompt.compose(COMPOSE)).sections.find(s => s.id === 'agent-routes:rules')?.text ?? ''
  const withTable = await text()
  expect(withTable).toContain('| Код по численной спеке | Sol: `bash .claude/bin/sol-coder.sh')
  expect(withTable).toContain('- Ревью — не больше двух раундов на шаг')
  expect(withTable).not.toContain('home')
  w.files.set(`${PROJ}/.claude/agent-routes.json`, '{"routes":[{"work":"x","sol":true}]')
  const fallback = await text()
  expect(fallback).toContain('Модель Claude-агента')
  expect(fallback).not.toContain('| Работа |')
  expect(fallback).not.toContain('home')
})

test('/agent-routes prints the section as the model gets it and the decisions of the last 7 days', async ($, on) => {
  const w = world(on, { ...BASE_FILES, [`${PROJ}/.claude/agent-routes.json`]: KARTS_ROUTES })
  w.files.set(JOURNAL, `${JSON.stringify({ ts: '2026-10-01T00:00:00.000Z', check: 'sol-route', action: 'deny' })}\n`)
  await start($)
  await agent($, { subagent_type: 'karts-coder', description: 'step 3' })
  await agent($, { subagent_type: 'general-purpose', description: 'sweep logs' })
  await agent($, { subagent_type: 'general-purpose', description: 'sweep logs' })
  const out = (await run($)).text ?? ''
  const section = (await $.prompt.compose(COMPOSE)).sections.find(s => s.id === 'agent-routes:rules')!.text
  expect(out).toContain(section)
  expect(out).toContain(`${PROJ}/.claude/agent-routes.json`)
  expect(out).toContain('- sol-route (deny): 1')
  expect(out).toContain('- catch-all (deny): 1')
  expect(out).toContain('- model-builtin (set-sonnet): 1')
})

// ---- check 1: Sol routes (ported from the karts pre-agent sol-route cases) ----

test('sol-route: coder, sculptor, physicist and builder check go to Sol unless marker or escalate:', async ($, on) => {
  const w = world(on, { ...BASE_FILES, [`${PROJ}/.claude/agent-routes.json`]: KARTS_ROUTES })
  const cases: [string, string, RegExp][] = [
    ['karts-coder', '[sonnet-coder]', /sol-coder\.sh <спека>/],
    ['terrain-sculptor', '[claude-sculptor]', /sol-coder\.sh --role terrain-sculptor/],
    ['karts-physicist', '[opus-compare]', /sol-physicist\.sh <task\.md> <out-dir>/],
    ['spec-builder-check', '[claude-check]', /sol-run\.sh <task\.md> <out-dir> --role spec-builder-check/],
  ]
  for (const [type, marker, reason] of cases) {
    const denied = await agent($, { subagent_type: type, description: 'step' })
    expect(denied.deny).toMatch(reason)
    expect(denied.deny).toContain(marker)
    expect(denied.deny).toContain('escalate: <почему>')
    expect((await agent($, { subagent_type: type, description: 'step', prompt: `p ${marker}` })).deny).toBe(undefined)
    expect((await agent($, { subagent_type: type, description: 'escalate: Sol failed twice' })).deny).toBe(undefined)
  }
  expect((await agent($, { subagent_type: 'karts-reviewer', description: 'review' })).deny).toBe(undefined)
  expect((await agent($, { subagent_type: 'karts-coder', description: 'deescalate: no' })).deny).toBeDefined()
  const coderDeny = (await agent($, { subagent_type: 'karts-coder', description: 'again' })).deny ?? ''
  expect(coderDeny).toContain('красный вердикт → `karts-coder`')
  expect(w.calls.filter(c => c.subagent_type === 'karts-coder').length).toBe(2)
})

test('sol-route needs the routes file: without it a typed agent runs', async ($, on) => {
  world(on)
  expect((await agent($, { subagent_type: 'karts-coder', description: 'step' })).deny).toBe(undefined)
})

// ---- check 2: catch-all ----

test('a general-purpose call is denied once with the typed agents listed; the same call repeated runs on sonnet', async ($, on) => {
  const w = world(on)
  await start($)
  const first = await agent($, { subagent_type: 'general-purpose', description: 'find the bug' })
  const lines = (first.deny ?? '').split('\n')
  expect(lines[0]).toContain('`general-purpose` — последний вариант')
  expect(lines).toContain('- karts-coder — Writes code from a numeric spec.')
  expect(lines).toContain('- checker — Checks a spec against the code.')
  expect(lines).toContain('- global-reader — Reads things cheaply.')
  expect(lines.some(l => l.includes('Shadowed'))).toBe(false)
  expect(w.calls.length).toBe(0)

  const again = await agent($, { subagent_type: 'general-purpose', description: 'find the bug' })
  expect(again.deny).toBe(undefined)
  expect(w.calls[0]?.model).toBe('sonnet')
  expect(notes(again)[0]).toContain('запущен на sonnet')
})

test('no subagent_type and `claude` are catch-all; Explore, Plan and plugin agents are not', async ($, on) => {
  world(on)
  expect((await agent($, { description: 'a' })).deny).toBeDefined()
  expect((await agent($, { subagent_type: 'claude', description: 'b' })).deny).toBeDefined()
  expect((await agent($, { subagent_type: 'Explore', description: 'c' })).deny).toBe(undefined)
  expect((await agent($, { subagent_type: 'Plan', description: 'd' })).deny).toBe(undefined)
  expect((await agent($, { subagent_type: 'feature-dev:code-reviewer', description: 'e' })).deny).toBe(undefined)
  expect((await agent($, { subagent_type: 'statusline-setup', description: 'f' })).deny).toBe(undefined)
})

test('a parallel batch: each distinct description is denied once, a duplicate in the batch runs', async ($, on) => {
  const w = world(on)
  const results = await Promise.all([
    agent($, { subagent_type: 'general-purpose', description: 'sweep A' }),
    agent($, { subagent_type: 'general-purpose', description: 'sweep B' }),
    agent($, { subagent_type: 'general-purpose', description: 'sweep A' }),
  ])
  expect(results.filter(r => r.deny !== undefined).length).toBe(2)
  expect(w.calls.length).toBe(1)
})

test('no typed agents anywhere: a general-purpose call is not denied', async ($, on) => {
  const w = world(on, {})
  expect((await agent($, { subagent_type: 'general-purpose', description: 'x' })).deny).toBe(undefined)
  expect(w.calls[0]?.model).toBe('sonnet')
})

// ---- check 3: model (ported from agent-model-guard) ----

test('raising a typed agent above its frontmatter drops model, with a note naming its own model', async ($, on) => {
  const w = world(on)
  const r = await agent($, { subagent_type: 'checker', model: 'opus', description: 'check spec' })
  expect('model' in (w.calls[0] ?? {})).toBe(false)
  expect(w.calls[0]?.description).toBe('check spec')
  expect(r.context?.[0]).toBe('from below')
  expect(notes(r)[0]).toContain('frontmatter `sonnet`')
  expect(notes(r)[0]).toContain('escalate: <почему>')
})

test('escalate: keeps the raise; lowering and equal pass untouched', async ($, on) => {
  const w = world(on)
  await agent($, { subagent_type: 'checker', model: 'opus', description: 'escalate: no formula' })
  await agent($, { subagent_type: 'coder', model: 'sonnet', description: 'x' })
  await agent($, { subagent_type: 'coder', model: 'opus', description: 'y' })
  expect(w.calls.map(c => c.model)).toEqual(['opus', 'sonnet', 'opus'])
})

test('no model in the call, no frontmatter model, and plugin agents pass untouched', async ($, on) => {
  const w = world(on)
  const r1 = await agent($, { subagent_type: 'checker', description: 'a' })
  await agent($, { subagent_type: 'free', model: 'opus', description: 'b' })
  await agent($, { subagent_type: 'feature-dev:code-reviewer', model: 'opus', description: 'c' })
  expect(w.calls.map(c => c.model)).toEqual([undefined, 'opus', 'opus'])
  expect(notes(r1)).toEqual([])
})

test('user agents apply when the project has none; the project one shadows the user one', async ($, on) => {
  const w = world(on)
  await agent($, { subagent_type: 'global-reader', model: 'sonnet', description: 'a' })
  await agent($, { subagent_type: 'checker', model: 'sonnet', description: 'b' })
  expect(w.calls.map(c => c.model)).toEqual([undefined, 'sonnet'])
})

test('built-ins run on sonnet: no model or opus/fable becomes sonnet, haiku stays, escalate: keeps opus', async ($, on) => {
  const w = world(on, {})
  await agent($, { subagent_type: 'Explore', description: 'a' })
  await agent($, { subagent_type: 'general-purpose', model: 'opus', description: 'b' })
  await agent($, { subagent_type: 'claude', model: 'fable', description: 'c' })
  const kept = await agent($, { subagent_type: 'Explore', model: 'haiku', description: 'd' })
  await agent($, { subagent_type: 'general-purpose', model: 'opus', description: 'escalate: deep design' })
  expect(w.calls.map(c => c.model)).toEqual(['sonnet', 'sonnet', 'sonnet', 'haiku', 'opus'])
  expect(notes(kept)).toEqual([])
})

// ---- journal and fail-open ----

test('every deny and rewrite is one journal line; passes are not', async ($, on) => {
  const w = world(on, { ...BASE_FILES, [`${PROJ}/.claude/agent-routes.json`]: KARTS_ROUTES })
  await agent($, { subagent_type: 'karts-coder', description: 'step 3 of the drift fix with a long long long long long long long long tail' })
  await agent($, { subagent_type: 'checker', model: 'opus', description: 'check' })
  await agent($, { subagent_type: 'karts-reviewer', description: 'review' })
  await bash($, 'codex exec "p"')
  const lines = journal(w)
  expect(lines.map(l => [l.check, l.action, l.subagent_type])).toEqual([
    ['sol-route', 'deny', 'karts-coder'],
    ['model-typed', 'drop-model', 'checker'],
    ['codex-sandbox', 'deny', null],
  ])
  expect(lines[0]).toMatchObject({ ts: '2026-11-07T10:00:00.000Z', session: 'sess-1', cwd: ROOT })
  expect(String(lines[0]?.description).length).toBeLessThanOrEqual(80)
})

test('a journal that cannot be written never blocks the decision', async ($, on) => {
  const w = world(on, BASE_FILES, { writeFails: true })
  const r = await agent($, { subagent_type: 'checker', model: 'opus', description: 'x' })
  expect(r.deny).toBe(undefined)
  expect('model' in (w.calls[0] ?? {})).toBe(false)
})

test('a check that fails passes the call unchanged', async ($, on) => {
  const w = world(on, BASE_FILES, { rootFails: true })
  const r = await agent($, { subagent_type: 'general-purpose', model: 'opus', description: 'x' })
  expect(r.deny).toBe(undefined)
  expect(w.calls[0]?.model).toBe('opus')
  expect(notes(r)).toEqual([])
})

// ---- Bash: codex sandbox ----

test('a codex exec launch without full access is denied with the fixed command; full access and other Bash run', async ($, on) => {
  const w = world(on)
  const denied = await bash($, 'cd /home/fake/game && codex exec -s workspace-write "fix the drift"')
  expect(denied.deny).toContain('cd /home/fake/game && codex exec -s danger-full-access "fix the drift"')
  expect(denied.deny).toContain('`-s workspace-write`')
  expect((await bash($, 'codex exec -s danger-full-access "fix"')).deny).toBe(undefined)
  expect((await bash($, 'bash .claude/bin/sol-coder.sh docs/specs/07.md coder out/07')).deny).toBe(undefined)
  expect((await bash($, "cat > job.sh <<'EOF'\ncodex exec --full-auto \"p\"\nEOF")).deny).toBe(undefined)
  expect(w.calls.length).toBe(3)
})
