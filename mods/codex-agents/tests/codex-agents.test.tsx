import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DAY, HOME, PANE, T0, THREAD, WRAP, append, cx, line, put, rollout, running02a, start, world } from './world'
import type { World } from './world'

const OPTIONS = { options: { taskDirs: ['~/wrap'] } }
const SURFACES = ['terminal', 'desktop'] as const

/** Every text the pane draws, one string per Text element (outermost first, so a row's whole line is there). */
async function screen($: Engine, surface: (typeof SURFACES)[number] = 'terminal'): Promise<string[]> {
  const ui = await $.ui.mount({ ...PANE, surface })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  return texts
}

const has = (texts: string[], re: RegExp) => texts.some(t => re.test(t))

const HEADERS = /^(● RUNNING|○ STARTING|◌ SILENT|✓ DONE|✖ FAILED)/
/** Each block's whole header line (its status run alone is a nested Text of its own). */
const headers = (texts: string[]) => texts.filter(t => HEADERS.test(t) && t.includes(' · '))

/** A run that started at `at` and finished a minute later (or failed with `error`). */
function finished(w: World, thread: string, at: number, prompt: string, error?: string): void {
  put(w, rollout(thread), [line.meta(thread, at, '/home/fake/proj/shop'), line.started(at), line.prompt(at, prompt), line.complete(at + 60_000, error === undefined ? 'Done.' : null, error)], at + 60_000)
}

