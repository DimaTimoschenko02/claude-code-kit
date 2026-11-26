import { expect, test } from 'claude-code/testing'

import { codexFix, codexReason, launcherReason, launchesCodexExec, newestOf, parseCatalog } from '../hooks/codex'
import { countByCheck, decideAgent, parseAgent, parseRoutes, promptSection, shortLine, type AgentDef, type Routes } from '../hooks/routes'

const KARTS = JSON.stringify({
  routes: [
    {
      work: 'Код по численной спеке',
      default: 'Sol: `bash .claude/bin/sol-coder.sh <спека> <имя> <out-dir> [часть]`',
      fallback: 'красный вердикт → `karts-coder` + `escalate: <почему>`',
      agent: 'karts-coder',
      sol: true,
      marker: '[sonnet-coder]',
    },
    { work: 'Ревью диффа', default: '`karts-reviewer`' },
  ],
  notes: ['Ревью — не больше двух раундов на шаг'],
})

const routesOf = (text: string): Routes => {
  const r = parseRoutes(text)
  if ('error' in r) throw new Error(r.error)
  return r
}
const always = () => true

// ---- routes file and prompt section ----

test('the section always carries the three general rules; with a file, the table and notes follow', () => {
  const bare = promptSection(null)
  expect(bare).toContain('Модель Claude-агента — из его frontmatter')
  expect(bare).toContain("`general-purpose`, `Explore`, `Plan`, `claude`")
  expect(bare).toContain('Codex — всегда `-s danger-full-access`')
  expect(bare).not.toContain('| Работа |')

  const full = promptSection(routesOf(KARTS))
  expect(full.startsWith(bare)).toBe(true)
  expect(full).toContain('| Работа | По умолчанию | Не вышло |')
  expect(full).toContain('| Код по численной спеке | Sol: `bash .claude/bin/sol-coder.sh <спека> <имя> <out-dir> [часть]` | красный вердикт → `karts-coder` + `escalate: <почему>` |')
  expect(full).toContain('| Ревью диффа | `karts-reviewer` | — |')
  expect(full).toContain('\n- Ревью — не больше двух раундов на шаг')
})

test('a cell is one line, its pipes escaped, and bounded', () => {
  const s = promptSection(routesOf(JSON.stringify({ routes: [{ work: 'a | b\nc', default: 'x'.repeat(500) }] })))
  const row = s.split('\n').find(l => l.startsWith('| a'))!
  expect(row).toContain('| a \\| b c |')
  expect(row.length).toBeLessThan(400)
})

test('an invalid file is refused whole with the reason', () => {
  const bad = [
    'nope',
    '[]',
    '{"routes":{}}',
    '{"routes":[{"work":"x"}]}',
    '{"routes":[{"work":"x","default":"y","sol":true}]}',
    '{"routes":[{"work":"x","default":"y","sol":"yes","agent":"a"}]}',
    '{"routes":[{"work":"x","default":"y","marker":3}]}',
    '{"routes":[],"notes":"one"}',
  ]
  for (const text of bad) expect('error' in parseRoutes(text)).toBe(true)
  expect(parseRoutes('\uFEFF{"notes":["a"]}')).toEqual({ routes: [], notes: ['a'] })
})

// ---- agent files ----

test('frontmatter only, not body; quoted, block and CRLF scalars', () => {
  expect(parseAgent('---\nname: a\n---\nmodel: opus\n', 'a')?.model).toBe(null)
  expect(parseAgent('---\r\nmodel: "sonnet"\r\n---\r\n', 'x')).toEqual({ name: 'x', description: '', model: 'sonnet' })
  expect(parseAgent('---\nname: r\ndescription: >\n  Reviews the diff.\n  Second.\nmodel: claude-opus-5-5\n---', 'f')).toEqual({
    name: 'r',
    description: 'Reviews the diff. Second.',
    model: 'opus',
  })
  expect(parseAgent('no frontmatter', 'x')).toBe(null)
})

