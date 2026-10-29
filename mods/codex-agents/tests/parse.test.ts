import { describe, expect, test } from 'claude-code/testing'

import { blockOf, buildView, clean, cmdOfJs, companionOwners, fmtDur, fmtTokens, hiddenText, isUnder, mask, merge, oneLine, ownerOf, parseTail, promptOf, splitHeaders, summary, taskFile } from '../hooks/parse'
import type { Rec } from '../hooks/parse'
import { T0, line } from './world'

const REC: Rec = { path: '/home/fake/r.jsonl', thread: 't', size: -1, mtimeMs: T0, isHeadRead: true, phase: 'none' }

describe('parse', () => {
  test('control characters never reach the terminal', () => {
    const evil = 'ok\u001b]0;pwned\u0007 \u001b[2J\u009bdone'
    expect(clean(evil)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    expect(oneLine(evil)).toBe('ok ]0;pwned [2J done')
  })

  test('mask hides env values, URL credentials and tokens, keeps the command readable', () => {
    expect(mask('TEST_DATABASE_URL="postgres://u:p@h/db" pnpm test')).toBe('TEST_DATABASE_URL=… pnpm test')
    expect(mask('psql postgres://admin:Kq7vR2mZ8pLw@db.local/app')).toBe('psql postgres://…@db.local/app')
    expect(mask('curl -H "Authorization: Bearer abcdefghijkl123" x')).toBe('curl -H "Authorization: Bearer …" x')
    expect(mask('gh auth --token ghp_abcdefghijklmnop1234')).toBe('gh auth --token …')
    expect(mask('api_key=zzz9 run')).toBe('api_key=… run')
    expect(mask('git diff apps/core/src/modules/feedback/feedback.service.ts')).toBe('git diff apps/core/src/modules/feedback/feedback.service.ts')
  })

  test('cmdOfJs reads the shell commands of a code-mode exec call', () => {
    expect(cmdOfJs('text(await tools.exec_command({cmd:"git status --short; pwd","max_output_tokens":3000}));')).toBe('git status --short; pwd')
    expect(cmdOfJs('await tools.exec_command({cmd: "a \\"q\\""}); await tools.exec_command({cmd:"b"})')).toBe('a "q" (+1)')
    expect(cmdOfJs('const x = 1')).toBeUndefined()
  })

  test('the newest turn boundary decides the phase; a big tail with none is mid-turn', () => {
    const run = merge(REC, parseTail([line.started(T0), line.command(T0 + 1, 'ls')].join('\n')), true)
    expect(run.phase).toBe('running')
    expect(run.action).toBe('listing files')
    const done = merge(run, parseTail(['partial', line.complete(T0 + 9_000, 'Готово.\nдетали')].join('\n')), false)
    expect(done.phase).toBe('done')
    expect(done.endAt).toBe(T0 + 9_000)
    expect(done.result).toBe('Готово.')
    expect(done.action).toBe('listing files')
    const again = merge(done, parseTail(['x', line.started(T0 + 60_000)].join('\n')), false)
    expect(again.phase).toBe('running')
    expect(again.endAt).toBeUndefined()
    expect(again.result).toBeUndefined()
    expect(merge(REC, parseTail(['cut-line', line.message(T0, 'hi')].join('\n')), false).phase).toBe('running')
    expect(merge(REC, parseTail(line.message(T0, 'hi')), true).phase).toBe('none')
  })

  test('a failed turn shows why; the usage-limit error in words, never its link', () => {
    const r = merge(REC, parseTail([line.started(T0), line.complete(T0 + 1, null, 'usage_limit_exceeded')].join('\n')), true)
    expect(r.phase).toBe('failed')
    expect(r.error).toBe('usage limit reached')
    expect(JSON.stringify(r)).not.toContain('example.com')
  })

  test('a result whose first line is a bare heading carries the next line', () => {
    const r = merge(REC, parseTail([line.started(T0), line.complete(T0 + 1, '1. Findings\n\n- `ui.tsx` drops the empty state')].join('\n')), true)
    expect(r.result).toBe('1. Findings — `ui.tsx` drops the empty state')
    const plain = merge(REC, parseTail([line.started(T0), line.complete(T0 + 1, 'Changed only the two specified files.\nmore')].join('\n')), true)
    expect(plain.result).toBe('Changed only the two specified files.')
    const short = merge(REC, parseTail([line.started(T0), line.complete(T0 + 1, 'Готово.\nдетали')].join('\n')), true)
    expect(short.result).toBe('Готово.')
    const head = merge(REC, parseTail([line.started(T0), line.complete(T0 + 1, '## Summary\n**All** green')].join('\n')), true)
    expect(head.result).toBe('Summary — All green')
  })

  test('token_count gives the total and the plan windows', () => {
    const r = merge(REC, parseTail(line.tokens(T0, 4_179_930, 12.5)), true)
    expect(r.tokens).toBe(4_179_930)
    expect(r.usage).toEqual({ plan: 'prolite', windows: [{ minutes: 10080, pct: 12.5, resetsAt: Date.UTC(2026, 9, 31, 12, 43) }], at: T0 })
  })

  test('prompt line, wrapper file names, headers split, formats', () => {
    expect(promptOf('"type":"UserMessage","id":"u","content":[{"type":"text","text":"# Задача 02a — платформа')).toBe('Задача 02a — платформа')
    expect(promptOf('"type":"UserMessage","id":"u","content":[{"type":"text","text":"')).toBeUndefined()
    expect(taskFile('codex-02a.jsonl')).toEqual({ id: '02a', kind: 'events' })
    expect(taskFile('codex-02a-review.jsonl')).toEqual({ id: '02a review', kind: 'events' })
    expect(taskFile('codex-02a.resume-2.jsonl')).toEqual({ id: '02a', kind: 'events' })
    expect(taskFile('codex-02a.session')).toEqual({ id: '02a', kind: 'session' })
    expect(taskFile('codex-02a.err')).toBeNull()
    const split = splitHeaders('==> /a <==\nx\ny\n\n==> /b <==\nz', ['/a', '/b'])
    expect(split.get('/a')).toBe('x\ny')
    expect(split.get('/b')).toBe('z')
    expect(fmtDur(45_000)).toBe('45s')
    expect(fmtDur(23 * 60_000)).toBe('23m')
    expect(fmtDur(65 * 60_000)).toBe('1h 05m')
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(21_679)).toBe('22k')
    expect(fmtTokens(5_900_000)).toBe('5.9M')
  })

  const OPTS = { windowMs: 12 * 3_600_000, staleMs: 10 * 60_000, lostMs: 60 * 60_000 }
  const NOW = T0 + 60 * 60_000
  const run = (thread: string, startMin: number, phase: Rec['phase'], extra: Partial<Rec> = {}): Rec => ({
    ...REC,
    path: `/home/fake/${thread}.jsonl`,
    thread,
    prompt: thread,
    startMs: T0 + startMin * 60_000,
    turnStart: T0 + startMin * 60_000,
    mtimeMs: phase === 'running' ? NOW : T0 + (startMin + 1) * 60_000,
    phase,
    ...extra,
  })
  const labels = (recs: Rec[]) => buildView(recs, new Map(), NOW, OPTS).runs.map(r => r.label)

  test('three finished and one running, the running one newest: the run and the last finished one show', () => {
    expect(labels([run('f1', 0, 'done'), run('f2', 10, 'failed', { error: 'boom' }), run('f3', 20, 'done'), run('r', 30, 'running')])).toEqual(['r', 'f3'])
  })

  test('three finished and one running, the running one oldest: it stays, with the two newest finished', () => {
    expect(labels([run('r', 0, 'running'), run('f1', 10, 'done'), run('f2', 20, 'done'), run('f3', 30, 'done')])).toEqual(['r', 'f3', 'f2'])
  })

  test('a finished run lives two rounds: shown alone, still shown after one newer start, gone after the second', () => {
    const done = run('done', 0, 'done')
    expect(labels([done])).toEqual(['done'])
    expect(labels([done, run('a', 10, 'running')])).toEqual(['a', 'done'])
    expect(labels([done, run('a', 10, 'running'), run('b', 20, 'running')])).toEqual(['b', 'a'])
  })

  test('an unfinished run silent past lostMs is failed and ages out like any finished run', () => {
    const lost = run('lost', 0, 'running', { mtimeMs: NOW - 70 * 60_000 })
    const view = buildView([lost], new Map(), NOW, OPTS)
    expect(view.runs[0]?.phase).toBe('failed')
    expect(view.runs[0]?.reason).toBe('no events for 1h 10m')
    expect(labels([lost, run('a', 5, 'done'), run('b', 6, 'done')])).toEqual(['b', 'a'])
  })

  test('a block names its status in words, the reason, the labelled lines and the meta', () => {
    const view = buildView(
      [run('ok', 0, 'done', { result: 'All green', action: '$ pnpm test', tokens: 1_816_357, cwd: '/home/fake/wt-121' }), run('bad', 1, 'failed', { error: 'usage limit reached', action: '$ ls' })],
      new Map(),
      NOW,
      OPTS,
    )
    const [bad, ok] = view.runs.map(r => blockOf(r, NOW, 120))
    expect(ok).toEqual({ status: '✓ DONE', title: 'ok', time: 'took 1m', lines: [{ label: 'result', text: 'All green' }], meta: 'repo wt-121 · 1.8M tokens · started 13:56 · finished 13:57' })
    expect(bad?.status).toBe('✖ FAILED (usage limit reached)')
    expect(bad?.lines).toEqual([{ label: 'last', text: '$ ls' }])
  })

  describe('a resumed thread: Codex appends the new turn to the old file', () => {
    const M = 60_000
    // Turn 1 ran 0–40 min; a review started at 49 min and finished; the resume (turn 2) started at 54 min.
    const turn1 = [line.started(T0), line.message(T0 + 5 * M, 'Первый круг: читаю спеку'), line.command(T0 + 30 * M, 'npm run check'), line.complete(T0 + 40 * M, 'П1–П5 готовы.')]
    const turn2 = [line.started(T0 + 54 * M), line.command(T0 + 55 * M, 'git diff --stat')]
    const review = run('review', 49, 'done', { endAt: T0 + 52 * M })

    test('turn 1 complete + turn 2 in progress: RUNNING, timed from turn 2, on top, no remark of turn 1', () => {
      const rec = merge({ ...REC, thread: 'resumed', prompt: 'resumed', startMs: T0, mtimeMs: NOW }, parseTail([...turn1, ...turn2].join('\n')), true)
      expect(rec.phase).toBe('running')
      expect(rec.turnStart).toBe(T0 + 54 * M)
      expect(rec.note).toBeUndefined()
      expect(rec.action).toBe('git diff')
      const view = buildView([review, rec], new Map(), NOW, OPTS)
      expect(view.runs.map(r => [r.label, r.phase])).toEqual([
        ['resumed', 'running'],
        ['review', 'done'],
      ])
      expect(view.runs[0]?.startAt).toBe(T0 + 54 * M)
      expect(view.runs[0]?.elapsedMs).toBe(6 * M)
    })

    test('the same seen in two reads: turn 1 done first, then the resume', () => {
      const first = merge({ ...REC, thread: 'resumed', startMs: T0 }, parseTail(turn1.join('\n')), true)
      expect(first.phase).toBe('done')
      const second = merge(first, parseTail(turn2.join('\n')), false)
      expect(second.phase).toBe('running')
      expect(second.endAt).toBeUndefined()
      expect(second.result).toBeUndefined()
      expect(second.note).toBeUndefined()
    })

    test('turn 2 complete: DONE with turn 2 result and end; it counts as started at turn 2 for the two-rounds rule', () => {
      const end = [...turn1, ...turn2, line.complete(T0 + 58 * M, 'Все три замечания обработаны.')]
      const rec = merge({ ...REC, thread: 'resumed', prompt: 'resumed', startMs: T0, mtimeMs: T0 + 58 * M }, parseTail(end.join('\n')), true)
      expect(rec.phase).toBe('done')
      expect(rec.endAt).toBe(T0 + 58 * M)
      expect(rec.result).toBe('Все три замечания обработаны.')
      // Two runs started after turn 1: by its first start it would be gone; by its newest it stays, first — and the
      // resume is a newer start for `a`, which leaves.
      const view = buildView([run('a', 45, 'done'), review, rec], new Map(), NOW, OPTS)
      expect(view.runs.map(r => r.label)).toEqual(['resumed', 'review'])
      expect(view.runs[0]?.endAt).toBe(T0 + 58 * M)
      expect(view.runs[0]?.elapsedMs).toBe(4 * M)
    })
  })

  test('who launched a run: owner files, the codex plugin records, the process tree', () => {
    expect(taskFile('codex-04.owner')).toEqual({ id: '04', kind: 'owner' })
    expect(taskFile('codex-04-review.owner')).toEqual({ id: '04 review', kind: 'owner' })
    expect(ownerOf('72aa0000-0000-4000-8000-00000000c1a0\n')).toBe('72aa0000-0000-4000-8000-00000000c1a0')
    expect(ownerOf('')).toBeNull()
    expect(ownerOf('a b; rm -rf ~')).toBeNull()
    const state = JSON.stringify({
      version: 1,
      jobs: [
        { id: 'task-1', sessionId: '78715727-294b-44fb-9a68-62a436175710', threadId: '01a16b0a-7783-7061-9aa1-139d68f33b93' },
        { id: 'task-2', sessionId: '78715727-294b-44fb-9a68-62a436175710' },
        { id: 'task-3', sessionId: 'x y', threadId: '01a16b0a-7783-7061-9aa1-139d68f33b94' },
      ],
    })
    expect(companionOwners(state)).toEqual([['01a16b0a-7783-7061-9aa1-139d68f33b93', '78715727-294b-44fb-9a68-62a436175710']])
    expect(companionOwners('{not json')).toEqual([])
    const parents = new Map([
      [30, 20],
      [20, 10],
      [10, 1],
      [40, 1],
    ])
    expect(isUnder(30, 10, parents)).toBe(true)
    expect(isUnder(40, 10, parents)).toBe(false)
    expect(isUnder(99, 10, parents)).toBe(false)
    const loop = new Map([
      [5, 6],
      [6, 5],
    ])
    expect(isUnder(5, 10, loop)).toBe(false)
  })

  test("only this session's runs are listed; the rest are counted, the two-rounds rule among its own", () => {
    const mine = new Set(['r', 'f3'])
    const recs = [run('f1', 0, 'done'), run('f3', 20, 'done'), run('x', 30, 'running'), run('y', 40, 'done'), run('r', 10, 'running')]
    const view = buildView(recs, new Map(), NOW, { ...OPTS, isMine: t => mine.has(t) })
    expect(view.runs.map(r => r.label)).toEqual(['r', 'f3'])
    expect(view.hidden).toEqual({ runs: 3, live: 1 })
    expect(hiddenText(view)).toBe('Hidden: 3 runs not launched from this session (1 running).')
    expect(summary(view, 60, OPTS.windowMs).split('\n').pop()).toBe('Hidden: 3 runs not launched from this session (1 running).')
    expect(hiddenText(buildView([run('y', 40, 'done')], new Map(), NOW, { ...OPTS, isMine: () => false }))).toBe('Hidden: 1 run not launched from this session.')
    expect(buildView(recs, new Map(), NOW, OPTS).hidden).toBeUndefined()
  })
})