describe('the running run', () => {
  test('/cx opens the pane: counts, freshness, limits with their time, and the run as one block with a status word', OPTIONS, async ($, on) => {
    const w = world(on)
    running02a(w)
    await start($)
    const res = await cx($)
    expect(res.text).toBe('Codex pane opened: 1 running.')
    expect(w.opened).toEqual(['codex'])
    for (const surface of SURFACES) {
      const texts = await screen($, surface)
      expect(texts.slice(0, 3)).toEqual([
        'Codex · 1 running',
        'Updated 14:19:36 (just now) · refreshes every 3s while a run is live',
        'Limits as of 13:57 · prolite · week 7% used, resets Sat 31.10 14:43',
      ])
      expect(has(texts, /^● RUNNING · 02a · gpt-6\.1-sol high · for 23m$/)).toBe(true)
      expect(has(texts, /^task: Задача 02a — платформа Nest$/)).toBe(true)
      expect(has(texts, /^doing: Сначала проверю рабочую копию · 22m ago$/)).toBe(true)
      expect(has(texts, /^now: pnpm vitest run · 1m ago$/)).toBe(true)
      expect(has(texts, /^repo shop · 5\.9M tokens · started 13:56$/)).toBe(true)
    }
  })

  test('every run is its own bordered block, coloured by its status', OPTIONS, async ($, on) => {
    const w = world(on)
    running02a(w)
    finished(w, '01a16dd0-0000-7000-8000-0000000000f1', T0 - 10 * 60_000, 'Reply with OK', 'usage_limit_exceeded')
    await start($)
    await cx($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const boxes = (await ui.findAll({ type: 'Box' })).filter(b => b.props.borderStyle === 'round')
    expect(boxes.map(b => b.props.borderColor)).toEqual(['success', 'error'])
    expect(boxes.map(b => b.text.split('·')[0]?.trim())).toEqual(['● RUNNING', '✖ FAILED (usage limit reached)'])
    await ui.unmount()
  })

  test('the pane follows the run by itself every few seconds while it works', OPTIONS, async ($, on) => {
    const w = world(on)
    const path = running02a(w)
    await start($)
    await cx($)
    await w.clock.advance(60_000)
    append(w, path, [line.message(w.clock.now(), 'Тесты зелёные, проверяю гейты\nвторая строка не нужна')])
    await w.clock.advance(3_000)
    const texts = await screen($)
    expect(has(texts, /^doing: Тесты зелёные, проверяю гейты$/)).toBe(true)
    expect(has(texts, /^● RUNNING · 02a · gpt-6\.1-sol high · for 24m$/)).toBe(true)
    expect(has(texts, /^Updated 14:20:39 \(just now\)/)).toBe(true)
    expect(has(texts, /вторая строка/)).toBe(false)
  })

  test('a run that views images (big base64 outputs after each view) shows what it views, never «thinking»', OPTIONS, async ($, on) => {
    const w = world(on)
    const path = running02a(w)
    const reasoning = (at: number) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'gA'.repeat(15_000) } })
    const at = T0 + 22 * 60_000
    // More views than the read keeps lines: the turn's start lies far behind them, and the run still reads RUNNING.
    const views = Array.from({ length: 40 }, (_, i) => line.image(at - 40 + i, `/tmp/bake/p2/shots/A0${i % 7}/grid_0${i % 4}.jpg`))
    append(w, path, [...views, line.image(at + 1, '/tmp/bake/p2/shots/A07/grid_01.jpg'), line.imageOutput(at + 2), reasoning(at + 3), line.imageOutput(at + 4), reasoning(at + 5)])
    await start($)
    await cx($)
    const texts = await screen($)
    expect(has(texts, /^● RUNNING · 02a · /)).toBe(true)
    expect(texts[2]).toBe('Limits as of 13:57 · prolite · week 7% used, resets Sat 31.10 14:43')
    expect(has(texts, /^doing: Сначала проверю рабочую копию · 22m ago$/)).toBe(true)
    expect(has(texts, /^now: viewing A07\/grid_01\.jpg · 1m ago$/)).toBe(true)
    expect(has(texts, /thinking/)).toBe(false)
  })

  test('an unfinished run silent past staleMinutes reads SILENT with how long, not RUNNING', OPTIONS, async ($, on) => {
    const w = world(on)
    running02a(w)
    await start($)
    await cx($)
    await w.clock.advance(11 * 60_000)
    const texts = await screen($)
    expect(has(texts, /^◌ SILENT 1\dm · 02a · gpt-6\.1-sol high · for 3\dm$/)).toBe(true)
    expect(texts[0]).toBe('Codex · 1 silent')
    expect(has(texts, /RUNNING/)).toBe(false)
  })

  test('a review run is labelled by the review file, a resumed task by its .session file', OPTIONS, async ($, on) => {
    const w = world(on)
    const review = '01a16dd0-0000-7000-8000-000000000001'
    const resumed = '01a16dd0-0000-7000-8000-000000000002'
    put(w, `${WRAP}/codex-02a-review.jsonl`, [`{"type":"thread.started","thread_id":"${review}"}`])
    put(w, `${WRAP}/codex-01.session`, [resumed])
    for (const t of [review, resumed]) put(w, rollout(t), [line.meta(t, T0, '/home/fake/proj/shop'), line.started(T0), line.prompt(T0, '# Review brief\n')])
    await start($)
    await cx($)
    const texts = await screen($)
    expect(has(texts, /^● RUNNING · 02a review · for 23m$/)).toBe(true)
    expect(has(texts, /^● RUNNING · 01 · for 23m$/)).toBe(true)
  })

  test('a rerun of the same task id is labelled by it, though its event log only grew', OPTIONS, async ($, on) => {
    const w = world(on)
    running02a(w)
    await start($)
    await cx($)
    const rerun = '01a16dd0-0000-7000-8000-00000000000a'
    await w.clock.advance(3_000)
    put(w, `${WRAP}/codex-02a.jsonl`, [`{"type":"thread.started","thread_id":"${rerun}"}`, '{"type":"turn.started"}', '{"type":"item.completed","item":{"id":"item_0"}}'])
    put(w, rollout(rerun), [line.meta(rerun, w.clock.now(), '/home/fake/proj/shop'), line.started(w.clock.now()), line.prompt(w.clock.now(), 'Другой промпт\n')])
    await w.clock.advance(3_000)
    const texts = await screen($)
    expect(texts.filter(t => /^● RUNNING · 02a · /.test(t)).length).toBe(1)
    expect(has(texts, /^● RUNNING · Задача 02a — платформа Nest · /)).toBe(true)
  })
})

