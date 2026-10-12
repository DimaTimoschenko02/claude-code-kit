import type { ModelCompleteInput, ModelCompleteResult, On, SessionMessage } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import {
  DELTA_CAP,
  OBSERVER_PROMPT,
  errorHit,
  hitsIn,
  count,
  isDuplicate,
  parseReply,
  renderDelta,
  thresholdOf,
  inventoryBlock,
  rulesBlock,
  RULES_CAP,
  INVENTORY_CAP,
  clockTime,
} from '../hooks/logic'

const ROOT = '/home/fake/proj'
const HOME = '/home/fake'
const SID = '11111111-2222-3333-4444-555555555555'
const START = Date.UTC(2026, 9, 12, 9, 0)
const USAGE = { input_tokens: 9000, output_tokens: 400, cache_read_input_tokens: 7000, cache_creation_input_tokens: 0 }
const LOG = `${HOME}/.claude/state/observer/checks.log`
const FINDINGS = `${HOME}/.claude/state/observer/${SID}.md`

type Call = { req: ModelCompleteInput; resolve: (r: ModelCompleteResult) => void }
type World = {
  files: Map<string, string>
  messages: SessionMessage[]
  calls: Call[]
  auto: boolean
  reply: (n: number) => ModelCompleteResult
  prompts: { text: string; context: readonly string[] }[]
  commands: string[]
  clock: MockClock
}

const answered = (text: string): ModelCompleteResult => ({ isAnswered: true, text, usage: USAGE })
const SILENT = 'NOTES:\n- смотрю\nOUT:\n'

/** The second block: notes, facts and the delta (the first is the cached prefix). */
const changing = (c: Call | undefined): string => c?.req.promptBlocks?.[1]?.text ?? ''

function world(on: On, opts: { env?: Record<string, string> } = {}): World {
  const w: World = {
    files: new Map([
      [`${ROOT}/.claude/CLAUDE.md`, '# Project rules\nThinking aloud is not a decision.'],
      [`${HOME}/.claude/CLAUDE.md`, '# Global\nCode and commits in English.'],
    ]),
    messages: [],
    calls: [],
    auto: true,
    reply: () => answered(SILENT),
    prompts: [],
    commands: [],
    clock: mock.clock(on, { now: START }),
  }
  mock.env(on, { HOME, CLAUDE_CODE_PLUGIN_DIRS: '/home/fake/kit/mods/stop-point:/home/fake/kit/mods/observer', ...opts.env })
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: SID }))
  on('session.messages', () => ({ value: [...w.messages] }) as never)
  on('session.usage', () =>
    ({
      value: {
        startedAt: START,
        context: {
          window: 200_000,
          breakdown: { agents: [{ agentType: 'pricehub-reader', source: 'projectSettings', tokens: 10 }], skills: { totalSkills: 1, includedSkills: 1, tokens: 5, skillFrontmatter: [{ name: 'vault-write', source: 'projectSettings', tokens: 5 }] } },
        },
        rateLimits: [],
      },
    }) as never,
  )
  on('command.list', () => ({
    value: [
      { name: 'compact', description: 'Compact', source: 'builtin' as const },
      { name: 'task', description: 'Task-management skill', source: 'user' as const },
      { name: 'stop-point', description: 'Точка останова', source: 'plugin' as const, plugin: 'stop-point' },
    ],
  }))
  on('fs.stat', (_$, e) => {
    const f = w.files.get(e.path)
    if (f === undefined) return { deny: `ENOENT ${e.path}` }
    return { value: { kind: 'file' as const, size: f.length, mtimeMs: START, isLink: false, ...(e.resolve ? { realPath: e.path } : {}) } }
  })
  on('fs.read', (_$, e) => {
    const f = w.files.get(e.path)
    return f === undefined ? { deny: `ENOENT ${e.path}` } : { value: f }
  })
  on('fs.list', (_$, e) => {
    if (e.path === ROOT) return { value: [{ name: 'app', kind: 'dir' as const, size: 0, mtimeMs: START, isLink: false }] }
    if (e.path === `${ROOT}/bin`) return { value: [{ name: 'task-pr', kind: 'file' as const, size: 1, mtimeMs: START, isLink: false }] }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.write', (_$, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('model.complete', (_$, e) =>
    new Promise(resolve => {
      const n = w.calls.length + 1
      const call: Call = { req: e, resolve: r => resolve({ value: r }) }
      w.calls.push(call)
      if (w.auto) call.resolve(w.reply(n))
    }),
  )
  on('command.register', (_$, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.SessionStart', () => ({}))
  on('prompt.submit', (_$, e) => {
    w.prompts.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'beneath' })
  })
  return w
}

