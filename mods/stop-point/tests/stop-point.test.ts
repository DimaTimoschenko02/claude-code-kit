import type { On, SessionMessage, ToolCallResult } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import { PHRASE, isOwnerPrompt, limits } from '../hooks/logic'

const ROOT = '/proj'
const HOME = '/home/u'
const SID = 'sess-1234abcd-0000'
const POINT = `${ROOT}/.claude/state/resume/${SID}.md`
const START = Date.UTC(2026, 9, 4, 8, 0)
const WINDOW = { autoCompactWindow: 300_000 }

type File = { text: string; mtimeMs: number }
type World = {
  tokens: number | null
  files: Map<string, File>
  dirs: Set<string>
  settings: { merged: Record<string, unknown>; project: Record<string, unknown>; local: Record<string, unknown>; user: Record<string, unknown> }
  status: (string | undefined)[]
  toasts: string[]
  runs: (readonly string[])[]
  prompts: { text: string; context: readonly string[] }[]
  compactions: number
  summary: SessionMessage[]
  /** Runs inside the engine's compaction, as core raises SessionStart(compact) there. */
  duringCompact: (() => Promise<void>) | null
  ran: string[]
  clock: MockClock
}

/** The world beneath the plugin: session, settings, files, clock, display, and each event's engine answer. */
function world(on: On, opts: { projectMode?: boolean; settings?: Partial<World['settings']> } = {}): World {
  const w: World = {
    tokens: 100_000,
    files: new Map(),
    dirs: new Set(opts.projectMode === false ? [] : [`${ROOT}/.claude/state/resume`]),
    settings: { merged: WINDOW, project: {}, local: {}, user: {}, ...opts.settings },
    status: [],
    toasts: [],
    runs: [],
    prompts: [],
    compactions: 0,
    summary: [{ role: 'user', text: 'This session is being continued from a previous conversation. Summary.', toolUses: [] }],
    duringCompact: null,
    ran: [],
    clock: mock.clock(on, { now: START }),
  }
  mock.env(on, { HOME })
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: SID }))
  on('session.usage', () => ({
    value: {
      startedAt: START,
      context: w.tokens === null ? { window: 1_000_000 } : { tokens: w.tokens, window: 1_000_000 },
      rateLimits: [],
    },
  }))
  on('settings.read', (_$, e) => ({ value: w.settings[e.source === undefined ? 'merged' : (e.source as 'project')] ?? {} }))
  on('fs.exists', (_$, e) => ({ value: w.files.has(e.path) || w.dirs.has(e.path) }))
  on('fs.stat', (_$, e) => {
    const f = w.files.get(e.path)
    if (f !== undefined) {
      return { value: { kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false, ...(e.resolve ? { realPath: e.path } : {}) } }
    }
    if (w.dirs.has(e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: START, isLink: false, ...(e.resolve ? { realPath: e.path } : {}) } }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.read', (_$, e) => {
    const f = w.files.get(e.path)
    if (f !== undefined) return { value: f.text }
    // the mod's own template, shipped beside plugin.json (nothing real is read beneath a test)
    if (e.path.endsWith('/stop-point/template.md')) return { value: '# Точка останова — формат\n\nMOD FORMAT BODY' }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.write', (_$, e) => {
    w.files.set(e.path, { text: e.text, mtimeMs: w.clock.now() })
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    w.runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', (_$, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.measure', () => ({ changed: [] }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('prompt.submit', (_$, e) => {
    w.prompts.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }
  })
  on('agent.spawn', () => ({ model: 'test-model', agentId: 'agent-1' }))
  on('session.compact', async () => {
    w.compactions += 1
    if (w.duringCompact !== null) await w.duringCompact()
    return { messages: w.summary }
  })
  on('tool.call', (_$, e) => {
    w.ran.push(e.tool)
    const path = (e as { file_path?: unknown }).file_path
    if (e.tool === 'Write' && typeof path === 'string') {
      w.files.set(path, { text: String((e as { content?: unknown }).content), mtimeMs: w.clock.now() })
    }
    return { result: 'ok' } as never
  })
  return w
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: null, isInteractive: true })
const ctx = (r: ToolCallResult): string => (r.context ?? []).join('\n')
const read = ($: Engine, file = `${ROOT}/src/a.ts`) => $.tool.call({ tool: 'Read', file_path: file })
const edit = ($: Engine, file = `${ROOT}/src/a.ts`) => $.tool.call({ tool: 'Edit', file_path: file, old_string: 'a', new_string: 'b' })
const writePoint = ($: Engine, text = '# Stop point\n\n## Опоры\n- docs/plan.md — the plan') =>
  $.tool.call({ tool: 'Write', file_path: POINT, content: text })
