import { expect, test } from 'claude-code/testing'

import { codexReason, codexSandboxFix } from '../hooks/codex'
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
  expect(bare).toContain('`general-purpose`, `Explore`, `claude`')
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

test('a model check reads the frontmatter rank: only a raise is dropped', () => {
  const d = (subagent_type: string, model?: string) => decideAgent({ subagent_type, description: 'd', ...(model ? { model } : {}) }, null, AGENTS, always).kind
  expect(d('checker', 'opus')).toBe('drop-model')
  expect(d('checker', 'fable')).toBe('drop-model')
  expect(d('checker', 'sonnet')).toBe('pass')
  expect(d('checker', 'haiku')).toBe('pass')
  expect(d('checker')).toBe('pass')
  expect(d('free', 'opus')).toBe('pass')
  expect(d('unknown-agent', 'opus')).toBe('pass')
  expect(d('feature-dev:code-reviewer', 'opus')).toBe('pass')
})

test('the journal count keeps the window and skips torn lines', () => {
  const t = (iso: string, check: string) => JSON.stringify({ ts: iso, check, action: 'deny' })
  const text = [t('2026-11-06T10:00:00Z', 'catch-all'), t('2026-11-06T11:00:00Z', 'catch-all'), t('2026-10-01T00:00:00Z', 'sol-route'), '{"ts":"2026-11', ''].join('\n')
  expect([...countByCheck(text, Date.parse('2026-10-31T00:00:00Z'))]).toEqual([['catch-all (deny)', 2]])
})

// ---- codex sandbox ----

const fix = (c: string) => codexSandboxFix(c)

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
  const r = codexReason(['без флага sandbox'], 'codex exec -s danger-full-access "p"')
  expect(r).toContain('всегда с полным доступом')
  expect(r).toContain('без флага sandbox')
  expect(r).toContain('```bash\ncodex exec -s danger-full-access "p"\n```')
  expect(codexReason(['x'], 'y'.repeat(9000)).length).toBeLessThan(4500)
})
