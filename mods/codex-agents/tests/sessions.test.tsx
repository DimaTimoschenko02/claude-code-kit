// Each Claude session's pane lists the Codex runs it launched; a resumed thread is followed by its newest turn.
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { CLAUDE_PID, OTHER, PANE, T0, THREAD, WRAP, append, companionJob, cx, line, ownerFile, put, rollout, running02a, start, world } from './world'
import type { World } from './world'

const OPTIONS = { options: { taskDirs: ['~/wrap'] } }
const M = 60_000

async function screen($: Engine): Promise<string[]> {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  return texts
}

const headers = (texts: string[]) => texts.filter(t => /^(● RUNNING|○ STARTING|◌ SILENT|✓ DONE|✖ FAILED)/.test(t) && t.includes(' · '))
const footer = (texts: string[]) => texts.filter(t => t.startsWith('Hidden: '))

/** Filler the pane never reads: a view_image output, ~300 KB, as a real image run writes after each view. */
const blob = (at: number, n: number) => Array.from({ length: n }, (_, i) => line.imageOutput(at + i))

describe('a resumed thread (wrapper `resume`: Codex appends the new turn to the original file)', () => {
  const resumed = '01a1869d-8266-7bd3-af9b-fab247257cb4'
  const review = '01a186c9-9a94-7271-9972-d8fe6813cde7'

  function task04(w: World): string {
    const path = rollout(resumed)
    ownerFile(w, '04')
    ownerFile(w, '04-review')
    put(w, `${WRAP}/codex-04.session`, [resumed])
    put(w, `${WRAP}/codex-04-review.jsonl`, [`{"type":"thread.started","thread_id":"${review}"}`])
    // Turn 1 (an hour ago, 40 min long), its file past two MiB, then the review that started after it.
    put(w, path, [line.meta(resumed, T0 - 40 * M, '/home/fake/proj/shop'), line.started(T0 - 40 * M), line.context(T0 - 40 * M), line.prompt(T0 - 40 * M, '# Задача 04 — правки\n'), ...blob(T0 - 30 * M, 8), line.message(T0 - 5 * M, 'Первый круг закончен'), line.complete(T0, 'П1–П5 готовы.')], T0)
    put(w, rollout(review), [line.meta(review, T0 + 8 * M, '/home/fake/proj/shop'), line.started(T0 + 8 * M), line.prompt(T0 + 8 * M, '# Review brief\n'), line.complete(T0 + 10 * M, '1. Findings\n- три замечания')], T0 + 10 * M)
    return path
  }

  test('the resume is RUNNING on top, timed from its own start; when it ends it is DONE with its own answer', OPTIONS, async ($, on) => {
    const w = world(on)
    const path = task04(w)
    await start($)
    await cx($)
    expect(headers(await screen($))).toEqual(['✓ DONE · 04 review · took 2m', '✓ DONE · 04 · gpt-6.1-sol high · took 40m'])

    // The orchestrator resumes 04 from this session: a new turn lands in the old file.
    await $.tool.call({ tool: 'Bash', command: `${WRAP}/run-codex.sh resume 04 resume-04-1.md`, run_in_background: true })
    const resumeAt = w.clock.now()
    append(w, path, [line.started(resumeAt), line.command(resumeAt + 1_000, 'git diff --stat')])
    await w.clock.advance(3_000)
    let texts = await screen($)
    expect(headers(texts)).toEqual(['● RUNNING · 04 · gpt-6.1-sol high · for 3s', '✓ DONE · 04 review · took 2m'])
    expect(texts.some(t => t.includes('Первый круг'))).toBe(false)

    // It works on: more than two MiB of output after the start, read while it runs.
    append(w, path, [...blob(resumeAt + 2_000, 10), line.message(resumeAt + 9 * M, 'Правлю три замечания ревью')], resumeAt + 9 * M)
    await w.clock.advance(3_000)
    // Its end, alone in the part of the file read now (the start lies blocks behind).
    append(w, path, [line.complete(resumeAt + 12 * M, 'Все три замечания обработаны.')], resumeAt + 12 * M)
    await w.clock.advance(12 * M)
    texts = await screen($)
    expect(headers(texts)).toEqual(['✓ DONE · 04 · gpt-6.1-sol high · took 12m', '✓ DONE · 04 review · took 2m'])
    expect(texts).toContain('result: Все три замечания обработаны.')
  })

  test('a pane opened after the resume finished still times and orders it by the resume', OPTIONS, async ($, on) => {
    const w = world(on)
    const path = task04(w)
    append(w, path, [line.started(T0 + 15 * M), line.message(T0 + 16 * M, 'Правлю'), line.complete(T0 + 20 * M, 'Готово.')], T0 + 20 * M)
    await start($)
    await cx($)
    expect(headers(await screen($))).toEqual(['✓ DONE · 04 · gpt-6.1-sol high · took 5m', '✓ DONE · 04 review · took 2m'])
  })
})