const prompt = ($: Engine, text: string, kind: 'composer' | 'task-notification' = 'composer') =>
  $.prompt.submit({ text, wait: false, origin: { kind } as never })
const stop = ($: Engine) => $.classic.Stop({ stop_hook_active: false })
const HELD = {
  point: { path: POINT, writtenAt: START, tokens: 200_000 },
  askedAt: null, need: null, naggedAt: null, stopNagged: false, escape: false, request: 'none' as const, hold: true,
  compactSeq: 0, injectedSeq: 0, pointDue: false, pending: [],
}
const TRANSCRIPT: SessionMessage[] = [{ role: 'user', text: 'hello', toolUses: [] }]
const compact = ($: Engine, trigger: 'auto' | 'manual', messages: SessionMessage[] = TRANSCRIPT) =>
  $.session.compact({ trigger, messages })

describe('threshold', () => {
  test('asks once per crossing mid-turn, again only after the growth step', async ($, on) => {
    const w = world(on)
    await start($)
    w.tokens = 200_000
    expect(ctx(await read($))).toBe('')
    w.tokens = 275_000
    const asked = ctx(await read($))
    expect(asked).toContain('Следующим вызовом, до продолжения задачи — ТОЧКА ОСТАНОВА (контекст вырос, сжатие близко')
    expect(asked).toContain(POINT)
    expect(asked).toContain('=== ФОРМАТ ТОЧКИ ОСТАНОВА') // the template rides inline: no Read of it
    expect(asked).toContain('MOD FORMAT BODY')
    w.tokens = 280_000
    expect(ctx(await read($))).toBe('')
    expect((await stop($)).block).toBeUndefined()
    w.tokens = 396_000
    expect(ctx(await read($))).toContain('ТОЧКА ОСТАНОВА (контекст вырос')
  })

  test('asks at Stop with the path form when no tool call crossed it, once', async ($, on) => {
    const w = world(on)
    await start($)
    w.tokens = 275_000
    const r = await stop($)
    expect(r.block).toContain(`перезапиши целиком одним Write ${POINT} по формату `)
    expect(r.block).not.toContain('=== ФОРМАТ')
    expect(w.toasts.at(-1)).toContain('контекст 275k')
    w.tokens = 276_000
    expect((await stop($)).block).toBeUndefined()
    expect(ctx(await read($))).toBe('')
  })

  test('a written point stops the asking until the context grows past it', async ($, on) => {
    const w = world(on)
    await start($)
    w.tokens = 271_000
    await writePoint($)
    w.tokens = 280_000
    expect(ctx(await read($))).toBe('')
    expect((await stop($)).block).toBeUndefined()
    expect(w.status.at(-1)).toMatch(/^ctx 93% · точка \d\d:\d\d$/)
  })

  test('derives from autoCompactWindow and the model window', () => {
    expect(limits({ autoCompactWindow: 300_000 })).toEqual({
      window: 300_000, trigger: 270_000, growth: 120_000, minMain: 249_000, ceil: 420_000, fresh: 40_000,
    })
    expect(limits({ autoCompactWindow: 300_000, modelWindow: 200_000 })).toEqual({
      window: 200_000, trigger: 180_000, growth: 80_000, minMain: 166_000, ceil: 190_000, fresh: 40_000,
    })
    expect(limits({}).trigger).toBe(270_000)
    expect(limits({ autoCompactWindow: 300_000, triggerOverride: 100_000 }).trigger).toBe(100_000)
  })
})