describe("the owner's codex exec batch: three runs of one brief", () => {
  const T = '/home/fake/jobs/9d/tmp/bakeoff'
  const exec = (n: string, brief: string) => `/home/fake/.nvm/bin/codex exec -m gpt-6.1-sol -c model_reasoning_effort=high -s workspace-write --add-dir ${T} -C /home/fake/proj/karts -o ${T}/out/p2_${n}.last.txt ${brief}`
  const threads = { shots: '01a18688-7041-7e33-aae1-e4a37cff3849', scan1: '01a18688-7125-73d0-8c3a-1f95afcf5c7c', scan2: '01a18688-722f-7980-aa00-705300e600b2' }
  const brief = { shots: '# Pass 2a: where the gun points while the kart is airborne (original SmashKarts)', scan: '# Pass 2b: a complete list of vertical events, small bumps, wall hits and turns (original SmashKarts)' }

  function batch(w: World): void {
    for (const [n, thread] of Object.entries(threads)) {
      const path = rollout(thread)
      const heading = n === 'shots' ? brief.shots : brief.scan
      put(w, path, [
        line.meta(thread, T0, '/home/fake/proj/karts'),
        line.started(T0),
        line.context(T0),
        line.prompt(T0, `${heading}\n\n## Context\nlong brief`),
        line.message(T0 + 60_000, '- Разберу очереди по кадрам: отдельно отмечу отрыв, наклон корпуса и направление трассеров. Репозиторий не трогаю.'),
        line.parsed(T0 + 22 * 60_000, "nl -ba .claude/memory/camera-feel/reference-videos.md | sed -n '65,84p'", [{ type: 'read', cmd: 'nl -ba …', name: 'reference-videos.md', path: '.claude/memory/camera-feel/reference-videos.md' }]),
        line.command(T0 + 22 * 60_000 + 30_000, "LC_ALL=C python3 - <<'PY'\nfrom pathlib import Path\nprint(1)\nPY"),
        line.tokens(T0 + 22 * 60_000 + 31_000, 3_100_000),
      ])
      // The node launcher and the native binary carry the same arguments; only the binary holds the rollout open.
      w.procs.push({ pid: 1000 + w.procs.length, args: `node ${exec(n, heading)}` })
      w.procs.push({ pid: 1000 + w.procs.length, args: exec(n, heading), rollout: path })
    }
  }

  test('each run is named by its -o file, carries model and effort, the brief heading as task, the agent words as doing', OPTIONS, async ($, on) => {
    const w = world(on)
    batch(w)
    await start($)
    await cx($)
    const texts = await screen($)
    expect(headers(texts).sort()).toEqual(['● RUNNING · p2_scan1 · gpt-6.1-sol high · for 23m', '● RUNNING · p2_scan2 · gpt-6.1-sol high · for 23m', '● RUNNING · p2_shots · gpt-6.1-sol high · for 23m'])
    expect(texts.filter(t => t === 'task: Pass 2b: a complete list of vertical events, small bumps, wall hits and turns…').length).toBe(2)
    expect(has(texts, /^doing: Разберу очереди по кадрам: отдельно отмечу отрыв, наклон корпуса и направление трассеров\. · 22m ago$/)).toBe(true)
    expect(has(texts, /^now: running a Python script · 30s ago$/)).toBe(true)
    // No code on screen: neither the command nor the script.
    expect(has(texts, /nl -ba|sed -n|pathlib|PY/)).toBe(false)
    // lsof is asked for the native binaries alone, once.
    const lsofs = w.runs.filter(r => r[0] === 'lsof')
    expect(lsofs.length).toBe(1)
    expect(lsofs[0]?.[2]?.split(',').map(Number).sort()).toEqual([1001, 1003, 1005])
  })

  test('the names outlive the processes and a reload of the mod', OPTIONS, async ($, on) => {
    const w = world(on)
    batch(w)
    await start($)
    await cx($)
    const path = rollout(threads.shots)
    append(w, path, [line.complete(w.clock.now(), '## Итог\nОчереди в воздухе: 7 из 9, нос по траектории не клюёт.')])
    w.procs = []
    await w.clock.advance(3_000)
    await start($)
    await w.clock.advance(3_000)
    const texts = await screen($)
    expect(has(texts, /^✓ DONE · p2_shots · gpt-6\.1-sol high · took 23m$/)).toBe(true)
    expect(has(texts, /^result: Итог — Очереди в воздухе: 7 из 9, нос по траектории не клюёт\.$/)).toBe(true)
    expect(has(texts, /^task: Pass 2a: where the gun points while the kart is airborne \(original SmashKarts\)$/)).toBe(true)
  })

  test('a run with no -o file and no wrapper is named by its brief heading, and no lsof is asked', OPTIONS, async ($, on) => {
    const w = world(on)
    put(w, `${DAY}/rollout-2026-10-24T13-56-36-${threads.shots}.jsonl`, [line.meta(threads.shots, T0, '/home/fake/proj/karts'), line.started(T0), line.context(T0, 'gpt-6.1-sol', 'medium'), line.prompt(T0, `${brief.shots}\n`)])
    w.procs.push({ pid: 7, args: `/home/fake/bin/codex exec -m gpt-6.1-sol "${brief.shots}"`, rollout: rollout(threads.shots) })
    await start($)
    await cx($)
    const texts = await screen($)
    expect(has(texts, /^● RUNNING · Pass 2a: where the gun points while the kart is airborne… · gpt-6\.1-sol medium · for 23m$/)).toBe(true)
    expect(has(texts, /^task: /)).toBe(false)
    expect(w.runs.some(r => r[0] === 'lsof')).toBe(false)
  })
})