const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: ROOT, surface: null, isInteractive })
const ME = { kind: 'composer' } as const
const prompt = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: ME })
const run = ($: Engine, args = '') =>
  $.command.run({ command: 'observer', args, origin: ME, presentation: { isFullscreen: true, columns: 120 } })
let turnNo = 0
const reply = ($: Engine, extra: { agentId?: string; isAborted?: boolean } = {}) =>
  $.turn.complete({
    answer: 'готово',
    durationMs: 1000,
    isAborted: extra.isAborted === true,
    turnId: `t${++turnNo}`,
    reason: extra.isAborted === true ? 'aborted' : 'answer',
    ...(extra.agentId === undefined ? {} : { agentId: extra.agentId }),
  })

const ABOVE_PROMPT = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }

const owner = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const said = (text: string, ...uses: { id: string; tool: string; input: Record<string, unknown>; out?: string; err?: boolean }[]): SessionMessage => ({
  role: 'assistant',
  text,
  toolUses: uses.map(u => ({ tool_use_id: u.id, tool: u.tool, input: u.input, text: u.out ?? 'ok', ...(u.err === true ? { isError: true as const } : {}) })),
})
let idNo = 0
const bash = (command: string, out = 'ok', err = false) => ({ id: `tu${++idNo}`, tool: 'Bash', input: { command }, out, err })
const SKILL_GATE = (path: string, skill: string) =>
  `PreToolUse:Edit hook error: [$CLAUDE_PROJECT_DIR/.claude/hooks/skill-gate-guard.sh]: 🚧 skill-gate: "${path}" belongs to skill ${skill}, not loaded since the last context reset`

/** A long reply with the risk at its end: the replay's one false alarm came from a reply cut at 900 chars. */
const LONG_REPLY = `${'Сделал миграцию, тесты зелёные, PR открыт. '.repeat(60)}И да: на проде выполнил revoke connect on database pricehub from public.`

