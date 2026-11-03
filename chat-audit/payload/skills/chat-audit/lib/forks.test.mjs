// node --test forks.test.mjs
// Synthetic cases pin the marks and the transcript walk. Tests on real sessions live in the workspace that owns those
// transcripts, not in this public kit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { markPair, classify, pairsFromClaude } from './forks.mjs';

const cls = (p) => classify(markPair(p));

test('new **Развилка:** block is a fork_block', () => {
  const agentText = '**Развилка:** хранить в БД или в файле?\n1. БД\n2. Файл\n**Рекомендую: 1** — проще мигрировать';
  assert.equal(cls({ agentText, userText: '1' }), 'fork_block');
});

test('numbered options + recommendation is explicit; a bare numbered list is weak', () => {
  assert.equal(cls({ agentText: 'Есть два пути:\n1. быстро\n2. красиво\nЯ бы взял 2. Берём?', userText: 'да' }), 'explicit');
  assert.equal(cls({ agentText: 'Шаги:\n1. поставить\n2. запустить\nГотово.', userText: 'ок' }), 'weak');
});

test('lettered options and "вариант" words count as options', () => {
  assert.ok(markPair({ agentText: 'A) один\nB) два', userText: '' }).includes('opt_lettered'));
  assert.ok(markPair({ agentText: 'Вариант 1 — так. Вариант 2 — этак. Что выбираешь?', userText: '' }).includes('opt_variant_word'));
});

test('implicit fork needs the agent to have acted; the same words without action are correction_no_action', () => {
  const userText = 'нет, не так, верни как было';
  assert.equal(cls({ agentText: 'Сделал.', userText, acted: true }), 'implicit');
  assert.equal(cls({ agentText: 'Сделал.', userText, acted: false }), 'correction_no_action');
});

test('correction regex does not fire on Cyrillic mid-text ("\\W" is ASCII-only under /u)', () => {
  assert.equal(cls({ agentText: 'Сделал.', userText: 'Так, отлично, смотри, дальше давай по плану', acted: true }), 'none');
});

function writeTranscript(lines) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'forks-')), 'sess.jsonl');
  fs.writeFileSync(f, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  return f;
}
const u = (uuid, ts, content, extra = {}) => ({ type: 'user', uuid, timestamp: ts, cwd: '/p', isSidechain: false, message: { role: 'user', content }, ...extra });
const a = (ts, content) => ({ type: 'assistant', timestamp: ts, isSidechain: false, message: { role: 'assistant', content } });

test('walk: only origin=human is the user; task-notification and tool results are not; wait is measured from the last agent text', async () => {
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

test('walk: the same user turn uuid in a resumed copy counts once', async () => {
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
