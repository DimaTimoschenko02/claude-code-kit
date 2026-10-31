// The Codex side: payload translation, answer mapping, the runner end to end, the generated .codex/hooks.json.
// Run: node --test project-hooks/test/
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { codexGroups, install, mergeCodexHooks } from '../bin/project-hooks.mjs';
import { claudeInputs, codexOutput } from '../template/node/codex.mjs';

test('apply_patch becomes one Write or Edit per file, relative paths under cwd', () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: notes/new.md',
    '+hello',
    '*** Update File: C:/proj/old.md',
    '-was',
    '+is',
    '*** End Patch',
  ].join('\n');
  const inputs = claudeInputs({ tool_name: 'apply_patch', cwd: 'C:/proj', tool_input: { command: patch } });
  assert.deepEqual(inputs.map((i) => [i.tool_name, i.tool_input.file_path]), [['Write', 'C:/proj/notes/new.md'], ['Edit', 'C:/proj/old.md']]);
  assert.equal(inputs[0].tool_input.content, 'hello\n');
  assert.deepEqual([inputs[1].tool_input.old_string, inputs[1].tool_input.new_string], ['was\n', 'is\n']);
});

test('shell calls become Bash with tool_input.command; workdir becomes cwd', () => {
  const [a] = claudeInputs({ tool_name: 'exec_command', tool_input: { cmd: 'ls', workdir: 'C:/w' } });
  assert.deepEqual([a.tool_name, a.tool_input.command, a.cwd], ['Bash', 'ls', 'C:/w']);
  const [b] = claudeInputs({ tool_name: 'shell', tool_input: { command: ['echo', 'a b'] } });
  assert.equal(b.tool_input.command, "echo 'a b'");
  const [c] = claudeInputs({ tool_name: 'Read', tool_input: { file_path: 'x' } });
  assert.equal(c.tool_name, 'Read');
});

test('Codex has no ask: an ask denies; a shell rewrite goes back in its own key', () => {
  const ask = codexOutput('PreToolUse', { hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'sure?' } }, { tool_name: 'Bash' });
  assert.equal(ask.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(ask.hookSpecificOutput.permissionDecisionReason, /sure\?$/);
  const rewrite = codexOutput('PreToolUse', { hookSpecificOutput: { updatedInput: { command: 'ls -a' } } },
    { tool_name: 'exec_command', tool_input: { cmd: 'ls', workdir: 'w' } });
  assert.deepEqual(rewrite.hookSpecificOutput.updatedInput, { cmd: 'ls -a', workdir: 'w' });
  const patch = codexOutput('PreToolUse', { hookSpecificOutput: { updatedInput: { file_path: 'x' } } },
    { tool_name: 'apply_patch', tool_input: { command: '*** Add File: x\n+a' } });
  assert.equal(patch.hookSpecificOutput.updatedInput, undefined);
});

const TABLE = `export const HOOKS = [
  { name: 'no-secret', event: 'PreToolUse', matcher: /^(Read|Edit|Write)$/,
    run: (i) => String(i.tool_input?.file_path ?? '').includes('secret')
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'secret' } } : null },
  { name: 'claude-only', event: 'SessionStart', codex: false, run: () => 'claude' },
  { name: 'both', event: ['SessionStart', 'Stop'], run: (i, io) => (io.codex ? 'codex' : 'any') },
  { name: 'notify', event: 'Notification', run: () => null },
];
`;

function project() {
  const root = mkdtempSync(join(tmpdir(), 'ph-'));
  return root;
}

test('install lays the shells, keeps the table, writes the Codex groups beside other hooks', async () => {
  const root = project();
  await install(root, { name: 'p-hooks' });
  const dir = join(root, '.claude/skills/project-hooks');
  writeFileSync(join(dir, 'core/index.mjs'), TABLE);
  mkdirSync(join(root, '.codex'), { recursive: true });
  writeFileSync(join(root, '.codex/hooks.json'), JSON.stringify({ description: 'mine', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }] } }));
  await install(root, { name: 'p-hooks' });
  assert.equal(readFileSync(join(dir, 'core/index.mjs'), 'utf8'), TABLE, 'the table is the project\'s own');
  assert.match(readFileSync(join(dir, '.claude-plugin/plugin.json'), 'utf8'), /"p-hooks"/);
  const codex = JSON.parse(readFileSync(join(root, '.codex/hooks.json'), 'utf8'));
  assert.equal(codex.description, 'mine');
  assert.deepEqual(Object.keys(codex.hooks).sort(), ['PreToolUse', 'SessionStart', 'Stop']);
  assert.equal(codex.hooks.Stop.length, 2, 'their Stop hook stays, ours is added');
  assert.equal(codex.hooks.PreToolUse[0].matcher, undefined, 'tool rows match after translation, in the runner');
  assert.equal(codex.hooks.PreToolUse[0].hooks[0].commandWindows, 'node .claude/skills/project-hooks/node/runner.mjs PreToolUse --codex');
  await install(root, { name: 'p-hooks' });
  assert.equal(JSON.parse(readFileSync(join(root, '.codex/hooks.json'), 'utf8')).hooks.Stop.length, 2, 'a second install replaces ours');
});

