import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeLaunch, codexLaunch } from './origin.mjs';
import { pairsFromClaude } from './forks.mjs';
import { extractAny } from './extract.mjs';
import { extractFacts } from './facts.mjs';

test('claudeLaunch tells the user\'s sessions from agent-launched ones', () => {
  const by = (f) => claudeLaunch(f).by;
  assert.equal(by({ entrypoint: 'cli', humanOrigin: true }), 'user');                                   // terminal
  assert.equal(by({ entrypoint: 'sdk-cli', humanOrigin: true }), 'user');                               // phone / Remote Control
  assert.equal(by({ entrypoint: 'cli', humanOrigin: true, agentSetting: 'claude', agentName: 'map' }), 'user');   // agents view
  assert.equal(by({ entrypoint: 'sdk-cli', humanOrigin: false }), 'agent');                             // claude -p
  assert.equal(by({ entrypoint: 'cli', humanOrigin: true, agentSetting: 'duty' }), 'agent');            // timer-run named agent
  assert.equal(by({ entrypoint: 'cli', humanOrigin: true, agentName: 'TASK-12 invoices' }), 'agent');   // claude --bg -n
});

test('codexLaunch drops delegated and spawned threads', () => {
  assert.equal(codexLaunch({ originator: 'codex_exec' }).by, 'agent');
  assert.equal(codexLaunch({ originator: 'codex_cli_rs', source: { subagent: { thread_spawn: {} } } }).by, 'agent');
  assert.equal(codexLaunch({ originator: 'codex_chatgpt_android_remote' }).by, 'user');
  assert.equal(codexLaunch({ originator: 'codex_chatgpt_android_remote', thread_source: 'agent_created_thread' }).by, 'agent');
  assert.equal(codexLaunch({ originator: 'codex_cli_rs', thread_source: 'subagent' }).how, 'codex-subagent');
  assert.equal(codexLaunch({ originator: 'codex_cli_rs', source: 'cli' }).by, 'user');
});

test('the opening brief of an agent-launched session is not the user\'s turn; later turns are', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-'));
  const file = path.join(dir, 's.jsonl');
  const user = (text, ts) => ({ type: 'user', entrypoint: 'cli', origin: { kind: 'human' }, timestamp: ts, uuid: ts, message: { role: 'user', content: text } });
  const agent = (text, ts) => ({ type: 'assistant', timestamp: ts, uuid: `a${ts}`, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const lines = [
    { type: 'agent-name', agentName: 'TASK-1 task' },
    user('Ты фоновая сессия: сделай TASK-1 по спеке, отчёт в карточку.', '2026-11-17T10:00:00Z'),
    agent('Сделал половину. Вариант 1 или 2?', '2026-11-17T10:05:00Z'),
    user('давай второй, не трогай прод', '2026-11-17T10:30:00Z'),
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n' + ' '.repeat(2048));
  const { pairs, stats } = await pairsFromClaude(file, { keepOrphans: true });
  assert.equal(stats.launchedBy, 'agent');
  assert.equal(stats.humanTurns, 1);
  assert.deepEqual(pairs.map((p) => p.kind), ['brief', 'turn']);
  const slice = extractAny(file);
  assert.equal(slice.launchedBy, 'agent');
  assert.deepEqual(slice.userTurns.map((t) => t.text), ['давай второй, не трогай прод']);
  assert.deepEqual(slice.agentPrompts.map((t) => t.speaker), ['brief']);
  assert.deepEqual(extractFacts(file).items.filter((i) => /user|brief/.test(i.k)).map((i) => i.k), ['brief', 'user']);
});

test('a Codex rollout slices like a Claude session, delegated briefs apart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-'));
  const write = (name, meta, items) => {
    const file = path.join(dir, name);
    const lines = [{ timestamp: '2026-11-17T10:00:00Z', ordinal: 0, type: 'session_meta', payload: { id: name, cwd: '/w', ...meta } },
      ...items.map(([ts, item]) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'item_completed', item } }))];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  };
  const items = [
    ['2026-11-17T10:00:00Z', { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'почини сборку' }] }],
    ['2026-11-17T10:01:00Z', { type: 'CommandExecution', id: 'c1', command: ['/bin/bash', '-c', 'npm run build'], exit_code: 1, aggregated_output: 'error: x' }],
    ['2026-11-17T10:02:00Z', { type: 'FileChange', id: 'f1', changes: { '/w/a.ts': {} } }],
    ['2026-11-17T10:03:00Z', { type: 'UserMessage', id: 'u2', content: [{ type: 'text', text: 'нет, не так' }] }],
  ];
  const own = extractAny(write('rollout-own.jsonl', { originator: 'codex_cli_rs' }, items));
  assert.equal(own.source, 'codex'); assert.equal(own.launchedBy, 'user');
  assert.equal(own.metrics.userTurns, 2); assert.equal(own.metrics.errors, 1);
  assert.deepEqual(own.filesTouched.map((f) => f.key), ['/w/a.ts']);
  const exec = extractAny(write('rollout-exec.jsonl', { originator: 'codex_exec' }, items));
  assert.deepEqual([exec.metrics.userTurns, exec.agentPrompts[0].speaker], [1, 'brief']);
});
