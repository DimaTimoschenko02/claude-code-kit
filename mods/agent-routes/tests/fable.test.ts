import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { claudeLaunches } from '../hooks/fable'

const HOME = '/home/fake'
const ROOT = '/home/fake/game'
const JOURNAL = `${HOME}/.claude/state/agent-routes/decisions.jsonl`

/** The explicit Fable source the parser found in a command, or null. */
const fableOf = (command: string) => claudeLaunches(command).find(l => l.fable)?.fable ?? null

// ---- launches that start a Fable session: refused ----

const LAUNCHES = [
  // the incident, as the session typed it
  'claude --bg --model claude-fable-5-2 -n "chat-audit" "Run chat-audit for the last week"',
  'cd /home/fake/mind && claude --bg --model claude-fable-5-2 -n audit "go"',
  'claude -p --model fable "hi"',
  'claude --print --model=Fable "x"',
  'claude --model FABLE',
  'claude --resume abc --model fable',
  'claude --fallback-model claude-fable-5-2 -p x',
  "claude --settings '{\"model\":\"fable\"}' -p x",
  'ANTHROPIC_MODEL=claude-fable-5-2 claude -p hi',
  'env ANTHROPIC_MODEL=fable claude -p x',
  'export ANTHROPIC_MODEL=fable && claude --bg "x"',
  'ANTHROPIC_DEFAULT_OPUS_MODEL=claude-fable-5-2 claude --model opus -p x',
  'nohup claude -p --model fable "x" > out.log 2>&1 &',
  'bash -c "claude --model fable -p hi"',
  "ssh homesrv 'cd mind && claude --bg --model fable \"x\"'",
  'cmd /c "claude --model fable -p x"',
  '"D:\\tools\\claude.exe" --model fable -p x',
  '/usr/local/bin/claude --model fable -p x',
  'caffeinate -i claude --model fable',
  'npx @anthropic-ai/claude-code --model fable -p x',
  'x="$(claude -p --model fable \'summarize\')"',
  'git commit -m "$(claude -p --model fable \'write a commit message\')"',
  "claude --agent judge --agents '{\"judge\":{\"description\":\"d\",\"prompt\":\"p\",\"model\":\"fable\"}}' -p x",
  // PowerShell spellings
  '$env:ANTHROPIC_MODEL="claude-fable-5-2"; claude -p x',
  "Start-Process claude -ArgumentList '--bg --model fable \"x\"'",
  '& claude --model claude-fable-5-2 -p x',
]

test('every spelling of a Claude launch on Fable is found', () => {
  for (const cmd of LAUNCHES) expect([cmd, fableOf(cmd) !== null]).toEqual([cmd, true])
})

// ---- text that mentions Fable, subagents on Fable, Codex: left alone ----

const LEFT_ALONE = [
  'git commit -m "agent-routes: deny claude --model claude-fable-5-2 launches"',
  "git commit -F - -- mods/agent-routes <<'EOF'\nBlock claude --bg --model claude-fable-5-2 sessions\nEOF",
  "git commit -m \"$(cat <<'EOF'\nDeny claude --model claude-fable sessions (only the owner starts them)\nEOF\n)\"",
  'echo "claude --model fable"',
  'echo claude --model fable',
  'grep -rn -- "--model fable" .',
  "rg 'claude --model claude-fable' notes",
  "cat > note.md <<'EOF'\nclaude --bg --model claude-fable-5-2\nEOF",
  'obsidian create name=x content="claude --model fable"',
  'node tool.mjs --text "claude --model fable"',
  'claude --bg --model opus -n audit "use Fable as a subagent for the final decision"',
  'claude -p "why did a session run --model claude-fable-5-2?"',
  'claude -p -- --model fable',
  "claude --model opus --agents '{\"judge\":{\"description\":\"d\",\"prompt\":\"p\",\"model\":\"fable\"}}' -p x",
  'CLAUDE_CODE_SUBAGENT_MODEL=fable claude -p x',
  'codex exec -s danger-full-access "claude --model fable"',
  'claude agents --json',
  'cd ~/claude && ls',
]

test('mentions, subagents on Fable and Codex are not a Fable launch', () => {
  for (const cmd of LEFT_ALONE) expect([cmd, fableOf(cmd)]).toEqual([cmd, null])
})

test('a management subcommand or --help opens no session; a prompt that looks like one does', () => {
  expect(claudeLaunches('claude respawn abc').map(l => l.session)).toEqual([false])
  expect(claudeLaunches('claude plugin validate .').map(l => l.session)).toEqual([false])
  expect(claudeLaunches('claude --help').map(l => l.session)).toEqual([false])
  expect(claudeLaunches('claude -p "agents are fine"').map(l => l.session)).toEqual([true])
  expect(claudeLaunches('claude --name agents -p x').map(l => l.session)).toEqual([true])
  expect(claudeLaunches('ls ~/.claude && cat ~/.claude/settings.json')).toEqual([])
})

// ---- through the engine ----