test('install creates no Codex file for a Claude-only table, keeps a right one byte for byte, never writes over a broken one', async () => {
  const root = project();
  await install(root);
  writeFileSync(join(root, '.claude/skills/project-hooks/core/index.mjs'), "export const HOOKS = [{ name: 'c', event: 'Stop', codex: false, run: () => null }];\n");
  rmSync(join(root, '.codex'), { recursive: true, force: true });
  await install(root);
  assert.equal(existsSync(join(root, '.codex')), false, 'a Claude-only table writes no Codex file');
  mkdirSync(join(root, '.codex'));
  const theirs = '\uFEFF{\r\n  "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "echo theirs" } ] } ] }\r\n}\r\n';
  writeFileSync(join(root, '.codex/hooks.json'), theirs);
  await install(root);
  assert.equal(readFileSync(join(root, '.codex/hooks.json'), 'utf8'), theirs, 'nothing of ours to add: their file stays as it was');
  writeFileSync(join(root, '.codex/hooks.json'), '{ broken');
  await assert.rejects(install(root), /does not parse/);
  assert.equal(readFileSync(join(root, '.codex/hooks.json'), 'utf8'), '{ broken');
});

test('the runner answers as a command hook, and translates under --codex', async () => {
  const root = project();
  await install(root);
  writeFileSync(join(root, '.claude/skills/project-hooks/core/index.mjs'), TABLE);
  const runner = join(root, '.claude/skills/project-hooks/node/runner.mjs');
  const run = (args, input) => execFileSync(process.execPath, [runner, ...args], { input: JSON.stringify(input), encoding: 'utf8' }).trim();
  assert.equal(JSON.parse(run(['PreToolUse'], { tool_name: 'Read', tool_input: { file_path: 'a/secret.txt' } })).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run(['PreToolUse'], { tool_name: 'Read', tool_input: { file_path: 'ok.txt' } }), '');
  const patch = { tool_name: 'apply_patch', cwd: root, tool_input: { command: '*** Begin Patch\n*** Add File: ok.md\n+a\n*** Update File: secret.md\n+b\n*** End Patch' } };
  assert.equal(JSON.parse(run(['PreToolUse', '--codex'], patch)).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(JSON.parse(run(['SessionStart'], {})).hookSpecificOutput.additionalContext, 'claude\n\nany');
  assert.equal(JSON.parse(run(['SessionStart', '--codex'], {})).hookSpecificOutput.additionalContext, 'codex');
});

test('codexGroups: no matcher when a row has none, none for events Codex ignores matchers on', () => {
  const groups = codexGroups([
    { name: 'a', event: 'PostToolUse', matcher: /^Skill$/ },
    { name: 'b', event: 'PostToolUse' },
    { name: 'c', event: 'UserPromptSubmit', matcher: /x/ },
    { name: 'd', event: 'SessionEnd' },
    { name: 'e', event: 'SessionStart', matcher: /^(startup|clear)$/ },
    { name: 'f', event: 'SubagentStart', matcher: /^x$/i },
  ]);
  assert.equal(groups.SessionStart[0].matcher, '^(startup|clear)$');
  assert.equal(groups.SubagentStart[0].matcher, undefined, 'a flag Codex cannot carry widens to all');
  assert.equal(groups.PostToolUse[0].matcher, undefined);
  assert.equal(groups.UserPromptSubmit[0].matcher, undefined);
  assert.equal(groups.SessionEnd[0].hooks[0].timeout, 3);
  assert.deepEqual(mergeCodexHooks(null, {}), { hooks: {} });
});