describe("each session's pane lists its own runs", () => {
  test("another session's wrapper run is hidden and counted in the footer; this one's is listed", OPTIONS, async ($, on) => {
    const w = world(on)
    running02a(w)
    const theirs = '01a16dd0-0000-7000-8000-0000000000b1'
    ownerFile(w, '02b', OTHER)
    put(w, `${WRAP}/codex-02b.jsonl`, [`{"type":"thread.started","thread_id":"${theirs}"}`])
    put(w, rollout(theirs), [line.meta(theirs, T0, '/home/fake/proj/shop'), line.started(T0), line.prompt(T0, '# Задача 02b\n')])
    await start($)
    const res = await cx($)
    expect(res.text).toBe('Codex pane opened: 1 running.')
    const texts = await screen($)
    expect(texts[0]).toBe('Codex · 1 running')
    expect(headers(texts).map(h => h.split(' · ')[1])).toEqual(['02a'])
    expect(footer(texts)).toEqual(['Hidden: 1 run not launched from this session (1 running).'])
  })

  test('the codex plugin names the session of each job: ours listed, the other one hidden', OPTIONS, async ($, on) => {
    const w = world(on)
    const ours = '01a16dd0-0000-7000-8000-0000000000c1'
    const theirs = '01a16dd0-0000-7000-8000-0000000000c2'
    for (const t of [ours, theirs]) put(w, rollout(t), [line.meta(t, T0, '/home/fake/wt-121', 'Claude Code'), line.started(T0), line.prompt(T0, `review ${t.slice(-2)}`)])
    companionJob(w, ours)
    companionJob(w, theirs, OTHER)
    await start($)
    await cx($)
    const texts = await screen($)
    expect(headers(texts)).toEqual(['● RUNNING · review c1 · for 23m'])
    expect(footer(texts)).toEqual(['Hidden: 1 run not launched from this session (1 running).'])
  })

  test('a plain codex exec under this Claude process is ours, and stays ours after it exits and the mod reloads', OPTIONS, async ($, on) => {
    const w = world(on)
    const t = '01a16dd0-0000-7000-8000-0000000000d1'
    const path = rollout(t)
    put(w, path, [line.meta(t, T0, '/home/fake/proj/karts'), line.started(T0), line.prompt(T0, '# Pass 3\n')])
    w.procs.push({ pid: 900, ppid: CLAUDE_PID, args: '/bin/zsh -c codex exec "# Pass 3"' }, { pid: 901, ppid: 900, args: 'node /home/fake/bin/codex exec "# Pass 3"' }, { pid: 902, ppid: 901, args: '/home/fake/vendor/codex exec "# Pass 3"', rollout: path })
    await start($)
    await cx($)
    expect(headers(await screen($))).toEqual(['● RUNNING · Pass 3 · for 23m'])
    append(w, path, [line.complete(w.clock.now(), 'Готово.')])
    w.procs = []
    await start($)
    await w.clock.advance(3_000)
    const texts = await screen($)
    expect(headers(texts)).toEqual(['✓ DONE · Pass 3 · took 23m'])
    expect(footer(texts)).toEqual([])
  })

  test("a codex exec not under this Claude (the ChatGPT app's, another session's) is hidden and asked about once", OPTIONS, async ($, on) => {
    const w = world(on)
    running02a(w)
    const t = '01a16dd0-0000-7000-8000-0000000000e9'
    const path = rollout(t)
    put(w, path, [line.meta(t, T0, '/tmp', 'codex_exec'), line.started(T0), line.prompt(T0, 'hello')])
    w.procs.push({ pid: 67336, ppid: 600, args: '/Applications/Fake.app/Contents/MacOS/codex exec --json --ephemeral -', rollout: path })
    await start($)
    await cx($)
    for (let i = 0; i < 3; i++) {
      append(w, path, [line.command(w.clock.now(), 'ls')])
      await w.clock.advance(3_000)
    }
    const texts = await screen($)
    expect(headers(texts).map(h => h.split(' · ')[1])).toEqual(['02a'])
    expect(footer(texts)).toEqual(['Hidden: 1 run not launched from this session (1 running).'])
    expect(w.runs.filter(r => r[0] === 'ps').length).toBe(1)
    expect(w.runs.filter(r => r[0] === 'lsof').length).toBe(1)
  })

  test('with the pane behind another tab, a launch from this session is still followed: the run is ours when the pane comes back', OPTIONS, async ($, on) => {
    const w = world(on)
    await start($)
    await cx($)
    w.shown = false
    await $.tool.call({ tool: 'Bash', command: 'codex exec -m gpt-6.1-sol "# Pass 4"', run_in_background: true })
    const t = '01a16dd0-0000-7000-8000-0000000000f4'
    const path = rollout(t)
    put(w, path, [line.meta(t, w.clock.now(), '/home/fake/proj/karts'), line.started(w.clock.now()), line.prompt(w.clock.now(), '# Pass 4\n')])
    w.procs.push({ pid: 910, ppid: CLAUDE_PID, args: '/bin/zsh -c codex exec "# Pass 4"' }, { pid: 912, ppid: 910, args: '/home/fake/vendor/codex exec -m gpt-6.1-sol "# Pass 4"', rollout: path })
    await w.clock.advance(3_000)
    expect(w.runs.filter(r => r[0] === 'lsof').length).toBe(1)
    // It ends before the owner looks again.
    append(w, path, [line.complete(w.clock.now() + 60_000, 'Готово.')], w.clock.now() + 60_000)
    w.procs = []
    await w.clock.advance(2 * M)
    w.shown = true
    await w.clock.advance(30_000)
    expect(headers(await screen($))).toEqual(['✓ DONE · Pass 4 · took 1m'])
  })

  test('a thread this session ran but another session resumed (its wrapper owner file) belongs to that session', OPTIONS, async ($, on) => {
    const w = world(on)
    running02a(w)
    await start($)
    await cx($)
    expect(headers(await screen($)).map(h => h.split(' · ')[1])).toEqual(['02a'])
    await w.clock.advance(1_000)
    ownerFile(w, '02a', OTHER)
    append(w, rollout(THREAD), [line.command(w.clock.now(), 'ls')])
    await w.clock.advance(3_000)
    const texts = await screen($)
    expect(headers(texts)).toEqual([])
    expect(footer(texts)).toEqual(['Hidden: 1 run not launched from this session (1 running).'])
  })
})