describe('owner request and hold', () => {
  test('the phrase in any form; relays never', () => {
    for (const t of ['точка останова', 'Точка останова!', 'ТОЧКУ  ОСТАНОВА', 'запиши точку останова пожалуйста', 'точки\u00a0останова']) {
      expect(PHRASE.test(t)).toBe(true)
    }
    expect(PHRASE.test('точка с запятой')).toBe(false)
    expect(isOwnerPrompt('composer', 'точка останова')).toBe(true)
    expect(isOwnerPrompt('composer', '<task-notification> точка останова')).toBe(false)
    expect(isOwnerPrompt('task-notification', 'точка останова')).toBe(false)
    expect(isOwnerPrompt('peer', 'точка останова')).toBe(false)
  })

  test('request → point → only reads and the point until /compact', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'запиши решение в долги и точка останова')
    const asked = w.prompts.at(-1)?.context.join('\n') ?? ''
    expect(asked).toContain('ПОСЛЕДНИМ вызовом хода — точку')
    expect(asked).toContain(`одним Write ${POINT}`)
    expect(asked).toContain('=== ФОРМАТ ТОЧКИ ОСТАНОВА')

    expect(ctx(await edit($))).toBe('') // other asks first: nothing is held before the point
    const written = await writePoint($)
    expect(ctx(written)).toContain('Заверши ход отбивкой 💾')
    expect(w.status.at(-1)).toContain('жду /compact')

    expect((await edit($)).deny).toContain('Точка останова записана — заверши ход')
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toContain('заверши ход')
    expect((await $.agent.spawn({ tool_use_id: 't1', prompt: 'x', description: 'x', subagentType: 'general-purpose', provider: { kind: 'builtin' } as never, parentModel: 'm', background: false, fork: false })).deny).toContain('заверши ход')
    expect((await read($)).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'Grep', pattern: 'x' } as never)).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'Glob', pattern: '*' } as never)).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'Edit', file_path: POINT, old_string: 'plan', new_string: 'plan v2' })).deny).toBeUndefined()
    expect((await stop($)).block).toBeUndefined() // the held turn ends without another ask

    await compact($, 'manual')
    expect(w.compactions).toBe(1)
    expect((await edit($)).deny).toBeUndefined()
  })

  test('the owner prompt without the phrase lifts the hold; a relay does not', async ($, on) => {
    const w = world(on)
    await start($)
    await prompt($, 'точка останова')
    await writePoint($)
    expect((await edit($)).deny).toContain('заверши ход')
    await prompt($, '<task-notification>agent done</task-notification>', 'task-notification')
    expect((await edit($)).deny).toContain('заверши ход')
    await prompt($, 'точка останова', 'task-notification')
    expect(w.prompts.at(-1)?.context.join('\n') ?? '').not.toContain('ПОСЛЕДНИМ вызовом')
    await prompt($, 'не компактим, продолжай')
    expect((await edit($)).deny).toBeUndefined()
  })

  test('a turn that ends without the asked point is blocked once', async ($, on) => {
    world(on)
    await start($)
    await prompt($, 'точка останова')
    const r = await stop($)
    expect(r.block).toContain('ТОЧКА ОСТАНОВА (владелец просил её в этом ходе')
    expect((await stop($)).block).toBeUndefined()
  })

  test('a fresh module instance honours the hold the host holds', async ($, on) => {
    world(on)
    // the host answers $.state with what an earlier instance of the module wrote
    on('state.get', (_$, e, next) =>
      e.plugin === 'stop-point'
        ? { value: { value: { ...HELD }, version: 3 } }
        : next(e))
    await start($)
    expect((await edit($)).deny).toContain('заверши ход')
    expect((await read($)).deny).toBeUndefined()
  })

  test('a hot reload keeps the hold: the state is the host\'s, not the module\'s', async ($, on) => {
    world(on)
    await start($)
    await prompt($, 'точка останова')
    await writePoint($)
    await start($) // a reload fires session.start again and drops the module's caches
    expect((await edit($)).deny).toContain('заверши ход')
  })
})