test('an agent line is its first sentence, cut at a word to 120 chars', () => {
  expect(shortLine('Checks a spec. Then more.')).toBe('Checks a spec.')
  const long = shortLine(`${'word '.repeat(60)}end.`)
  expect(long.length).toBeLessThanOrEqual(120)
  expect(long.endsWith('…')).toBe(true)
})

// ---- the Agent checks as pure decisions ----

const AGENTS: AgentDef[] = [
  { name: 'karts-coder', description: 'Writes code from a numeric spec.', model: 'sonnet' },
  { name: 'checker', description: 'Checks a spec.', model: 'sonnet' },
  { name: 'free', description: 'Inherits.', model: null },
]

test('escalate: is a word in the description, any case; it passes every check', () => {
  const r = routesOf(KARTS)
  expect(decideAgent({ subagent_type: 'karts-coder', description: 'ESCALATE: Sol red twice', model: 'opus' }, r, AGENTS, always).kind).toBe('pass')
  expect(decideAgent({ subagent_type: 'general-purpose', description: 'escalate: needs Opus', model: 'opus' }, r, AGENTS, always).kind).toBe('pass')
  expect(decideAgent({ subagent_type: 'karts-coder', description: 'deescalate: no' }, r, AGENTS, always).kind).toBe('deny')
})

test('a model check reads the frontmatter rank: only a raise is denied', () => {
  const d = (subagent_type: string, model?: string) => decideAgent({ subagent_type, description: 'd', ...(model ? { model } : {}) }, null, AGENTS, always).kind
  expect(d('checker', 'opus')).toBe('deny')
  expect(d('checker', 'fable')).toBe('deny')
  expect(d('checker', 'sonnet')).toBe('pass')
  expect(d('checker', 'haiku')).toBe('pass')
  expect(d('checker')).toBe('pass')
  expect(d('free', 'opus')).toBe('pass')
  expect(d('unknown-agent', 'opus')).toBe('pass')
  expect(d('feature-dev:code-reviewer', 'opus')).toBe('pass')
})

test('no agent inherits the parent model: built-ins and frontmatter-less agents without model are denied, escalate: too', () => {
  const d = (subagent_type: string | undefined, description = 'd', model?: string) =>
    decideAgent({ ...(subagent_type === undefined ? {} : { subagent_type }), description, ...(model ? { model } : {}) }, null, AGENTS, () => false)
  for (const type of ['Plan', 'Explore', 'general-purpose', 'claude', 'claude-code-guide', 'web-fetch', undefined]) {
    const r = d(type)
    expect(r.kind).toBe('deny')
    if (r.kind === 'deny') {
      expect(r.check).toBe('model-inherit')
      expect(r.reason).toContain('model: "sonnet"')
    }
  }
  const free = d('free')
  expect(free.kind === 'deny' && free.check === 'model-inherit' && free.reason.includes('допиши `model:`')).toBe(true)
  const escalated = d('Plan', 'escalate: deep design')
  expect(escalated.kind === 'deny' && escalated.reason.includes('model: "opus"')).toBe(true)
  expect(d('free', 'escalate: hard').kind).toBe('deny')
  expect(d('Plan', 'p', 'sonnet').kind).toBe('pass')
  expect(d('free', 'p', 'haiku').kind).toBe('pass')
  expect(d('Plan', 'escalate: deep design', 'opus').kind).toBe('pass')
  expect(d('fork').kind).toBe('pass')
  expect(d('statusline-setup').kind).toBe('pass')
  expect(d('checker').kind).toBe('pass')
  expect(d('unknown-agent').kind).toBe('pass')
  expect(d('feature-dev:code-reviewer').kind).toBe('pass')
})

test('a typed agent named like a built-in follows its own frontmatter', () => {
  const own: AgentDef[] = [{ name: 'Plan', description: 'Project planner.', model: 'opus' }]
  expect(decideAgent({ subagent_type: 'Plan', description: 'p' }, null, own, () => false).kind).toBe('pass')
})