function world(on: On, files: Record<string, string> = {}, env: Record<string, string> = {}) {
  const w = { files: new Map(Object.entries(files)), calls: [] as Record<string, unknown>[] }
  const key = (p: string) => p.replace(/\\/g, '/').replace(/^(?:.*\/)?[A-Za-z]:(?=\/)/, '')
  mock.env(on, { HOME, ...env })
  mock.clock(on, { now: Date.UTC(2026, 10, 26, 10, 0, 0) })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.root', () => ({ value: ROOT }))
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
    w.files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('tool.call', (_$, e) => {
    w.calls.push({ ...e })
    return { result: 'ok' } as never
  })
  return w
}

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const journal = (w: ReturnType<typeof world>) =>
  (w.files.get(JOURNAL) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)

test('the incident command is refused in Russian with the way forward, and journaled', async ($, on) => {
  const w = world(on)
  const r = await bash($, 'claude --bg --model claude-fable-5-2 -n "chat-audit" "Run chat-audit"')
  expect(r.deny).toContain('сессию на Fable запускает только владелец')
  expect(r.deny).toContain('--model claude-fable-5-2')
  expect(r.deny).toContain('Opus 5.5 high')
  expect(r.deny).toContain('субагентом')
  expect(w.calls).toEqual([])
  expect(journal(w).map(j => j.check)).toEqual(['fable-session'])
})

test('a commit message naming the flag, an echo and an Opus session run', async ($, on) => {
  const w = world(on)
  for (const cmd of [
    'git commit -m "Refuse claude --bg --model claude-fable-5-2 from agents"',
    'echo "claude --model fable"',
    'claude --bg --model opus --effort high -n audit "Fable decides at the end as a subagent"',
  ]) {
    expect((await bash($, cmd)).deny).toBeUndefined()
  }
  expect(w.calls.length).toBe(3)
  expect(journal(w)).toEqual([])
})

test('an Agent call on Fable is not this guard\'s business', async ($, on) => {
  const w = world(on, {
    [`${ROOT}/.claude/agents/judge.md`]: '---\nname: judge\ndescription: Makes the final call.\nmodel: fable\n---\nbody\n',
  })
  const r = await $.tool.call({ tool: 'Agent', subagent_type: 'judge', description: 'final decision', prompt: 'decide', model: 'fable' })
  expect(r.deny).toBeUndefined()
  expect(w.calls.length).toBe(1)
})

test('a launch with no model refuses only when what it inherits is Fable', async ($, on) => {
  const w = world(on, {
    [`${HOME}/.claude/settings.json`]: JSON.stringify({ model: 'claude-fable-5-2', pluginConfigs: {} }),
    [`${ROOT}/.claude/agents/judge.md`]: '---\nname: judge\ndescription: Makes the final call.\nmodel: fable\n---\nbody\n',
    [`${ROOT}/.claude/agents/coder.md`]: '---\nname: coder\ndescription: Writes code.\nmodel: sonnet\n---\nbody\n',
  })
  expect((await bash($, 'claude -p "hi"')).deny).toContain('модель по умолчанию claude-fable-5-2')
  expect((await bash($, 'claude --model opus -p "hi"')).deny).toBeUndefined()
  expect((await bash($, 'claude agents --json')).deny).toBeUndefined()
  expect((await bash($, 'claude --agent coder -p "hi"')).deny).toBeUndefined()
  w.files.set(`${HOME}/.claude/settings.json`, JSON.stringify({ model: 'opus' }))
  expect((await bash($, 'claude -p "hi"')).deny).toBeUndefined()
  expect((await bash($, 'claude --agent judge -p "hi"')).deny).toContain('--agent judge')
  expect((await bash($, 'claude --agent judge --model opus -p "hi"')).deny).toBeUndefined()
})

test('a model inherited from this process\'s env counts', async ($, on) => {
  world(on, {}, { ANTHROPIC_MODEL: 'claude-fable-5-2' })
  expect((await bash($, 'claude --bg "x"')).deny).toContain('ANTHROPIC_MODEL=claude-fable-5-2')
  expect((await bash($, 'claude --bg --model opus "x"')).deny).toBeUndefined()
})

test('Monitor, PowerShell and a cloud routine are shell doors too', async ($, on) => {
  const w = world(on)
  expect((await $.tool.call({ tool: 'Monitor', description: 'd', timeout_ms: 1000, command: 'claude -p --model fable x' })).deny).toContain('Fable')
  expect((await $.tool.call({ tool: 'Monitor', description: 'd', timeout_ms: 1000, command: 'tail -f log | grep fable' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'PowerShell', command: '& claude --model claude-fable-5-2 -p x' })).deny).toContain('Fable')
  expect((await $.tool.call({ tool: 'RemoteTrigger', action: 'create', body: { model: 'claude-fable-5-2', prompt: 'x' } })).deny).toContain('Fable')
  expect((await $.tool.call({ tool: 'RemoteTrigger', action: 'create', body: { model: 'claude-opus-5-5', prompt: 'about fable' } })).deny).toBeUndefined()
  expect(journal(w).map(j => j.check)).toEqual(['fable-session', 'fable-session', 'fable-session'])
})