describe('auto-compaction gate', () => {
  test('vetoed without a fresh point, nagged mid-turn, passes once it is written; manual never vetoed', async ($, on) => {
    const w = world(on)
    await start($)
    w.tokens = 285_000
    await stop($) // spends the threshold ask
    const first = await compact($, 'auto')
    expect(first.skip).toContain('авто-компакт отложен до записи точки останова (контекст 285k)')
    expect(w.compactions).toBe(0)
    expect((await compact($, 'auto')).skip).toBeDefined() // the engine's retry: still waiting
    const log = w.files.get(`${HOME}/.claude/state/stop-point/gate.log`)?.text ?? ''
    expect(log.trim().split('\n')).toHaveLength(1) // a retry is not logged
    expect(log).toContain(' auto 285000 sess-123 defer')

    expect(ctx(await read($))).toContain('Следующим вызовом, до продолжения задачи — ТОЧКА ОСТАНОВА (авто-компакт ждёт её')
    w.tokens = 290_000
    expect(ctx(await read($))).toBe('')
    w.tokens = 306_000
    expect(ctx(await read($))).toContain('авто-компакт ждёт её')
    expect(w.status.at(-1)).toContain('компакт ждёт точку')

    await writePoint($)
    w.tokens = 310_000
    const passed = await compact($, 'auto')
    expect(passed.skip).toBeUndefined()
    expect(w.compactions).toBe(1)
    expect(w.files.get(`${HOME}/.claude/state/stop-point/gate.log`)?.text).toContain('pass-fresh')

    w.tokens = 290_000
    expect((await compact($, 'manual')).skip).toBeUndefined() // no point in this cycle, manual still runs
    expect(w.compactions).toBe(2)
  })

  test('a point older than the fresh margin does not count', async ($, on) => {
    const w = world(on)
    await start($)
    w.tokens = 250_000
    await writePoint($)
    w.tokens = 300_000
    expect((await compact($, 'auto')).skip).toBeDefined()
  })

  test('a Stop while the gate waits asks for the point once', async ($, on) => {
    const w = world(on)
    await start($)
    w.tokens = 285_000
    await stop($)
    await compact($, 'auto')
    const r = await stop($)
    expect(r.block).toContain('ТОЧКА ОСТАНОВА (авто-компакт ждёт её')
    expect((await stop($)).block).toBeUndefined()
  })

  test('a prompt while the gate waits carries its request', async ($, on) => {
    const w = world(on)
    await start($)
    w.tokens = 285_000
    await stop($)
    await compact($, 'auto')
    await prompt($, 'что там дальше?')
    expect(w.prompts.at(-1)?.context.join('\n') ?? '').toContain('ТОЧКА ОСТАНОВА (авто-компакт ждёт её')
  })

  test('never wedges: no usage, ceiling, below the main window, an API error, a subagent', async ($, on) => {
    const w = world(on)
    await start($)
    w.tokens = null
    expect((await compact($, 'auto')).skip).toBeUndefined()
    w.tokens = 420_000
    expect((await compact($, 'auto')).skip).toBeUndefined()
    w.tokens = 200_000
    expect((await compact($, 'auto')).skip).toBeUndefined()
    expect(w.compactions).toBe(3)

    w.tokens = 285_000
    expect((await compact($, 'auto')).skip).toBeDefined()
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'error' })
    expect((await compact($, 'auto')).skip).toBeUndefined() // the prompt-too-long the veto would repeat
    expect(w.compactions).toBe(4)

    expect((await $.session.compact({ trigger: 'auto', agentId: 'agent-1', messages: TRANSCRIPT })).skip).toBeUndefined()
    const log = w.files.get(`${HOME}/.claude/state/stop-point/gate.log`)?.text ?? ''
    for (const d of ['pass-no-usage', 'pass-ceil', 'pass-not-main', 'defer', 'pass-error']) expect(log).toContain(d)
  })
})