test('the journal count keeps the window and skips torn lines', () => {
  const t = (iso: string, check: string) => JSON.stringify({ ts: iso, check, action: 'deny' })
  const text = [t('2026-11-06T10:00:00Z', 'catch-all'), t('2026-11-06T11:00:00Z', 'catch-all'), t('2026-10-01T00:00:00Z', 'sol-route'), '{"ts":"2026-11', ''].join('\n')
  expect([...countByCheck(text, Date.parse('2026-10-31T00:00:00Z'))]).toEqual([['catch-all (deny)', 2]])
})

// ---- codex sandbox ----

const fix = (c: string) => codexFix(c)

test('codex exec launches without full access are caught and fixed', () => {
  const cases: [string, string][] = [
    ['codex exec -s workspace-write "fix it"', 'codex exec -s danger-full-access "fix it"'],
    ['codex exec --sandbox read-only -m gpt-5 "p"', 'codex exec -s danger-full-access -m gpt-5 "p"'],
    ['codex exec --sandbox=read-only "p"', 'codex exec -s danger-full-access "p"'],
    ['codex exec --full-auto "p"', 'codex exec -s danger-full-access "p"'],
    ['codex exec "p"', 'codex exec -s danger-full-access "p"'],
    ['codex exec -c sandbox_mode=workspace-write "p"', 'codex exec -s danger-full-access "p"'],
    [`codex exec -c 'sandbox_mode="read-only"' "p"`, 'codex exec -s danger-full-access "p"'],
    ['codex exec resume --last "go on"', 'codex exec -s danger-full-access resume --last "go on"'],
    ['cd /home/fake/game && codex exec -s workspace-write "p" 2>&1 | tail -5', 'cd /home/fake/game && codex exec -s danger-full-access "p" 2>&1 | tail -5'],
    ['(codex exec "p")', '(codex exec -s danger-full-access "p")'],
    ['ls; OPENAI_X=1 nohup codex exec "p" &', 'ls; OPENAI_X=1 nohup codex exec -s danger-full-access "p" &'],
    ['git status || codex -m o3 exec "p"', 'git status || codex -m o3 exec -s danger-full-access "p"'],
    ['C:/tools/codex.cmd exec "p"', 'C:/tools/codex.cmd exec -s danger-full-access "p"'],
    ['codex exec - <<EOF\nuse -s read-only here\nEOF', 'codex exec -s danger-full-access - <<EOF\nuse -s read-only here\nEOF'],
  ]
  for (const [command, fixed] of cases) expect([command, fix(command)?.fixed]).toEqual([command, fixed])
  expect(fix('codex exec --full-auto -s workspace-write "p"')?.problems[0]).toContain('--full-auto')
})

test('full access, non-launches and text about codex pass', () => {
  const ok = [
    'codex exec -s danger-full-access "p"',
    'codex exec --sandbox danger-full-access "p"',
    'codex exec -c sandbox_mode="danger-full-access" "p"',
    'codex exec --dangerously-bypass-approvals-and-sandbox "p"',
    'codex login',
    'codex --version',
    'grep -rn "codex exec -s workspace-write" .claude',
    'echo "codex exec --full-auto" > run.sh',
    "cat > run.sh <<'EOF'\ncodex exec -s workspace-write \"p\"\nEOF",
    'bash .claude/bin/sol-coder.sh docs/specs/07-spec.md coder out/07',
    'git commit -m "codex exec now runs; with -s read-only"',
    '# codex exec "p"\nls',
    'cat <<<"codex exec -s read-only"',
    'rg codex | head',
  ]
  for (const command of ok) expect([command, fix(command)]).toEqual([command, null])
})

test('every fixed command passes the check itself', () => {
  const launches = ['codex exec "p"', 'codex exec --full-auto -s read-only "p"', 'a && codex e "p" && codex exec --sandbox=read-only "q"']
  for (const c of launches) {
    const f = fix(c)
    expect(f).not.toBe(null)
    expect(fix(f!.fixed)).toBe(null)
  }
})

