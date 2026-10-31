// The engine both shells share: matching, folding, script answers, the mod result shape.
// Run: node --test project-hooks/test/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fold, mergeModResult, normalPath, runEvent, scriptOutput, select, toModResult } from '../template/hooks/engine.mjs';

const io = (over = {}) => ({
  root: 'C:/proj', platform: 'win32', home: 'C:/Users/x', codex: false,
  log: () => {}, bash: async () => 'C:/Git/bin/bash.exe',
  run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  ...over,
});

test('select keeps table order, the matcher and the codex flag', () => {
  const hooks = [
    { name: 'a', event: 'PreToolUse', matcher: /^Read$/ },
    { name: 'b', event: ['PreToolUse', 'PostToolUse'] },
    { name: 'c', event: 'PreToolUse', codex: false },
  ];
  assert.deepEqual(select(hooks, 'PreToolUse', { tool_name: 'Read' }).map((h) => h.name), ['a', 'b', 'c']);
  assert.deepEqual(select(hooks, 'PreToolUse', { tool_name: 'Bash' }).map((h) => h.name), ['b', 'c']);
  assert.deepEqual(select(hooks, 'PreToolUse', { tool_name: 'Read' }, { codex: true }).map((h) => h.name), ['a', 'b']);
});

test('SessionStart matches its source, startup when none', () => {
  const hooks = [{ name: 'compact-only', event: 'SessionStart', matcher: /^compact$/ }];
  assert.equal(select(hooks, 'SessionStart', {}).length, 0);
  assert.equal(select(hooks, 'SessionStart', { source: 'compact' }).length, 1);
});

test('a script exiting 2 denies a tool call and blocks any other event', () => {
  const r = { exitCode: 2, stdout: '', stderr: 'nope\n' };
  assert.equal(scriptOutput('PreToolUse', r).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(scriptOutput('PreToolUse', r).hookSpecificOutput.permissionDecisionReason, 'nope');
  assert.deepEqual(scriptOutput('Stop', r), { decision: 'block', reason: 'nope' });
});

test('script stdout: JSON as it is, text as context, other exits nothing', () => {
  assert.deepEqual(scriptOutput('Stop', { exitCode: 0, stdout: '{"decision":"block","reason":"r"}', stderr: '' }), { decision: 'block', reason: 'r' });
  assert.equal(scriptOutput('SessionStart', { exitCode: 0, stdout: 'hello\n', stderr: '' }).hookSpecificOutput.additionalContext, 'hello');
  assert.equal(scriptOutput('SessionStart', { exitCode: 1, stdout: 'x', stderr: 'boom' }), null);
});

test('fold: deny beats ask beats allow, contexts and block reasons join', () => {
  const pre = fold('PreToolUse', [
    { hookSpecificOutput: { permissionDecision: 'allow' } },
    { hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'sure?', additionalContext: 'c1' } },
    { hookSpecificOutput: { additionalContext: 'c2' } },
  ]);
  assert.equal(pre.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(pre.hookSpecificOutput.additionalContext, 'c1\n\nc2');
  const stop = fold('Stop', [{ decision: 'block', reason: 'a' }, null, { decision: 'block', reason: 'b' }]);
  assert.deepEqual(stop, { decision: 'block', reason: 'a\n\nb' });
  assert.equal(fold('Stop', [null, undefined]), null);
});

test('toModResult maps a classic answer onto the mod result fields', () => {
  assert.deepEqual(toModResult('PreToolUse', { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'no' } }), { deny: 'no' });
  assert.deepEqual(toModResult('SessionStart', { hookSpecificOutput: { additionalContext: 'ctx' } }), { additionalContext: ['ctx'] });
  assert.deepEqual(toModResult('Stop', { decision: 'block', reason: 'more' }), { block: 'more' });
  assert.equal(toModResult('Stop', null), null);
});

test('mergeModResult keeps the hooks beneath and adds ours', () => {
  const merged = mergeModResult({ additionalContext: ['theirs'], block: 'a' }, { additionalContext: ['ours'], block: 'b' });
  assert.deepEqual(merged, { additionalContext: ['theirs', 'ours'], block: 'a\n\nb' });
  assert.deepEqual(mergeModResult({ x: 1 }, null), { x: 1 });
});

test('runEvent: PreToolUse stops at the first deny, a throwing hook is skipped', async () => {
  const ran = [];
  const hooks = [
    { name: 'boom', event: 'PreToolUse', run: () => { throw new Error('x'); } },
    { name: 'deny', event: 'PreToolUse', run: () => { ran.push('deny'); return { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'r' } }; } },
    { name: 'late', event: 'PreToolUse', run: () => { ran.push('late'); return 'never'; } },
  ];
  const logged = [];
  const out = await runEvent(hooks, 'PreToolUse', { tool_name: 'Read' }, io({ log: (l) => logged.push(l) }));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(ran, ['deny']);
  assert.match(logged[0], /^boom: x/);
});

test('runEvent: `when` false starts no script; a script gets ${root}, Git Bash, stdin and env', async () => {
  const calls = [];
  const run = async (argv, init) => {
    calls.push({ argv, init });
    return { exitCode: 0, stdout: 'ok', stderr: '' };
  };
  const hooks = [
    { name: 'gated', event: 'Stop', when: () => false, script: ['node', 'x'] },
    { name: 'sh', event: 'Stop', script: ['bash', '${root}/a.sh'] },
  ];
  const out = await runEvent(hooks, 'Stop', { session_id: 's' }, io({ run, codex: true }));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['C:/Git/bin/bash.exe', 'C:/proj/a.sh']);
  assert.deepEqual(JSON.parse(calls[0].init.stdin), { session_id: 's' });
  assert.deepEqual(calls[0].init.env, { CLAUDE_PROJECT_DIR: 'C:/proj', CODEX_COMPAT: '1' });
  assert.equal(out.hookSpecificOutput.additionalContext, 'ok'); // plain stdout is context, Stop included
});

test('normalPath gives one spelling on Windows and leaves other paths alone', () => {
  assert.equal(normalPath('c:\\a\\b', 'win32'), 'C:/a/b');
  assert.equal(normalPath('/c/a/b', 'win32'), 'C:/a/b');
  assert.equal(normalPath('/c', 'win32'), 'C:/');
  assert.equal(normalPath('/Users/x', 'darwin'), '/Users/x');
});