describe('after compaction', () => {
  test('SessionStart(compact) inside the compaction carries the point, once', async ($, on) => {
    const w = world(on)
    await start($)
    await writePoint($, '# Stop point\n\n## Значения\n- 42 rows, measured 04.10')
    let injected = ''
    w.duringCompact = async () => {
      const r = await $.classic.SessionStart({ source: 'compact' })
      injected = (r.additionalContext ?? []).join('\n')
    }
    await compact($, 'manual')
    expect(injected).toContain('=== ТОЧКА ОСТАНОВА (после компакта; записана')
    expect(injected).toContain('42 rows, measured 04.10')
    expect(injected).toContain(`Файл: ${POINT}`)
    expect(ctx(await read($))).not.toContain('ТОЧКА ОСТАНОВА (после компакта')
    expect(w.status.at(-1)).toContain('точки нет') // a new cycle: the old point is not this one's
  })

  test('SessionStart(compact) after the compaction carries it, once', async ($, on) => {
    world(on)
    await start($)
    await writePoint($)
    await compact($, 'manual')
    const r = await $.classic.SessionStart({ source: 'compact' })
    expect((r.additionalContext ?? []).join('\n')).toContain('ТОЧКА ОСТАНОВА (после компакта')
    expect(ctx(await read($))).not.toContain('ТОЧКА ОСТАНОВА (после компакта')
  })

  test('without SessionStart the next tool call carries it, once', async ($, on) => {
    world(on)
    await start($)
    await writePoint($)
    await compact($, 'manual')
    expect(ctx(await read($))).toContain('ТОЧКА ОСТАНОВА (после компакта')
    expect(ctx(await read($))).not.toContain('ТОЧКА ОСТАНОВА (после компакта')
  })

  test('lists the files and links the summary and the point dropped', async ($, on) => {
    const w = world(on)
    await start($)
    await writePoint($, '# Stop point\n- see src/d.ts')
    w.summary = [{ role: 'user', text: 'This session is being continued. We changed b.ts.', toolUses: [] }]
    const before: SessionMessage[] = [
      { role: 'user', text: 'look at https://example.com/spec please', toolUses: [] },
      {
        role: 'assistant',
        text: 'reading',
        toolUses: [
          { tool_use_id: '1', tool: 'Read', input: { file_path: `${ROOT}/src/a.ts` } },
          { tool_use_id: '2', tool: 'Read', input: { file_path: `${ROOT}/src/b.ts` } },
          { tool_use_id: '3', tool: 'Edit', input: { file_path: `${ROOT}/src/c.ts` } },
          { tool_use_id: '4', tool: 'Read', input: { file_path: `${ROOT}/src/d.ts` } },
          { tool_use_id: '5', tool: 'Bash', input: { command: `cat ${ROOT}/docs/x.md | head` } },
          { tool_use_id: '6', tool: 'Read', input: { file_path: '/tmp/scratch.txt' } },
          { tool_use_id: '7', tool: 'Read', input: { file_path: `${ROOT}/shot.png` } },
        ],
      },
    ]
    await compact($, 'manual', before)
    const r = await $.classic.SessionStart({ source: 'compact' })
    const text = (r.additionalContext ?? []).join('\n') + ctx(await read($))
    expect(text).toContain('=== ОПОРЫ, КОТОРЫХ НЕТ В РЕЗЮМЕ')
    expect(text).toContain('- читал: src/a.ts')
    expect(text).toContain('- правил: src/c.ts')
    expect(text).toContain('- читал: docs/x.md')
    expect(text).toContain('- ссылка: https://example.com/spec')
    for (const gone of ['src/b.ts', 'src/d.ts', 'scratch.txt', 'shot.png']) expect(text).not.toContain(`: ${gone}`)
    expect(text.match(/=== ОПОРЫ/g)).toHaveLength(1)
  })

  test('a resumed session gets its point with the freshness check', async ($, on) => {
    const w = world(on)
    w.files.set(POINT, { text: '# Stop point\n- resume me', mtimeMs: START - 30 * 60_000 })
    await start($)
    const r = await $.classic.SessionStart({ source: 'resume' })
    const text = (r.additionalContext ?? []).join('\n')
    expect(text).toContain('=== ТОЧКА ОСТАНОВА ЭТОЙ СЕССИИ (записана')
    expect(text).toContain('30 мин назад')
    expect(text).toContain('resume me')
    expect(w.runs.some(a => a[0] === 'sh')).toBe(true)
  })
})