describe('a check after every main reply', () => {
  test('a reply runs one background Sonnet check: the cached prefix holds prompt, rules, inventory; the rest holds the delta with the whole reply', async ($, on) => {
    const w = world(on)
    await start($)
    w.messages = [owner('сделай миграцию и выложи на стенд'), said(LONG_REPLY, bash('pnpm test'))]
    await reply($)
    await w.clock.settle()
    expect(w.calls).toHaveLength(1)
    const req = w.calls[0]?.req
    expect(req?.model).toBe('sonnet')
    const blocks = req?.promptBlocks
    if (blocks === undefined) throw new Error('prompt must be blocks')
    expect(blocks[0]?.cache).toBe(true)
    expect(blocks[0]?.text.startsWith(OBSERVER_PROMPT)).toBe(true)
    expect(blocks[0]?.text).toContain('Thinking aloud is not a decision.')
    expect(blocks[0]?.text).toContain('Code and commits in English.')
    expect(blocks[0]?.text).toContain('/task — Task-management skill')
    expect(blocks[0]?.text).not.toContain('/compact')
    expect(blocks[0]?.text).toContain('pricehub-reader')
    expect(blocks[0]?.text).toContain('observer, stop-point')
    expect(blocks[0]?.text).toContain('bin/task-pr')
    expect(blocks[1]?.cache).toBeUndefined()
    const delta = blocks[1]?.text ?? ''
    expect(delta).toContain('[Dima] сделай миграцию и выложи на стенд')
    expect(delta).toContain('revoke connect on database pricehub from public.')
    expect(delta).toContain(LONG_REPLY)
    expect(delta).toContain('→ Bash: pnpm test')
    expect(delta).not.toContain('← ') // a result that did not fail is not sent
    expect(w.files.get(LOG)).toMatch(/11111111 checked \d+\.\ds msgs=2 chars=\d+ facts=0 know=0 repeat=0 in=9000 out=400 cache_read=7000 cache_write=0\n$/)
  })

  test('the prefix is the same on the next check (so the cache serves it); the next delta is only what came after', async ($, on) => {
    const w = world(on)
    await start($)
    w.messages = [owner('первый вопрос'), said('первый ответ')]
    await reply($)
    await w.clock.settle()
    w.reply = () => answered('NOTES:\n- владелец спросил про первый вопрос\nOUT:\n')
    w.messages.push(owner('второй вопрос'), said('второй ответ'))
    await reply($)
    await w.clock.settle()
    const [a, b] = [w.calls[0]?.req.promptBlocks, w.calls[1]?.req.promptBlocks]
    if (a === undefined || b === undefined) throw new Error('blocks')
    expect(b[0]?.text).toBe(a[0]?.text)
    expect(changing(w.calls[1])).toContain('[Dima] второй вопрос')
    expect(changing(w.calls[1])).not.toContain('первый вопрос')
    expect(changing(w.calls[1])).toContain('- смотрю') // the first check's notes come back
  })

  test('a subagent\'s turn and an aborted turn check nothing', async ($, on) => {
    const w = world(on)
    await start($)
    w.messages = [owner('x'), said('y')]
    await reply($, { agentId: 'a1' })
    await reply($, { isAborted: true })
    await w.clock.settle()
    expect(w.calls).toHaveLength(0)
  })

  test('single flight: replies during a check queue exactly one more', async ($, on) => {
    const w = world(on)
    await start($)
    w.auto = false
    w.messages = [owner('раз'), said('один')]
    await reply($)
    await w.clock.settle()
    w.messages.push(owner('два'), said('два'))
    await reply($)
    w.messages.push(owner('три'), said('три'))
    await reply($)
    await w.clock.settle()
    expect(w.calls).toHaveLength(1)
    w.calls[0]?.resolve(answered(SILENT))
    await w.clock.settle()
    expect(w.calls).toHaveLength(2)
    expect(changing(w.calls[1])).toContain('[Dima] два')
    expect(changing(w.calls[1])).toContain('[Dima] три')
    w.calls[1]?.resolve(answered(SILENT))
    await w.clock.settle()
    expect(w.calls).toHaveLength(2)
  })

  test('a failed call keeps the cursor: the next check sends the same delta again', async ($, on) => {
    const w = world(on)
    await start($)
    w.reply = () => ({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: { ...USAGE, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } }) as never
    w.messages = [owner('потерянный вопрос'), said('ответ')]
    await reply($)
    await w.clock.settle()
    expect(w.files.get(LOG)).toContain('error(API 529 overloaded)')
    w.reply = () => answered(SILENT)
    w.messages.push(owner('следующий'))
    await reply($)
    await w.clock.settle()
    expect(changing(w.calls[1])).toContain('потерянный вопрос')
  })

  test('a headless run (claude -p) checks nothing unless CLAUDE_OBSERVER_HEADLESS=1', async ($, on) => {
    const w = world(on)
    await start($, false)
    w.messages = [owner('x'), said('y')]
    await reply($)
    await w.clock.settle()
    expect(w.calls).toHaveLength(0)
    expect((await run($)).text).toContain('неинтерактивная')
  })

  test('opted in, a headless run checks', async ($, on) => {
    const w = world(on, { env: { CLAUDE_OBSERVER_HEADLESS: '1' } })
    await start($, false)
    w.messages = [owner('x'), said('y')]
    await reply($)
    await w.clock.settle()
    expect(w.calls).toHaveLength(1)
  })
})

