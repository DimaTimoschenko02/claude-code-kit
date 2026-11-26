// Lens history (history.mjs via runs.mjs) and the numeric signals of effect.mjs behind it. Cases are the ones that made
// the token audit repeat itself four times (2026-11-26): a fix with no number to check, a return nobody linked to the
// fix it undid, and form words («rule exists and did not fire») passing for a failure class.
// Run: node --test chat-audit/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'lens history '));
process.env.HOME = path.join(T, 'home');
process.env.USERPROFILE = process.env.HOME;   // os.homedir() reads USERPROFILE on Windows
delete process.env.CLAUDE_CONFIG_DIR;
const { measure, metricVerdict } = await import('../payload/skills/chat-audit/lib/effect.mjs');
const { lensHistory, classKey, plural } = await import('../payload/skills/chat-audit/lib/history.mjs');
const runs = fileURLToPath(new URL('../payload/skills/chat-audit/lib/runs.mjs', import.meta.url));
test.after(() => fs.rmSync(T, { recursive: true, force: true }));

const DAY = 86400e3;
const NOW = Date.parse('2026-11-26T12:00:00Z');
const CHANGE = new Date(NOW - 5 * DAY).toISOString();
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const iso = (t) => new Date(t).toISOString();

// A project whose main session ran 200k-context calls with two compactions a day, then 120k calls and no compactions.
const proj = path.join(T, 'proj');
fs.mkdirSync(proj, { recursive: true });
const lines = [];
let n = 0;
const call = (t, ctx, cr) => {
  const id = `msg_${n++}`;
  const usage = { input_tokens: ctx - cr, cache_read_input_tokens: cr, cache_creation_input_tokens: 0, output_tokens: 10 };
  const line = { type: 'assistant', cwd: proj, timestamp: iso(t), message: { id, model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: 'ok' }] } };
  lines.push(line, { ...line, message: { ...line.message, content: [{ type: 'tool_use', id: `tu_${id}`, name: 'Read', input: {} }] } });
};
for (let d = 0; d < 6; d++) {
  const base = NOW - 11 * DAY + d * DAY;
  for (let i = 0; i < 6; i++) call(base + i * 3600e3, 200_000, 150_000);
  lines.push({ type: 'system', subtype: 'compact_boundary', uuid: `cb${d}a`, timestamp: iso(base + 1000), cwd: proj });
  lines.push({ type: 'system', subtype: 'compact_boundary', uuid: `cb${d}b`, timestamp: iso(base + 2000), cwd: proj });
}
for (let d = 0; d < 4; d++) {
  const base = NOW - 4.5 * DAY + d * DAY;
  for (let i = 0; i < 8; i++) call(base + i * 3600e3, 120_000, 114_000);
}
put(path.join(process.env.HOME, '.claude/projects/proj/s1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
// A subagent's calls are not the main session's context.
put(path.join(process.env.HOME, '.claude/projects/proj/s1/subagents/agent-a.jsonl'),
  JSON.stringify({ type: 'assistant', cwd: proj, timestamp: iso(NOW - DAY), message: { id: 'sub', usage: { input_tokens: 900_000 }, content: [] } }) + '\n');

const change = (id, src, want, extra = {}) => ({ type: 'change', id, ts: CHANGE, lens: 'tokens', class: 'main session re-reads ~200k per call', signal: { src, want }, ...extra });
const ledger = path.join(proj, '.claude/state/chat-audit/ledger.jsonl');
put(ledger, [
  change('C-1', 'metric:context-median', 'down'),
  change('C-2', 'metric:compactions-per-day', 'down'),
  change('C-3', 'metric:cache-read-share', 'up'),
  change('C-4', 'metric:context-median', 'up'),
  // A token audit's line: written later than applied, a hand baseline keyed by metric, extras.
  change('C-5', 'metric:main-context-p50', 'down', {
    ts: iso(NOW), applied_at: CHANGE.slice(0, 10) + 'T12:00:00Z',
    signals_extra: [{ src: 'metric:main-compactions-per-day', want: 'down' }, { src: 'metric:cache-read-share', want: 'up' }],
    baseline: { at: '2026-11-21', 'main-context-p50': 202000, 'main-compactions-per-day': null, 'cache-read-share': null },
  }),
].map((r) => JSON.stringify(r)).join('\n') + '\n');

test('metric signals: median context, compactions a day and cache-read share, main session only, one call per message id', () => {
  const byId = Object.fromEntries(measure({ project: proj, ledger, now: NOW, git: false }).map((r) => [r.id, r]));
  assert.equal(byId['C-1'].before.value, 200_000);
  assert.equal(byId['C-1'].before.n, 36);
  assert.equal(byId['C-1'].after.value, 120_000);
  assert.equal(byId['C-1'].after.n, 32);
  assert.equal(byId['C-1'].verdict, 'works');
  assert.equal(byId['C-2'].before.value, 2);
  assert.equal(byId['C-2'].after.value, 0);
  assert.equal(byId['C-2'].verdict, 'works');
  assert.equal(byId['C-3'].before.value, 0.75);
  assert.equal(byId['C-3'].after.value, 0.95);
  assert.equal(byId['C-3'].verdict, 'works');
  assert.equal(byId['C-4'].verdict, 'harmful');
});

test('a line logged after the fact is measured from applied_at, on its hand baseline, with every extra signal', () => {
  const c5 = measure({ project: proj, ledger, now: NOW, git: false }).find((r) => r.id === 'C-5');
  assert.equal(c5.metric, 'main-context-p50');
  assert.deepEqual(c5.before, { value: 202000, n: null });   // the audit's number, not the transcripts'
  assert.equal(c5.after.value, 120_000);
  assert.equal(c5.verdict, 'works');
  assert.deepEqual(c5.extra.map((x) => [x.metric, x.before.value, x.after.value, x.verdict]), [
    ['main-compactions-per-day', 2, 0, 'works'],              // null by hand → the 7 days before applied_at
    ['cache-read-share', 0.75, 0.95, 'works'],
  ]);
});

test('metric verdict: a small move is no effect, too few calls after is unclear, no baseline is unmeasurable', () => {
  const sig = { src: 'metric:context-median', want: 'down' }, ts = Date.parse(CHANGE);
  assert.equal(metricVerdict(sig, ts, { value: 200, n: 50 }, { value: 190, n: 50 }, NOW), 'no-effect');
  assert.equal(metricVerdict(sig, ts, { value: 200, n: 50 }, { value: 100, n: 5 }, NOW), 'unclear-window');
  assert.equal(metricVerdict(sig, ts, { value: null, n: 0 }, { value: 100, n: 50 }, NOW), 'unmeasurable');
  assert.equal(metricVerdict({ ...sig, by: 0.5 }, ts, { value: 200, n: 50 }, { value: 130, n: 50 }, NOW), 'no-effect');
  const fading = { value: 100, n: 50, last: { value: 210, n: 25 } };
  assert.equal(metricVerdict(sig, ts, { value: 200, n: 50 }, fading, NOW), 'decaying');
});

test('session-start-tokens is the first call of each main session; a resumed session has no start', () => {
  const p2 = path.join(T, 'proj2');
  fs.mkdirSync(p2, { recursive: true });
  const at = (t, id, ctx) => JSON.stringify({ type: 'assistant', cwd: p2, timestamp: iso(t),
    message: { id, model: 'claude-opus-5-5', usage: { input_tokens: ctx }, content: [{ type: 'text', text: 'ok' }] } });
  const dir = path.join(process.env.HOME, '.claude/projects/proj2');
  for (let i = 0; i < 12; i++) {
    const b = NOW - 11 * DAY + i * 3 * 3600e3, a = NOW - 4.5 * DAY + i * 3 * 3600e3;
    put(path.join(dir, `b${i}.jsonl`), [at(b, `b${i}-1`, 76_000), at(b + 60e3, `b${i}-2`, 150_000)].join('\n') + '\n');
    put(path.join(dir, `a${i}.jsonl`), [at(a, `a${i}-1`, 50_000), at(a + 60e3, `a${i}-2`, 150_000)].join('\n') + '\n');
  }
  // Resumed after the change: opens with a copy of an earlier call, then calls deep into a 150k context.
  put(path.join(dir, 'r.jsonl'), [at(NOW - 11 * DAY, 'b0-2', 150_000), at(NOW - DAY, 'r-1', 150_000)].join('\n') + '\n');
  const led = path.join(p2, '.claude/state/chat-audit/ledger.jsonl');
  put(led, JSON.stringify(change('C-16', 'metric:session-start-tokens', 'down', { baseline: { 'session-start-tokens': null } })) + '\n');
  const [r] = measure({ project: p2, ledger: led, now: NOW, git: false });
  assert.deepEqual([r.before.value, r.before.n, r.after.value, r.after.n, r.verdict], [76_000, 12, 50_000, 12, 'works']);
});

test('counters agree with their number in Russian', () => {
  assert.deepEqual([1, 2, 4, 5, 11, 12, 21, 22, 25, 111].map((k) => plural(k, 'раз', 'раза', 'раз').split(' ')[1]),
    ['раз', 'раза', 'раза', 'раз', 'раз', 'раз', 'раз', 'раза', 'раз', 'раз']);
  assert.equal(plural(21, 'находка', 'находки', 'находок'), '21 находка');
});

test('an unknown metric is an error, not a silent count', () => {
  const bad = path.join(T, 'bad.jsonl');
  put(bad, JSON.stringify(change('C-9', 'metric:nope', 'down')) + '\n');
  assert.throws(() => measure({ project: proj, ledger: bad, now: NOW, git: false }), /unknown metric: nope/);
});

const finding = (ts, audit, claim, cls, extra = {}) => ({ ts, audit, claim, class: cls, anchor: `s/${ts}`, verdict: 'accepted', applied: null, lens: 'tokens', ...extra });

test('a finding back on the same lens and class rots the accepted change, with its lifetime', () => {
  const rows = [
    finding('2026-10-28T10:00:00Z', '2026-10-28-tokens', 'context ~200k per call', 'main session re-reads ~200k per call', { applied: 'abc1234' }),
    { type: 'change', id: 'C-7', ts: '2026-10-29T10:00:00Z', lens: 'tokens', commit: 'abc1234f', class: 'main session re-reads ~200k per call' },
    finding('2026-11-04T10:00:00Z', '2026-11-04-tokens', 'still ~190k', 'Main session re-reads ~200k per call.', { verdict: 'rejected' }),
    finding('2026-11-26T10:00:00Z', '2026-11-26-tokens', 'still ~195k', 'main session re-reads ~200k per call', { verdict: 'edited', applied: 'def5678' }),
  ];
  const h = lensHistory(rows).get('tokens');
  const c7 = h.changes.find((c) => c.id === 'C-7');
  assert.equal(c7.rotted.lifetime, 6);                       // 29.10 → 04.11
  assert.equal(h.findings[0].change, 'C-7');                 // the accepted fix is the change line, not a second change
  assert.deepEqual(h.findings[0].cameBack.map((f) => f.ts.slice(0, 10)), ['2026-11-04', '2026-11-26']);
  assert.equal(h.findings[2].returnOf.length, 2);
  const f2 = h.changes.find((c) => c.id === 'F:def5678');   // an accepted fix with no change line is still a change
  assert.ok(f2 && !f2.rotted);
  assert.equal(h.changes.length, 2);
});

test('form words are not a failure class, and the same audit is not a return', () => {
  assert.equal(classKey('rule exists and did not fire'), null);
  assert.equal(classKey('exists-but-did-not-fire'), null);
  assert.equal(classKey('fix-rotted'), null);
  const rows = [
    { type: 'change', id: 'C-1', ts: '2026-11-01T00:00:00Z', lens: '8', class: 'rule exists and did not fire', audit: 'a1' },
    finding('2026-11-10T00:00:00Z', 'a2', 'other problem', 'rule exists and did not fire', { lens: '8' }),
    { type: 'change', id: 'C-2', ts: '2026-11-01T00:00:00Z', lens: '8', class: 'gate predicate wrong', audit: 'a1' },
    finding('2026-11-01T00:00:00Z', 'a1', 'same report', 'gate predicate wrong', { lens: '8' }),
  ];
  const h = lensHistory(rows).get('8');
  assert.equal(h.changes.find((c) => c.id === 'C-1').rotted, undefined);
  assert.equal(h.changes.find((c) => c.id === 'C-2').rotted, undefined);
});

test('a fix-rotted line names its change — under another lens or none — and its lifetime wins', () => {
  const rows = [
    { type: 'change', id: 'C-150', ts: '2026-11-11T00:00:00Z', class: 'dispatcher revives dead sessions' },   // no lens
    finding('2026-11-26T00:00:00Z', 'a9', 'a dead session waited 12 h', 'fix-rotted',
      { lens: 'agents', class_was: 'dead task session not revived', rotted_change: 'C-150', fix_lived_days: 14 }),
    finding('2026-12-02T00:00:00Z', 'a10', 'again', 'dead task session not revived', { lens: 'agents' }),
  ];
  const all = lensHistory(rows);
  const c150 = all.get('без линзы').changes[0];
  assert.equal(c150.rotted.lifetime, 14);
  assert.equal(c150.rotted.finding.audit, 'a9');
  assert.equal(all.get('agents').findings[1].returnOf.length, 1);   // class_was is the class it is matched on
});

test('runs.mjs refresh writes one note per lens with lines, drops a generated note whose lens is gone, keeps hand notes', () => {
  const vault = path.join(T, 'vault');
  const notes = path.join(vault, '01 projects/chat-audit');
  put(path.join(notes, 'audit-mandatory-items.md'), ['## Обязательные — скриптами', '| 7 | Токены одной таблицей |',
    '## Линзы скилла — где они в списке', '| rules | правила |'].join('\n'));
  put(path.join(vault, '.claude/machines.json'), JSON.stringify({ machines: { m: { hostnames: [os.hostname()] } } }));
  const led = path.join(T, 'p2/.claude/state/chat-audit/ledger.jsonl');
  put(led, [
    finding('2026-10-28T10:00:00Z', 'a1', 'context ~200k per call', 'main session re-reads ~200k per call', { lens: '7', applied: 'abc1234' }),
    finding('2026-11-26T10:00:00Z', 'a2', 'still ~195k', 'main session re-reads ~200k per call', { lens: '7' }),
    { ts: '2026-11-26T10:00:00Z', claim: 'no lens yet', class: 'x', verdict: 'rejected' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const dir = path.join(notes, 'history/p2');
  put(path.join(dir, 'gone.md'), '> Generated by runs.mjs from the project ledger, do not edit.\n');
  put(path.join(dir, 'hand.md'), 'my own note\n');
  const env = { ...process.env, MIND_VAULT: vault };
  const r = spawnSync(process.execPath, [runs, 'refresh', '--project', 'p2', '--ledger', led, '--no-measure'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /history p2: 2 note\(s\), 1 removed; 1 ledger line\(s\) without lens, in «без линзы»/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['7.md', 'hand.md', 'без линзы.md']);
  const note = fs.readFileSync(path.join(dir, '7.md'), 'utf8');
  assert.match(note, /^# p2 · 7 — Токены одной таблицей$/m);
  assert.match(note, /«main session re-reads ~200k per call» — советовали 2 раза/);
  assert.match(note, /2 находки, 1 правка, сгнило: 1\./);
  assert.match(note, /F:abc1234 \(2026-10-28\): 29 дн\./);
  assert.match(note, /\*\*Сгнила\*\*: вернулась 2026-11-26, жила 29 дн\./);
  assert.match(fs.readFileSync(path.join(notes, 'runs.md'), 'utf8'), /Generated by runs\.mjs/);
  const again = spawnSync(process.execPath, [runs, 'refresh', '--project', 'p2', '--ledger', led, '--no-measure'], { env, encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.readFileSync(path.join(dir, '7.md'), 'utf8'), note);   // regenerating changes nothing
});
