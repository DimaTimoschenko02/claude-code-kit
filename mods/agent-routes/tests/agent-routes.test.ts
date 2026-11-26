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
type World = { files: Map<string, string>; calls: Call[]; reads: string[] }

// The engine rewrites `/home/x` to `C:\home\x` on Windows: files are kept by the path without drive and backslashes.
// A Linux engine resolves a simulated Windows drive relative to its test cwd.
const key = (p: string) => p.replace(/\\/g, '/').replace(/^(?:.*\/)?[A-Za-z]:(?=\/)/, '')

function world(
  on: On,
  files: Record<string, string> = BASE_FILES,
  opts: { rootFails?: boolean; writeFails?: boolean; env?: Record<string, string> } = {},
): World {
  const w: World = { files: new Map(Object.entries(files)), calls: [], reads: [] }
  mock.env(on, { HOME, ...opts.env })
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
    w.reads.push(key(e.path))
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

test('one live session follows priority changes for project agents and background launchers', async ($, on) => {
  const w = world(on, { ...BASE_FILES, [`${PROJ}/.claude/agent-routes.json`]: KARTS_ROUTES })
  const file = HOME + '/priority.json'
  w.files.set(HOME + '/.claude/state/agent-routes/authority.json', JSON.stringify({ file }))
  const set = (mode: string, until: string | null = null) => w.files.set(file, JSON.stringify({ mode, until }))
  const text = async () => (await $.prompt.compose(COMPOSE)).sections.map(s => s.text).join('\n')
  set('codex-first')
  expect(await text()).toContain('приоритет агентов: codex-first')
  expect((await agent($, { subagent_type: 'checker', description: 'review the diff' })).deny).toContain('Codex')
  expect((await agent($, { subagent_type: 'checker', description: 'escalate: Chrome is required' })).deny).toBeUndefined()
  set('claude-only')
  for (const cmd of ['nohup codex exec --help &', 'node bin/codex-run --cd .', 'bash .claude/bin/sol-run.sh task out']) {
    expect((await bash($, cmd)).deny).toContain('claude-only')
  }
  expect((await bash($, "echo 'bash .claude/bin/sol-run.sh'")).deny).toBeUndefined()
  expect((await agent($, { subagent_type: 'karts-coder', description: 'implement a spec' })).deny).toBeUndefined()
  set('claude-only', '2000-01-01T00:00:00Z')
  expect(await text()).toContain('приоритет агентов: default')
  expect((await bash($, 'node bin/codex-run --cd .')).deny).toBeUndefined()
  set('default')
  expect((await agent($, { subagent_type: 'karts-coder', description: 'implement a spec' })).deny).toContain('Sol')
})

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
  expect(out).toContain('- model-inherit (deny): 1')
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

test('a general-purpose call is denied once with the typed agents listed; the same call repeated with sonnet runs', async ($, on) => {
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

  expect(lines[lines.length - 1]).toContain('укажи `model: "sonnet"`')
  const again = await agent($, { subagent_type: 'general-purpose', model: 'sonnet', description: 'find the bug' })
  expect(again.deny).toBe(undefined)
  expect(w.calls[0]?.model).toBe('sonnet')
  expect(notes(again)).toEqual([])
})

test('no subagent_type and `claude` are catch-all; Explore, Plan and plugin agents are not', async ($, on) => {
  world(on)
  expect((await agent($, { description: 'a' })).deny).toBeDefined()
  expect((await agent($, { subagent_type: 'claude', description: 'b' })).deny).toBeDefined()
  expect((await agent($, { subagent_type: 'Explore', model: 'sonnet', description: 'c' })).deny).toBe(undefined)
  expect((await agent($, { subagent_type: 'Plan', model: 'sonnet', description: 'd' })).deny).toBe(undefined)
  expect((await agent($, { subagent_type: 'feature-dev:code-reviewer', description: 'e' })).deny).toBe(undefined)
  expect((await agent($, { subagent_type: 'statusline-setup', description: 'f' })).deny).toBe(undefined)
})

test('a parallel batch: each distinct description is denied once, a duplicate in the batch runs', async ($, on) => {
  const w = world(on)
  const results = await Promise.all([
    agent($, { subagent_type: 'general-purpose', model: 'sonnet', description: 'sweep A' }),
    agent($, { subagent_type: 'general-purpose', model: 'sonnet', description: 'sweep B' }),
    agent($, { subagent_type: 'general-purpose', model: 'sonnet', description: 'sweep A' }),
  ])
  expect(results.filter(r => r.deny !== undefined).length).toBe(2)
  expect(w.calls.length).toBe(1)
})

test('no typed agents anywhere: a general-purpose call is not denied', async ($, on) => {
  const w = world(on, {})
  expect((await agent($, { subagent_type: 'general-purpose', model: 'sonnet', description: 'x' })).deny).toBe(undefined)
  expect(w.calls[0]?.model).toBe('sonnet')
})

// ---- check 3: model (ported from agent-model-guard) ----

test('raising a typed agent above its frontmatter is denied with the fix, never rewritten', async ($, on) => {
  const w = world(on)
  const r = await agent($, { subagent_type: 'checker', model: 'opus', description: 'check spec' })
  expect(w.calls.length).toBe(0)
  expect(r.deny).toContain('frontmatter `sonnet`')
  expect(r.deny).toContain('без `model`')
  expect(r.deny).toContain('escalate: <почему>')
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
  expect((await agent($, { subagent_type: 'global-reader', model: 'sonnet', description: 'a' })).deny).toContain('global-reader')
  await agent($, { subagent_type: 'checker', model: 'sonnet', description: 'b' })
  expect(w.calls.map(c => c.model)).toEqual(['sonnet'])
})

test('built-ins: no model or opus/fable is denied with model: "sonnet" to retry; sonnet, haiku and escalate: run as sent', async ($, on) => {
  const w = world(on, {})
  for (const call of [
    { subagent_type: 'Explore', description: 'a' },
    { subagent_type: 'general-purpose', model: 'opus', description: 'b' },
    { subagent_type: 'claude', model: 'fable', description: 'c' },
  ] as const) expect((await agent($, call)).deny).toContain('model: "sonnet"')
  expect(w.calls.length).toBe(0)
  const kept = await agent($, { subagent_type: 'Explore', model: 'haiku', description: 'd' })
  await agent($, { subagent_type: 'Explore', model: 'sonnet', description: 'e' })
  await agent($, { subagent_type: 'general-purpose', model: 'opus', description: 'escalate: deep design' })
  expect(w.calls.map(c => c.model)).toEqual(['haiku', 'sonnet', 'opus'])
  expect(notes(kept)).toEqual([])
})

test('a call that would inherit the parent model is denied and journaled; with a model, or as a fork, it runs', async ($, on) => {
  const w = world(on)
  const plan = await agent($, { subagent_type: 'Plan', description: 'design the cache' })
  expect(plan.deny).toContain('унаследовал бы модель родительской сессии')
  expect(plan.deny).toContain('model: "sonnet"')
  const free = await agent($, { subagent_type: 'free', description: 'escalate: needs depth' })
  expect(free.deny).toContain('model: "opus"')
  expect(free.deny).toContain('допиши `model:`')
  expect(w.calls.length).toBe(0)
  await agent($, { subagent_type: 'Plan', model: 'sonnet', description: 'design the cache' })
  await agent($, { subagent_type: 'free', model: 'opus', description: 'escalate: needs depth' })
  await agent($, { subagent_type: 'fork', description: 'try the other fix' })
  expect(w.calls.map(c => [c.subagent_type, c.model])).toEqual([['Plan', 'sonnet'], ['free', 'opus'], ['fork', undefined]])
  expect(journal(w).map(l => [l.check, l.subagent_type])).toEqual([['model-inherit', 'Plan'], ['model-inherit', 'free']])
})

// ---- journal and fail-open ----

test('every deny is one journal line; passes are not', async ($, on) => {
  const w = world(on, { ...BASE_FILES, [`${PROJ}/.claude/agent-routes.json`]: KARTS_ROUTES })
  await agent($, { subagent_type: 'karts-coder', description: 'step 3 of the drift fix with a long long long long long long long long tail' })
  await agent($, { subagent_type: 'checker', model: 'opus', description: 'check' })
  await agent($, { subagent_type: 'karts-reviewer', description: 'review' })
  await bash($, 'codex exec "p"')
  const lines = journal(w)
  expect(lines.map(l => [l.check, l.action, l.subagent_type])).toEqual([
    ['sol-route', 'deny', 'karts-coder'],
    ['model-typed', 'deny', 'checker'],
    ['codex-sandbox', 'deny', null],
  ])
  expect(lines[0]).toMatchObject({ ts: '2026-11-07T10:00:00.000Z', session: 'sess-1', cwd: ROOT })
  expect(String(lines[0]?.description).length).toBeLessThanOrEqual(80)
})

test('a journal that cannot be written never blocks the decision', async ($, on) => {
  const w = world(on, BASE_FILES, { writeFails: true })
  const r = await agent($, { subagent_type: 'checker', model: 'opus', description: 'x' })
  expect(r.deny).toContain('frontmatter')
  expect(w.files.has(JOURNAL)).toBe(false)
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

// ---- Bash: codex model, the newest of its family in the Codex catalog ----

const CATALOG = JSON.stringify({
  models: [
    { slug: 'gpt-6.2-sol', visibility: 'list' },
    { slug: 'gpt-6.2-astra', visibility: 'list' },
    { slug: 'gpt-6.1-sol', visibility: 'list' },
    { slug: 'gpt-6-astra', visibility: 'list' },
    { slug: 'gpt-7-sol-preview', visibility: 'list' },
    { slug: 'gpt-reserve', visibility: 'hide' },
  ],
})
const CATALOG_PATH = `${HOME}/.codex/models_cache.json`
const withCatalog = { ...BASE_FILES, [CATALOG_PATH]: CATALOG }

test('a hand-typed codex exec without -m gets the newest sol from ~/.codex/models_cache.json', async ($, on) => {
  const w = world(on, withCatalog)
  const r = await bash($, 'cd /home/fake/game && codex exec -s danger-full-access "fix the drift"')
  expect(r.deny).toContain('```bash\ncd /home/fake/game && codex exec -m gpt-6.2-sol -s danger-full-access "fix the drift"\n```')
  expect(r.deny).toContain('новейшей модели своего семейства из каталога Codex')
  expect(r.deny).toContain('новейшая sol в каталоге Codex')
  expect(r.deny).not.toContain('полным доступом')
  expect(w.calls.length).toBe(0)
  expect(journal(w).map(l => l.check)).toEqual(['codex-model'])
})

test('an old pinned sol or astra goes to the newest of its own family; the current one runs', async ($, on) => {
  const w = world(on, withCatalog)
  expect((await bash($, 'codex exec -s danger-full-access -m gpt-6.1-sol "p"')).deny).toContain('codex exec -s danger-full-access -m gpt-6.2-sol "p"')
  const astra = await bash($, 'codex exec -s danger-full-access -m gpt-6-astra "p"')
  expect(astra.deny).toContain('codex exec -s danger-full-access -m gpt-6.2-astra "p"')
  expect(astra.deny).not.toContain('gpt-6.2-sol')
  expect((await bash($, 'codex exec -s danger-full-access -m gpt-6.2-sol "p"')).deny).toBe(undefined)
  expect((await bash($, 'codex exec -s danger-full-access -m gpt-6.2-astra "p"')).deny).toBe(undefined)
  expect((await bash($, 'codex exec -s danger-full-access -m gpt-7-sol-preview "p"')).deny).toBe(undefined)
  expect((await bash($, 'codex exec -s danger-full-access -m my-own-model "p"')).deny).toBe(undefined)
  expect((await bash($, 'codex exec -s danger-full-access -m gpt-6-luna "p"')).deny).toBe(undefined)
  expect((await bash($, 'codex exec -s danger-full-access -p fast "p"')).deny).toBe(undefined)
  expect((await bash($, 'codex exec -s danger-full-access -c model=gpt-6.1-sol "p"')).deny).toBe(undefined)
  expect(w.calls.length).toBe(7)
})

test('sandbox and model wrong at once: one deny, one fully fixed command, one journal line', async ($, on) => {
  const w = world(on, withCatalog)
  const r = await bash($, 'codex exec --full-auto -m gpt-6.1-sol "p" 2>&1 | tail -5')
  expect(r.deny).toContain('```bash\ncodex exec -s danger-full-access -m gpt-6.2-sol "p" 2>&1 | tail -5\n```')
  expect(r.deny).toContain('всегда с полным доступом `-s danger-full-access` и на новейшей модели')
  expect(r.deny).toContain('`--full-auto` (это workspace-write); `gpt-6.1-sol` устарела → `gpt-6.2-sol`')
  expect(journal(w).map(l => l.check)).toEqual(['codex-sandbox+codex-model'])
  const resume = await bash($, 'codex exec resume --last "go on"')
  expect(resume.deny).toContain('codex exec -s danger-full-access -m gpt-6.2-sol resume --last "go on"')
})

test('CODEX_HOME, a Windows path included, is where the catalog is read', async ($, on) => {
  const w = world(on, { ...BASE_FILES, '/codex-home/models_cache.json': CATALOG }, { env: { CODEX_HOME: 'D:\\codex-home\\' } })
  const r = await bash($, 'codex exec -s danger-full-access -m gpt-6-astra "p"')
  expect(r.deny).toContain('-m gpt-6.2-astra')
  expect(w.reads).toContain('/codex-home/models_cache.json')
  expect(w.reads).not.toContain(CATALOG_PATH)
})

test('no catalog or a broken one: only the sandbox is checked, never a block on the model', async ($, on) => {
  const w = world(on, { ...BASE_FILES, '/codex-home/models_cache.json': '{"models": [' }, { env: { CODEX_HOME: '/codex-home' } })
  expect((await bash($, 'codex exec -s danger-full-access -m gpt-6.1-sol "p"')).deny).toBe(undefined)
  expect((await bash($, 'codex exec -s danger-full-access "p"')).deny).toBe(undefined)
  const r = await bash($, 'codex exec -m gpt-6.1-sol "p"')
  expect(r.deny).toContain('codex exec -s danger-full-access -m gpt-6.1-sol "p"')
  expect(r.deny).not.toContain('новейшей модели')
  expect(w.calls.length).toBe(2)
  expect(journal(w).map(l => l.check)).toEqual(['codex-sandbox'])
})

test('the catalog is read only for a real codex exec launch, not for other Bash or text about codex', async ($, on) => {
  const w = world(on, withCatalog)
  for (const c of ['ls -la', 'grep -rn "codex exec -m gpt-6.1-sol" .claude', 'codex --version', "cat > run.sh <<'EOF'\ncodex exec \"p\"\nEOF"]) {
    expect((await bash($, c)).deny).toBe(undefined)
  }
  expect(w.reads).toEqual([])
  await bash($, 'codex exec -s danger-full-access -m gpt-6.2-sol "p"')
  expect(w.reads).toContain(CATALOG_PATH)
})