test('the deny gives the rule, the problem and the fixed command; a huge command is cut', () => {
  const r = codexReason({ problems: ['без флага sandbox'], models: [], fixed: 'codex exec -s danger-full-access "p"' })
  expect(r).toContain('всегда с полным доступом')
  expect(r).not.toContain('новейшей модели')
  expect(r).toContain('без флага sandbox')
  expect(r).toContain('```bash\ncodex exec -s danger-full-access "p"\n```')
  expect(codexReason({ problems: ['x'], models: [], fixed: 'y'.repeat(9000) }).length).toBeLessThan(4500)
})

// ---- codex model: the newest of its family in the Codex catalog ----

// The catalog as Codex keeps it: hidden slugs, a preview and an unparseable name never count.
const CATALOG_JSON = JSON.stringify({
  fetched_at: '2026-11-20T08:00:00Z',
  models: [
    { slug: 'gpt-6.2-sol', visibility: 'list' },
    { slug: 'gpt-6.2-astra', visibility: 'list' },
    { slug: 'gpt-6.1-terra', visibility: 'list' },
    { slug: 'gpt-reserve', visibility: 'hide' },
    { slug: 'gpt-6.1-sol', visibility: 'list' },
    { slug: 'gpt-6-astra', visibility: 'list' },
    { slug: 'gpt-6-luna', visibility: 'list' },
    { slug: 'gpt-5.6-luna', visibility: 'list' },
    { slug: 'gpt-7-sol-preview', visibility: 'list' },
    { slug: 'gpt-9-sol', visibility: 'hide' },
    { slug: 'codex-auto-review', visibility: 'hide' },
  ],
})
const CAT = parseCatalog(CATALOG_JSON)!
const FULL = '-s danger-full-access'
const mfix = (c: string) => codexFix(c, CAT)

test('the catalog: visible slugs only; the newest of a family is numeric, previews and hidden ones never win', () => {
  expect(CAT).not.toContain('gpt-reserve')
  expect(CAT).not.toContain('gpt-9-sol')
  expect(newestOf(CAT, 'sol')).toBe('gpt-6.2-sol')
  expect(newestOf(CAT, 'astra')).toBe('gpt-6.2-astra')
  expect(newestOf(CAT, 'luna')).toBe('gpt-6-luna')
  expect(newestOf(CAT, 'nova')).toBe(null)
  expect(newestOf(['gpt-6.2-sol', 'gpt-6.10-sol', 'gpt-6-sol'], 'sol')).toBe('gpt-6.10-sol')
  for (const bad of ['', 'nope', '{"models":{}}', '[]']) expect([bad, parseCatalog(bad)]).toEqual([bad, null])
  expect(parseCatalog('﻿{"models":[{"slug":"gpt-6-sol","visibility":"list"},null,{"visibility":"list"}]}')).toEqual(['gpt-6-sol'])
})

test('no model: the newest sol is added after exec', () => {
  const f = mfix(`codex exec ${FULL} "fix the drift"`)!
  expect(f.fixed).toBe(`codex exec -m gpt-6.2-sol ${FULL} "fix the drift"`)
  expect(f.problems).toEqual([])
  expect(f.models[0]).toContain('модель не задана')
  expect(f.models[0]).toContain('`-m gpt-6.2-sol`')
})