describe('setup', () => {
  test('no project template or resume folder: points under ~/.claude, the mod\'s own template', async ($, on) => {
    const w = world(on, { projectMode: false })
    await start($)
    w.tokens = 275_000
    const r = await stop($)
    expect(r.block).toContain(`Write ${HOME}/.claude/state/stop-point/points/${SID}.md по формату `)
    expect(r.block).toMatch(/stop-point\/template\.md/)
  })

  test('a project template wins and rides inline', async ($, on) => {
    const w = world(on, { projectMode: false })
    w.files.set(`${ROOT}/.claude/hooks/_lib/stop-point-template.md`, { text: '# Title\n\nPROJECT FORMAT BODY', mtimeMs: START })
    await start($)
    w.tokens = 275_000
    const asked = ctx(await read($))
    expect(asked).toContain(`Write ${POINT}`)
    expect(asked).toContain('PROJECT FORMAT BODY')
    expect(asked).not.toContain('# Title')
  })

  test('prunes points older than a week at session start', async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.runs).toContainEqual(['find', `${ROOT}/.claude/state/resume`, '-name', '*.md', '-type', 'f', '-mtime', '+7', '-delete'])
  })

  test('stands down while the project shell copy is wired', async ($, on) => {
    const hooks = { Stop: [{ hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/stop-point-threshold.sh' }] }] }
    const w = world(on, { settings: { project: { hooks } } })
    await start($)
    w.tokens = 300_000
    expect(ctx(await read($))).toBe('')
    expect((await stop($)).block).toBeUndefined()
    expect((await compact($, 'auto')).skip).toBeUndefined()
    await prompt($, 'точка останова')
    expect(w.prompts.at(-1)?.context).toEqual([])
    expect(w.status).toEqual([])
  })

  test('stands down while the global shell copy is wired, unless the project ships its own', async ($, on) => {
    const hooks = { PreCompact: [{ hooks: [{ type: 'command', command: 'bash /home/u/.claude/hooks/stop-point/gate.sh' }] }] }
    const w = world(on, { settings: { user: { hooks } } })
    await start($)
    w.tokens = 300_000
    expect((await compact($, 'auto')).skip).toBeUndefined()
  })

  test('the global shell copy skips a project with its own, so the mod serves it', async ($, on) => {
    const hooks = { PreCompact: [{ hooks: [{ type: 'command', command: 'bash /home/u/.claude/hooks/stop-point/gate.sh' }] }] }
    const w = world(on, { settings: { user: { hooks } } })
    w.files.set(`${ROOT}/.claude/hooks/session-stop-point.sh`, { text: '#!/bin/bash', mtimeMs: START })
    await start($)
    w.tokens = 300_000
    expect((await compact($, 'auto')).skip).toBeDefined()
  })
})