describe('counting by code', () => {
  test('the same Bash command a third time reaches the observer as a FACT once, then again at six', async ($, on) => {
    const w = world(on)
    await start($)
    const cmd = 'gh pr checks 141   --watch'
    const facts: string[] = []
    for (let i = 1; i <= 7; i++) {
      w.messages.push(owner(`проверь CI ${i}`), said('жду', bash(i % 2 === 0 ? cmd.replace(/ +/g, ' ') : cmd)))
      await reply($)
      await w.clock.settle()
      await w.clock.advance(60_000)
      facts.push(changing(w.calls.at(-1)).match(/FACT: .*/)?.[0] ?? '')
    }
    expect(facts.map(f => f !== '')).toEqual([false, false, true, false, false, true, false])
    expect(facts[2]).toContain(`одна и та же команда Bash: «gh pr checks 141 --watch» × 3 (${clockTime(START)} … ${clockTime(START + 120_000)})`)
    expect(facts[5]).toContain('× 6')
  })

  test('skill-gate blocks group by the hook whatever file or skill they name; a lost cursor never counts a call twice', async ($, on) => {
    const w = world(on)
    await start($)
    const edit = (path: string, skill: string) => ({ id: `tu${++idNo}`, tool: 'Edit', input: { file_path: path }, out: SKILL_GATE(path, skill), err: true })
    w.messages = [owner('правь'), said('правлю', edit('brain/debt.md', 'vault-write'), edit('pricehub/apps/x.ts', 'code-style'))]
    await reply($)
    await w.clock.settle()
    // the message the cursor names changed after the check (its text grew): the cursor is lost and the old calls
    // come again beside one new block
    const old = w.messages[1] as SessionMessage
    w.messages = [w.messages[0] as SessionMessage, { ...old, text: `${old.text}, дополнено` }, said('ещё', edit('brain/plan.md', 'vault-write'))]
    await reply($)
    await w.clock.settle()
    expect(changing(w.calls[1])).toContain('FACT: хук skill-gate-guard.sh (PreToolUse) заблокировал вызов')
    expect(changing(w.calls[1])).toContain('× 3')
    expect(changing(w.calls[1])).toContain('← error: PreToolUse:Edit hook error')
  })

  test('an API error from sleep counts by kind', () => {
    const msgs: SessionMessage[] = [1, 2, 3].map(() => said('API Error: Your computer went to sleep mid-response. The response above may be incomplete.'))
    const r = count({}, [], hitsIn(msgs), START)
    expect(r.facts).toHaveLength(1)
    expect(r.facts[0]?.c.label).toBe('ошибка API: «Your computer went to sleep mid-response.»')
  })

  test('real denial texts group by their reason, ordinary command failures are not counted', () => {
    expect(errorHit('Bash', 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Permission Grant]. If you…')?.key).toBe('classifier:Permission Grant')
    expect(errorHit('Bash', 'PreToolUse:Bash hook error: secrets-redact mod is not running in this session (no heartbeat for d652ec52-8ca2-…)')?.key).toBe(
      errorHit('Read', 'PreToolUse:Read hook error: secrets-redact mod is not running in this session (no heartbeat for 0a1b2c3d-…)')?.key.replace(':Read', ':Bash'),
    )
    expect(errorHit('Write', '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>')?.key).toMatch(/^toolerr:Write:File has not been read yet\. Read it first/)
    expect(errorHit('Edit', "The user doesn't want to proceed with this tool use. The tool use was rejected")?.key).toBe('denied:owner')
    expect(errorHit('Bash', 'Exit code 1 ls: fa-top.jpg: No such file or directory')).toBeNull()
  })

  test('thresholds are 3, 6, 12, 24', () => {
    expect([1, 2, 3, 5, 6, 11, 12, 23, 24, 30].map(n => thresholdOf(n))).toEqual([0, 0, 3, 3, 6, 6, 12, 12, 24, 24])
  })
})

describe('what the observer says and where it goes', () => {
  test('KNOW goes to the band above the prompt and to the findings file; «скрыть» takes it down', async ($, on) => {
    const w = world(on)
    await start($)
    w.reply = () => answered('NOTES:\n- сказал про revoke\nOUT:\nKNOW: На проде выполнен revoke connect — ты разрешал только dev-БД; проверь бэкап.')
    w.messages = [owner('настрой dev-базу'), said(LONG_REPLY)]
    await reply($)
    await w.clock.settle()
    const ui = await $.ui.mount({ plugin: 'observer', surface: 'terminal', component: 'AbovePrompt', props: ABOVE_PROMPT })
    expect((await ui.find({ type: 'Text', text: /знай/ }))?.text).toContain('На проде выполнен revoke connect')
    expect(await ui.find({ type: 'Text', text: 'beneath' })).toBeDefined() // another mod's band stays
    expect(w.files.get(FINDINGS)).toMatch(/KNOW: На проде выполнен revoke connect/)
    await ui.press({ key: 'observer-hide' })
    expect(await ui.find({ type: 'Text', text: /знай/ })).toBeUndefined()
    await ui.unmount()
    expect(w.prompts).toHaveLength(0)
  })

  test('the band goes by itself after two of the owner\'s prompts', async ($, on) => {
    const w = world(on)
    await start($)
    w.reply = () => answered('NOTES:\n- n\nOUT:\nKNOW: Вопрос про «Прив’язати N» висит в трёх ответах без реакции.')
    w.messages = [owner('a'), said('b')]
    await reply($)
    await w.clock.settle()
    await prompt($, 'раз')
    const ui = await $.ui.mount({ plugin: 'observer', surface: 'terminal', component: 'AbovePrompt', props: ABOVE_PROMPT })
    expect(await ui.find({ type: 'Text', text: /знай/ })).toBeDefined()
    await prompt($, 'два')
    expect(await ui.find({ type: 'Text', text: /знай/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a REPEAT without a counted fact stays in the file and reaches the main model once, never the band', async ($, on) => {
    const w = world(on)
    await start($)
    w.reply = () => answered('NOTES:\n- n\nOUT:\nREPEAT: [repeat] 18:54 «diff board snapshot» → hook: сверять доску со снимком кодом на каждый промпт, холодный путь.')
    w.messages = [owner('a'), said('b')]
    await reply($)
    await w.clock.settle()
    const ui = await $.ui.mount({ plugin: 'observer', surface: 'terminal', component: 'AbovePrompt', props: ABOVE_PROMPT })
    expect(await ui.find({ type: 'Text', text: /повтор/ })).toBeUndefined()
    await ui.unmount()
    expect(w.files.get(FINDINGS)).toContain('REPEAT: [repeat] 18:54')
    await prompt($, 'дальше')
    await prompt($, 'ещё')
    expect(w.prompts[0]?.context.join('\n')).toContain('мод observer')
    expect(w.prompts[0]?.context.join('\n')).toContain('[repeat] 18:54 «diff board snapshot»')
    expect(w.prompts[1]?.context).toEqual([])
  })

  test('a REPEAT on a counted fact reaches the band', async ($, on) => {
    const w = world(on)
    await start($)
    w.messages = [owner('a'), said('b', bash('sleep 15; gh pr checks 1'), bash('sleep 15; gh pr checks 1'), bash('sleep 15; gh pr checks 1'))]
    w.reply = () => answered('NOTES:\n- n\nOUT:\nREPEAT: [waste] FACT «sleep 15; gh pr checks» × 3 → mod: ждать CI таймером и сказать в строке статуса, без опроса.')
    await reply($)
    await w.clock.settle()
    expect(changing(w.calls[0])).toContain('FACT: одна и та же команда Bash')
    const ui = await $.ui.mount({ plugin: 'observer', surface: 'terminal', component: 'AbovePrompt', props: ABOVE_PROMPT })
    expect((await ui.find({ type: 'Text', text: /повтор/ }))?.text).toContain('ждать CI таймером')
    await ui.unmount()
  })

  test('a reply off the format shows nothing and is logged; the notes it carried are kept', async ($, on) => {
    const w = world(on)
    await start($)
    w.reply = () => answered('NOTES:\n- заметка\nOUT:\nВсё хорошо, ничего не нашёл.\nKNOW: что-то')
    w.messages = [owner('a'), said('b')]
    await reply($)
    await w.clock.settle()
    expect(w.files.get(FINDINGS)).toBeUndefined()
    expect(w.files.get(LOG)).toContain('bad(bad OUT line «Всё хорошо, ничего не нашёл.»)')
    expect((await run($)).text).toContain('ответ не по формату')
    w.messages.push(owner('c'))
    await reply($)
    await w.clock.settle()
    expect(changing(w.calls[1])).toContain('- заметка')
  })

  test('the same finding reworded is not shown twice', async ($, on) => {
    const w = world(on)
    await start($)
    const answers = [
      'KNOW: Шаг 3 уже в main, а ты просил потихоньку и ещё читаешь шаг 1.',
      'KNOW: Ты ещё читаешь шаг 1, а шаг 3 уже в main — ты просил потихоньку.',
    ]
    w.reply = n => answered(`NOTES:\n- n\nOUT:\n${answers[n - 1] ?? ''}`)
    for (const t of ['a', 'b']) {
      w.messages.push(owner(t), said(t))
      await reply($)
      await w.clock.settle()
    }
    expect((w.files.get(FINDINGS) ?? '').match(/KNOW/g)).toHaveLength(1)
    expect(w.files.get(LOG)).toContain('dup_know')
  })
})

describe('/observer', () => {
  test('shows the last findings, counters over the threshold and the cost; off stops the checks, on brings them back', async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.commands).toContain('observer')
    w.reply = () => answered('NOTES:\n- n\nOUT:\nKNOW: Ответ «ноут ни при чём», но прошлый ход оборвался на sleep mid-response.')
    w.messages = [owner('a'), said('b', bash('git status'), bash('git status'), bash('git status'))]
    await reply($)
    await w.clock.settle()
    const text = (await run($)).text
    expect(text).toContain('включён')
    expect(text).toContain('KNOW: Ответ «ноут ни при чём»')
    expect(text).toContain('одна и та же команда Bash: «git status» × 3')
    expect(text).toContain('вход 9000 токенов (из кэша 7000, в кэш 0), выход 400')
    expect(text).toContain(LOG)
    expect((await run($, 'off')).text).toContain('выключен')
    w.messages.push(owner('c'), said('d'))
    await reply($)
    await w.clock.settle()
    expect(w.calls).toHaveLength(1)
    await run($, 'on')
    w.messages.push(owner('e'))
    await reply($)
    await w.clock.settle()
    expect(w.calls).toHaveLength(2)
  })
})

describe('pure parts', () => {
  test('parseReply: strict NOTES/OUT, one line per job, fences tolerated', () => {
    expect(parseReply('NOTES:\n- a\nOUT:\n')).toMatchObject({ ok: true, notes: '- a', know: null, repeat: null })
    expect(parseReply('```\nNOTES:\n- a\nOUT:\nKNOW: x y\n```')).toMatchObject({ ok: true, know: 'x y' })
    expect(parseReply('NOTES:\n- a\nOUT:\nKNOW: one\nKNOW: two')).toMatchObject({ ok: true, know: 'one', bad: 'second KNOW dropped' })
    expect(parseReply('NONE')).toMatchObject({ ok: false, notes: null })
    expect(parseReply('NOTES:\n- a\nOUT:\nREPEAT: [nonsense] x → y: z')).toMatchObject({ ok: false, know: null })
    const many = Array.from({ length: 45 }, (_, i) => `- n${i}`).join('\n')
    expect(parseReply(`NOTES:\n${many}\nOUT:\n`)).toMatchObject({ notesCut: 5 })
  })

  test('renderDelta: over the cap, plain calls go first and the last reply stays whole', () => {
    const msgs: SessionMessage[] = []
    for (let i = 0; i < 400; i++) msgs.push(said('', bash(`cat file-${i}.ts ${'x'.repeat(150)}`)))
    msgs.push(said(`older ${'o'.repeat(60_000)}`), owner('вопрос владельца'), said(`last ${'l'.repeat(50_000)}`))
    const r = renderDelta(msgs)
    expect(r.text.length).toBeLessThanOrEqual(DELTA_CAP + 200)
    expect(r.text).toContain(`last ${'l'.repeat(50_000)}`)
    expect(r.text).toContain('[Dima] вопрос владельца')
    expect(r.text).toMatch(/^…\[\d+ older entries left out\]/)
  })

  test('isDuplicate is about the words, not the order', () => {
    const before = [{ at: 0, kind: 'KNOW' as const, text: 'Шаг 3 уже в main, а ты просил потихоньку.', fact: false }]
    expect(isDuplicate('Ты просил потихоньку, а шаг 3 уже в main.', before)).toBe(true)
    expect(isDuplicate('Миграция сбрасывает кэш после каждой записи.', before)).toBe(false)
  })

  test('rules and inventory are bounded and stable', () => {
    const big = rulesBlock([{ path: '/a', text: 'x'.repeat(50_000) }, { path: '/b', text: 'y'.repeat(50_000) }])
    expect(big.length).toBeLessThanOrEqual(RULES_CAP + 200)
    const inv = { commands: [{ name: 'b', description: 'B', source: 'user' }, { name: 'a', description: 'A', source: 'user' }], agents: ['z', 'y'], skills: [], mods: ['m'], scripts: [] }
    expect(inventoryBlock(inv)).toBe(inventoryBlock({ ...inv, commands: [...inv.commands].reverse(), agents: ['y', 'z'] }))
    const many = Array.from({ length: 300 }, (_, i) => ({ name: `zz-plugin-${i}`, description: 'd'.repeat(80), source: 'plugin' }))
    const cut = inventoryBlock({ ...inv, commands: [...many, { name: 'task', description: 'ours', source: 'user' }], scripts: ['bin/task-pr'] })
    expect(cut.length).toBeLessThanOrEqual(INVENTORY_CAP + 60)
    expect(cut).toContain('bin/task-pr')
    expect(cut).toContain('/task — ours')
    expect(cut).toMatch(/…\[\d+ more commands left out\]$/)
  })
})