test('an old pinned model goes to the newest of the SAME family, whatever flag spelling names it', () => {
  const cases: [string, string][] = [
    [`codex exec ${FULL} -m gpt-6.1-sol "p"`, `codex exec ${FULL} -m gpt-6.2-sol "p"`],
    [`codex exec ${FULL} -m gpt-6-astra "p"`, `codex exec ${FULL} -m gpt-6.2-astra "p"`],
    [`codex exec ${FULL} --model gpt-5.6-luna "p"`, `codex exec ${FULL} --model gpt-6-luna "p"`],
    [`codex exec ${FULL} --model=gpt-6-astra "p"`, `codex exec ${FULL} --model=gpt-6.2-astra "p"`],
    [`codex exec ${FULL} -m=gpt-6.1-sol "p"`, `codex exec ${FULL} -m=gpt-6.2-sol "p"`],
    [`codex exec ${FULL} -mgpt-6.1-sol "p"`, `codex exec ${FULL} -mgpt-6.2-sol "p"`],
    [`codex exec ${FULL} -m "gpt-6.1-sol" "p"`, `codex exec ${FULL} -m gpt-6.2-sol "p"`],
    [`codex -m gpt-6.1-sol exec ${FULL} "p"`, `codex -m gpt-6.2-sol exec ${FULL} "p"`],
    [`codex exec ${FULL} "p" -m gpt-6-sol`, `codex exec ${FULL} "p" -m gpt-6.2-sol`],
  ]
  for (const [command, fixed] of cases) expect([command, mfix(command)?.fixed]).toEqual([command, fixed])
  expect(mfix(`codex exec ${FULL} -m gpt-6-astra "p"`)!.models[0]).toBe('`gpt-6-astra` устарела → `gpt-6.2-astra`, новейшая astra в каталоге Codex')
})

test('left alone: the current model, a newer one, an unknown slug or family, a model chosen by profile, -c model= or a local provider', () => {
  const ok = [
    `codex exec ${FULL} -m gpt-6.2-sol "p"`,
    `codex exec ${FULL} -m gpt-6.2-astra "p"`,
    `codex exec ${FULL} -m gpt-6.1-terra "p"`,
    `codex exec ${FULL} -m gpt-6.3-sol "p"`,
    `codex exec ${FULL} -m gpt-7-sol-preview "p"`,
    `codex exec ${FULL} -m gpt-5 "p"`,
    `codex exec ${FULL} -m o3 "p"`,
    `codex exec ${FULL} -m gpt-6-nova "p"`,
    `codex exec ${FULL} -m "$MODEL" "p"`,
    `codex exec ${FULL} -p fast "p"`,
    `codex exec ${FULL} --profile=fast "p"`,
    `codex -p fast exec ${FULL} "p"`,
    `codex exec ${FULL} -c model=gpt-6.1-sol "p"`,
    `codex exec ${FULL} -c 'model="gpt-6-astra"' "p"`,
    `codex exec ${FULL} --config=model=gpt-6-sol "p"`,
    `codex exec ${FULL} --oss "p"`,
    `codex exec ${FULL} --local-provider ollama "p"`,
  ]
  for (const command of ok) expect([command, mfix(command)]).toEqual([command, null])
  // After `--` a `-m` is prompt text, and `-c model_reasoning_effort=` is not the model: the model is still missing.
  expect(mfix(`codex exec ${FULL} -- -m gpt-6-sol`)?.fixed).toBe(`codex exec -m gpt-6.2-sol ${FULL} -- -m gpt-6-sol`)
  expect(mfix(`codex exec ${FULL} -c model_reasoning_effort=high "p"`)?.fixed).toBe(`codex exec -m gpt-6.2-sol ${FULL} -c model_reasoning_effort=high "p"`)
})

test('no catalog, or one without the family: the model is not checked, only the sandbox', () => {
  expect(codexFix(`codex exec ${FULL} -m gpt-6.1-sol "p"`, null)).toBe(null)
  expect(codexFix(`codex exec ${FULL} "p"`, null)).toBe(null)
  expect(codexFix('codex exec -m gpt-6.1-sol "p"', null)).toEqual({
    problems: ['без флага sandbox'],
    models: [],
    fixed: `codex exec ${FULL} -m gpt-6.1-sol "p"`,
  })
  expect(codexFix(`codex exec ${FULL} "p"`, ['gpt-6.2-astra'])).toBe(null)
  expect(codexFix(`codex exec ${FULL} "p"`, [])).toBe(null)
})

