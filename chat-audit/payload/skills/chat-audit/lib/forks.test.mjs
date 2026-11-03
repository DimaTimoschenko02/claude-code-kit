// node --test forks.test.mjs
// Synthetic cases pin the marks and the transcript walk; three real sessions (skipped when the transcripts are not on
// this machine) pin the end-to-end behaviour on data the extractor was built against.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { markPair, classify, pairsFromClaude } from './forks.mjs';

const HOME = os.homedir();
const cls = (p) => classify(markPair(p));

test('new **Развилка:** block is a fork_block', () => {
  const agentText = '**Развилка:** хранить в БД или в файле?\n1. БД\n2. Файл\n**Рекомендую: 1** — проще мигрировать';
  assert.equal(cls({ agentText, dimaText: '1' }), 'fork_block');
});

test('numbered options + recommendation is explicit; a bare numbered list is weak', () => {
  assert.equal(cls({ agentText: 'Есть два пути:\n1. быстро\n2. красиво\nЯ бы взял 2. Берём?', dimaText: 'да' }), 'explicit');
  assert.equal(cls({ agentText: 'Шаги:\n1. поставить\n2. запустить\nГотово.', dimaText: 'ок' }), 'weak');
});

test('lettered options and "вариант" words count as options', () => {
  assert.ok(markPair({ agentText: 'A) один\nB) два', dimaText: '' }).includes('opt_lettered'));
  assert.ok(markPair({ agentText: 'Вариант 1 — так. Вариант 2 — этак. Что выбираешь?', dimaText: '' }).includes('opt_variant_word'));
});

test('implicit fork needs the agent to have acted; the same words without action are correction_no_action', () => {
  const dimaText = 'нет, не так, верни как было';
  assert.equal(cls({ agentText: 'Сделал.', dimaText, acted: true }), 'implicit');
  assert.equal(cls({ agentText: 'Сделал.', dimaText, acted: false }), 'correction_no_action');
});

test('correction regex does not fire on Cyrillic mid-text ("\\W" is ASCII-only under /u)', () => {
  assert.equal(cls({ agentText: 'Сделал.', dimaText: 'Так, отлично, смотри, дальше давай по плану', acted: true }), 'none');
});

function writeTranscript(lines) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'forks-')), 'sess.jsonl');
  fs.writeFileSync(f, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  return f;
}
const u = (uuid, ts, content, extra = {}) => ({ type: 'user', uuid, timestamp: ts, cwd: '/p', isSidechain: false, message: { role: 'user', content }, ...extra });
const a = (ts, content) => ({ type: 'assistant', timestamp: ts, isSidechain: false, message: { role: 'assistant', content } });

test('walk: only origin=human is Dima; task-notification and tool results are not; wait is measured from the last agent text', async () => {
  const pad = 'x'.repeat(40);
  const f = writeTranscript([
    u('u1', '2026-11-01T10:00:00Z', 'начинаем ' + pad, { origin: { kind: 'human' } }),
    a('2026-11-01T10:01:00Z', [{ type: 'text', text: 'Варианты:\n1. А\n2. Б\nРекомендую 2. Какой берём?' }]),
    u('u2', '2026-11-01T10:01:30Z', '<task-notification>done ' + pad + '</task-notification>', { origin: { kind: 'task-notification' } }),
    u('u3', '2026-11-01T10:05:00Z', '2, делай ' + pad, { origin: { kind: 'human' } }),
  ]);
  const { pairs, stats } = await pairsFromClaude(f, { project: 't' });
  assert.equal(stats.humanTurns, 2);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].cls, 'explicit');
  assert.equal(pairs[0].waitSec, 240);
});

test('walk: AskUserQuestion becomes an ask_tool pair, and a pick of the (Recommended) option is tagged', async () => {
  const f = writeTranscript([
    a('2026-11-01T10:00:00Z', [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: { questions: [{ question: 'Глубина?', options: [{ label: 'Lite (Recommended)' }, { label: 'Normal' }] }] } }]),
    { ...u('u1', '2026-11-01T10:00:30Z', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]), toolUseResult: { answers: { 'Глубина?': 'Lite' } } },
  ]);
  const { pairs } = await pairsFromClaude(f, { project: 't' });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].cls, 'ask_tool');
  assert.ok(pairs[0].tags.includes('ask_picked_rec'));
  assert.equal(pairs[0].waitSec, 30);
});

test('walk: the same Dima turn uuid in a resumed copy counts once', async () => {
  const mk = () => writeTranscript([
    a('2026-11-01T10:00:00Z', [{ type: 'text', text: 'Готово. Что дальше делаем? ' + 'x'.repeat(40) }]),
    u('same', '2026-11-01T10:01:00Z', 'следующая задача ' + 'y'.repeat(40), { origin: { kind: 'human' } }),
  ]);
  const seen = new Set();
  const first = await pairsFromClaude(mk(), { seen });
  const second = await pairsFromClaude(mk(), { seen });
  assert.equal(first.pairs.length, 1);
  assert.equal(second.pairs.length, 0);
  assert.equal(second.stats.dupTurns, 1);
});

// ---- real sessions (immutable history, so the facts below do not drift)
const real = (dir, id) => path.join(HOME, '.claude', 'projects', dir, id + '.jsonl');
const KN = 'C--Users-dimti-pprojects-knigomania';
const MIND = 'C--Users-dimti-do-chego-doshel-progress-mind';

test('real: knigomania PH-205 interview session — "на все да" answers a numbered, recommended list', { skip: !fs.existsSync(real(KN, '396b2263-b61f-4486-b043-1b8b328fa847')) }, async () => {
  const { pairs } = await pairsFromClaude(real(KN, '396b2263-b61f-4486-b043-1b8b328fa847'), { project: 'knigomania' });
  const hit = pairs.find((p) => p.dima.trim() === 'на все да');
  assert.ok(hit, 'the one-line answer is found');
  assert.equal(hit.cls, 'explicit');
  for (const p of pairs) { assert.ok(p.session && p.ts && p.agent && p.dima); assert.ok(p.agent.length <= 1600); }
});

const sessionFile = (dir, prefix) => {
  try { const f = fs.readdirSync(path.join(HOME, '.claude', 'projects', dir)).find((n) => n.startsWith(prefix) && n.endsWith('.jsonl')); return f ? path.join(HOME, '.claude', 'projects', dir, f) : null; } catch { return null; }
};

test('real: knigomania session with an explicit "Нет, друг" correction after a non-acting turn', { skip: !sessionFile(KN, 'a9f2fdeb') }, async () => {
  const { pairs } = await pairsFromClaude(sessionFile(KN, 'a9f2fdeb'), { project: 'knigomania' });
  assert.ok(pairs.some((p) => /^Нет, друг/.test(p.dima) && p.tags.some((t) => t.startsWith('correction'))));
});

test('real: mind session with a rejected AskUserQuestion keeps question, options and the rejection', { skip: !fs.existsSync(real(MIND, 'ae507a6b-eb1f-47e2-b6c0-3dc0c6b178d3')) }, async () => {
  const { pairs } = await pairsFromClaude(real(MIND, 'ae507a6b-eb1f-47e2-b6c0-3dc0c6b178d3'), { project: 'mind' });
  const ask = pairs.find((p) => p.kind === 'ask');
  assert.ok(ask);
  assert.equal(ask.cls, 'ask_tool');
  assert.ok(ask.tags.includes('ask_rejected') && ask.tags.includes('ask_rec'));
  assert.match(ask.agent, /Lite \(Recommended\)/);
});