describe('finished runs: the last ones only', () => {
  test('finished and failed runs: status and reason in the header, the answer as result, origin and end in the meta', OPTIONS, async ($, on) => {
    const w = world(on)
    const done = '01a16b06-66b8-7d00-abb7-43e429b6ee11'
    const failed = '01a16b0a-7783-7061-9aa1-139d68f33b93'
    put(w, rollout(done), [
      line.meta(done, T0, '/home/fake/wt-121', 'Claude Code'),
      line.started(T0),
      line.prompt(T0, 'You are the reviewer.\nmore'),
      line.tokens(T0 + 60_000, 1_816_357),
      line.complete(T0 + 125_000, 'db: нужен ревьюер БД\n\n1. детали'),
    ], T0 + 125_000)
    put(w, rollout(failed), [line.meta(failed, T0, '/tmp'), line.started(T0), line.prompt(T0, 'Reply with OK'), line.complete(T0 + 2_000, null, 'usage_limit_exceeded')], T0 + 2_000)
    await start($)
    await cx($)
    const texts = await screen($)
    expect(texts[0]).toBe('Codex · nothing running · 2 finished')
    expect(has(texts, /^No Codex run is working right now\.$/)).toBe(true)
    expect(has(texts, /^Updated 14:19:36 \(just now\) · idle, refreshes every 30s$/)).toBe(true)
    expect(has(texts, /^✓ DONE · You are the reviewer\. · took 2m$/)).toBe(true)
    expect(has(texts, /^task: /)).toBe(false)
    expect(has(texts, /^result: db: нужен ревьюер БД$/)).toBe(true)
    expect(has(texts, /^repo wt-121 · via Claude Code · 1\.8M tokens · started 13:56 · finished 13:58$/)).toBe(true)
    expect(has(texts, /^✖ FAILED \(usage limit reached\) · Reply with OK · took 2s$/)).toBe(true)
    expect(has(texts, /example\.com/)).toBe(false)
  })

  test("the owner's rule: earlier failures and finished runs are gone once two newer runs started; the latest finished stays", OPTIONS, async ($, on) => {
    const w = world(on)
    finished(w, '01a16dd0-0000-7000-8000-0000000000e0', T0 - 3 * 3_600_000, 'morning probe', 'usage_limit_exceeded')
    finished(w, '01a16dd0-0000-7000-8000-0000000000e1', T0 - 60 * 60_000, 'first')
    finished(w, '01a16dd0-0000-7000-8000-0000000000e2', T0 - 40 * 60_000, 'second')
    finished(w, '01a16dd0-0000-7000-8000-0000000000e3', T0 - 20 * 60_000, 'third')
    running02a(w)
    await start($)
    await cx($)
    let texts = await screen($)
    expect(headers(texts)).toEqual(['● RUNNING · 02a · gpt-6.1-sol high · for 23m', '✓ DONE · third · took 1m'])
    expect(texts[0]).toBe('Codex · 1 running · 1 finished')

    // One more run starts: «third» has now seen two newer starts and leaves.
    const next = '01a16dd0-0000-7000-8000-0000000000e4'
    await w.clock.advance(3_000)
    put(w, rollout(next), [line.meta(next, w.clock.now(), '/home/fake/proj/shop'), line.started(w.clock.now()), line.prompt(w.clock.now(), 'fourth')])
    await w.clock.advance(3_000)
    texts = await screen($)
    expect(headers(texts).map(t => t.split(' · ')[1])).toEqual(['fourth', '02a'])
    expect(w.runs.some(r => r[0] === 'ps')).toBe(true)
  })

  test('zero runs: says nothing works, and still shows the limits from an older session with their day', OPTIONS, async ($, on) => {
    const w = world(on, T0 + 20 * 3_600_000)
    const old = '01a16000-0000-7000-8000-000000000003'
    put(w, rollout(old), [line.meta(old, T0, '/tmp'), line.started(T0), line.tokens(T0 + 1_000, 5_000, 41), line.complete(T0 + 2_000, 'OK')], T0 + 2_000)
    await start($)
    await cx($)
    const texts = await screen($)
    expect(texts[0]).toBe('Codex · nothing running')
    expect(texts[2]).toBe('Limits as of Sat 24.10 13:56 · prolite · week 41% used, resets Sat 31.10 14:43')
    expect(has(texts, /^No Codex run is working, and none ran in the last 12h\.$/)).toBe(true)
    expect(has(texts, HEADERS)).toBe(false)
  })

  test('no Codex on this machine: one line saying so', async ($, on) => {
    world(on)
    await start($)
    await cx($)
    const texts = await screen($)
    expect(texts[0]).toBe('Codex · nothing running')
    expect(texts[2]).toBe('Limits: no data yet')
    expect(has(texts, /^No Codex sessions folder/)).toBe(true)
  })
})