test('sandbox and model wrong together: one fixed command carries both fixes', () => {
  const cases: [string, string][] = [
    ['codex exec "p"', `codex exec ${FULL} -m gpt-6.2-sol "p"`],
    ['codex exec --full-auto -m gpt-6.1-sol "p"', `codex exec ${FULL} -m gpt-6.2-sol "p"`],
    ['codex exec -s workspace-write -m gpt-6-astra "p"', `codex exec ${FULL} -m gpt-6.2-astra "p"`],
    [
      'cd /home/fake/game && codex exec -s read-only "a" && codex e -m gpt-6-sol "b" | tail -3',
      `cd /home/fake/game && codex exec ${FULL} -m gpt-6.2-sol "a" && codex e ${FULL} -m gpt-6.2-sol "b" | tail -3`,
    ],
  ]
  for (const [command, fixed] of cases) expect([command, mfix(command)?.fixed]).toEqual([command, fixed])
  const f = mfix('codex exec "p"')!
  expect(f.problems).toEqual(['без флага sandbox'])
  expect(f.models.length).toBe(1)
  const r = codexReason(f)
  expect(r).toContain(`всегда с полным доступом \`${FULL}\` и на новейшей модели своего семейства из каталога Codex`)
  expect(r).toContain('без флага sandbox; модель не задана')
  expect(r).toContain(`\`\`\`bash\ncodex exec ${FULL} -m gpt-6.2-sol "p"\n\`\`\``)
  expect(codexReason({ problems: [], models: ['m'], fixed: 'x' })).not.toContain('полным доступом')
})

test('codex exec resume: the model goes in after exec like the sandbox; an old one is replaced', () => {
  expect(mfix('codex exec resume --last "go on"')?.fixed).toBe(`codex exec ${FULL} -m gpt-6.2-sol resume --last "go on"`)
  expect(mfix(`codex exec ${FULL} resume --last -m gpt-6.1-sol "go on"`)?.fixed).toBe(`codex exec ${FULL} resume --last -m gpt-6.2-sol "go on"`)
  expect(mfix(`codex exec ${FULL} -m gpt-6.2-sol resume --last "go on"`)).toBe(null)
})

test('every model-fixed command passes the check itself, and text about codex stays untouched', () => {
  for (const c of ['codex exec "p"', 'codex exec -m gpt-6-astra --full-auto "p"', 'a && codex e "p" && codex -m gpt-6.1-sol exec -s read-only "q"', 'codex exec resume --last']) {
    const f = mfix(c)
    expect(f).not.toBe(null)
    expect([c, mfix(f!.fixed)]).toEqual([c, null])
  }
  for (const c of ['grep -rn "codex exec -m gpt-6.1-sol" .claude', "cat > run.sh <<'EOF'\ncodex exec -m gpt-6-sol \"p\"\nEOF", 'codex --version', 'codex -m gpt-6.1-sol']) {
    expect([c, mfix(c)]).toEqual([c, null])
  }
})

// ---- the project's own Codex launcher ----

test('codexLauncher is optional text, kept trimmed only when present', () => {
  expect(parseRoutes('{"routes":[],"codexLauncher":"  bin/codex-run --cd <wt>  "}')).toEqual({ routes: [], notes: [], codexLauncher: 'bin/codex-run --cd <wt>' })
  expect('error' in parseRoutes('{"routes":[],"codexLauncher":3}')).toBe(true)
  expect(parseRoutes('{"routes":[]}')).toEqual({ routes: [], notes: [] })
})

test('a raw codex exec is a launch; text about it and the launcher itself are not', () => {
  for (const c of ['codex exec -s danger-full-access - < prompt.md', 'cd wt && codex e "p"', 'C:/tools/codex.cmd exec "p"']) {
    expect([c, launchesCodexExec(c)]).toEqual([c, true])
  }
  for (const c of ['bin/codex-run --cd wt --prompt p.md --out x', 'grep "codex exec" .claude', 'codex --version', "cat > p.md <<'EOF'\ncodex exec x\nEOF"]) {
    expect([c, launchesCodexExec(c)]).toEqual([c, false])
  }
  expect(launcherReason('bin/codex-run --cd <wt>')).toContain('```bash\nbin/codex-run --cd <wt>\n```')
})