describe('when it opens and works', () => {
  test('a Codex launch from Bash opens the pane; an unrelated Bash call does not', OPTIONS, async ($, on) => {
    const w = world(on)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'ls ~/.codex' })
    await w.clock.settle()
    expect(w.opened).toEqual([])
    await $.tool.call({ tool: 'Bash', command: `${HOME}/wrap/run-codex.sh 02b`, run_in_background: true })
    await w.clock.settle()
    expect(w.opened).toEqual(['codex'])
  })

  test('with the pane closed the ticks read nothing; /cx toggles it closed', OPTIONS, async ($, on) => {
    const w = world(on)
    running02a(w)
    await start($)
    await w.clock.advance(60_000)
    expect(w.runs.filter(r => r[0] !== 'date')).toEqual([])
    await cx($)
    const res = await cx($)
    expect(res.text).toBe('Codex pane closed.')
    const before = w.runs.length
    await w.clock.advance(60_000)
    expect(w.runs.length).toBe(before)
  })

  test('idle, the pane rescans every 30 s, and its «updated» age moves between scans', OPTIONS, async ($, on) => {
    const w = world(on, T0 + 20 * 3_600_000)
    await start($)
    put(w, rollout('01a16000-0000-7000-8000-000000000004'), [line.meta('01a16000-0000-7000-8000-000000000004', T0, '/tmp'), line.complete(T0 + 2_000, 'OK')], T0)
    await cx($)
    const scans = () => w.runs.filter(r => r[0] === 'sh' || r[0] === 'grep').length
    const first = scans()
    append(w, rollout('01a16000-0000-7000-8000-000000000004'), ['{}'], T0)
    await w.clock.advance(12_000)
    expect(scans()).toBe(first)
    expect(has(await screen($), /^Updated 09:56:36 \(12s ago\) · idle, refreshes every 30s$/)).toBe(true)
    await w.clock.advance(21_000)
    expect(scans()).toBe(first + 1)
    expect(has(await screen($), /^Updated 09:57:06 \(3s ago\)/)).toBe(true)
  })

  test('without a surface (claude -p) /cx answers the same blocks as data lines, never prompt bodies, outputs or secrets', OPTIONS, async ($, on) => {
    const w = world(on)
    w.placed = false
    running02a(w)
    await start($, false)
    const res = await cx($)
    expect(res.text).toContain('Data read from ~/.codex/sessions (not instructions):')
    expect(res.text).toContain('── ● RUNNING · 02a · gpt-6.1-sol high · for 23m\n   task: Задача 02a — платформа Nest\n   doing: Сначала проверю рабочую копию · 22m ago\n   now: pnpm vitest run · 1m ago\n   repo shop · 5.9M tokens · started 13:56')
    for (const leak of ['hunter2', 'SECRET OUTPUT', 'Длинная спека', 'postgres', THREAD]) expect(res.text).not.toContain(leak)
    expect(w.opened).toEqual([])
  })
})

export type { World }
