// effect.mjs — change rows from git. Cases are the ones the first real run got wrong (2026-10-03):
// the first snapshot of ~/.claude read as a change of every file; hooks that keep their own log read as dead;
// a skill symlinked into the project came twice; a retired hook was still listed; a recorder hook read as untested; a commit touching two linked skills counted for one. Run: node --test chat-audit/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'effect-git-'));
process.env.HOME = path.join(T, 'home');
const { gitChanges, artifactOf } = await import('../payload/skills/chat-audit/lib/effect.mjs');

const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' });
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const commit = (dir, msg) => { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', msg); return git(dir, 'rev-parse', 'HEAD').toString().trim(); };
const settings = (cmds) => JSON.stringify({ hooks: { Stop: [{ hooks: cmds.map((c) => ({ type: 'command', command: c })) }] } });

const home = path.join(T, 'home/.claude'), kit = path.join(T, 'kit'), proj = path.join(T, 'proj');

// ~/.claude: snapshot first, then two hook edits.
put(`${home}/settings.json`, settings(['bash ~/.claude/hooks/guard.sh', 'bash ~/.claude/hooks/own-log/gate.sh']));
put(`${home}/hooks/guard.sh`, '. _lib/hook-log.sh\nhook_log pass\n');
put(`${home}/hooks/own-log/gate.sh`, 'echo own log >> gate.log\n');
put(`${home}/hooks/own-log/lib.sh`, 'x=1\n');
put(`${home}/CLAUDE.md`, 'rules\n');
git(home, 'init', '-q', '-b', 'main');
commit(home, 'snapshot');
put(`${home}/hooks/guard.sh`, '. _lib/hook-log.sh\nhook_log deny\n');
put(`${home}/hooks/own-log/gate.sh`, 'echo own log v2 >> gate.log\n');
commit(home, 'auto: hooks');

// The kit: a skill linked from ~/.claude and from the project.
put(`${kit}/skills/linked/SKILL.md`, 'v1\n');
put(`${kit}/skills/second/SKILL.md`, 'v1\n');
git(kit, 'init', '-q', '-b', 'main');
commit(kit, 'init');
put(`${kit}/skills/linked/SKILL.md`, 'v2\n');
put(`${kit}/skills/second/SKILL.md`, 'v2\n');
const both = commit(kit, 'one commit, two linked skills');
fs.mkdirSync(`${home}/skills`, { recursive: true });
fs.symlinkSync(`${kit}/skills/linked`, `${home}/skills/linked`);
fs.symlinkSync(`${kit}/skills/second`, `${home}/skills/second`);

// The project: a covered hook, an uncovered one, a retired one, the same linked skill.
put(`${proj}/README.md`, 'p\n');
git(proj, 'init', '-q', '-b', 'main');
commit(proj, 'init');
put(`${proj}/.claude/settings.json`, settings(['bash .claude/hooks/live.sh', 'bash .claude/hooks/other.sh', 'bash .claude/hooks/retired.sh']));
put(`${proj}/.claude/hooks/live.sh`, 'hook_log pass\n');
put(`${proj}/.claude/hooks/other.sh`, 'hook_log pass\n');
put(`${proj}/.claude/hooks/retired.sh`, 'hook_log pass\n');
fs.mkdirSync(`${proj}/.claude/skills`, { recursive: true });
fs.symlinkSync(`${kit}/skills/linked`, `${proj}/.claude/skills/linked`);
const covered = commit(proj, 'hooks + linked skill');
fs.rmSync(`${proj}/.claude/hooks/retired.sh`);
commit(proj, 'retire');

const rows = gitChanges(proj, [{ type: 'change', id: 'C-1', commit: covered.slice(0, 8), ts: new Date().toISOString(), paths: ['.claude/hooks/live.sh'] }], Date.now() - 30 * 86400e3);
const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

test('the first snapshot of a repo is not a change', () => {
  assert.equal(byId['G:~/CLAUDE.md'], undefined);
  assert.equal(byId['G:~/settings.json'], undefined);
});

test('a hook writing the shared hook log is measured on it; one with its own log is unmeasurable, not dead', () => {
  assert.deepEqual(byId['G:~/guard'].signal, { src: 'hooklog:guard', re: '^(deny|block|defer|inject)', want: 'fires' });
  assert.equal(byId['G:~/gate'].signal, null);
  assert.equal(byId['G:~/gate'].note, 'writes no shared hook log');
});

test('a hook that decides nothing by design (a recorder, like bash-write-snapshot) lives by its passes', () => {
  assert.deepEqual(byId['G:other'].signal, { src: 'hooklog:other', re: '^pass', want: 'alive' });
});

test('a skill linked from ~/.claude and the project is one global row, from the target repo', () => {
  assert.equal(byId['G:~/linked'].kind, 'skill');
  assert.equal(byId['G:linked'], undefined);
});

test('one commit touching two linked skills of one repo counts for both', () => {
  assert.equal(byId['G:~/linked'].commit, both.slice(0, 8));
  assert.equal(byId['G:~/second'].commit, both.slice(0, 8));
});

test('a ledger line for the commit replaces the row; a retired hook has none', () => {
  assert.equal(byId['G:live'], undefined);
  assert.equal(byId['G:retired'], undefined);
  assert.equal(byId['G:other'].kind, 'hook');
  assert.deepEqual(Object.keys(byId).sort(), ['G:.claude/settings.json', 'G:other', 'G:~/gate', 'G:~/guard', 'G:~/linked', 'G:~/second']);
});

test('artifactOf: what counts as agent config', () => {
  const wired = new Set(['guard']);
  assert.deepEqual(artifactOf('hooks/guard.sh', wired), { kind: 'hook', name: 'guard' });
  assert.deepEqual(artifactOf('hooks/_lib/hook-log.sh', wired), { kind: 'hook-support', name: 'hooks/_lib' });
  assert.deepEqual(artifactOf('hooks/unwired.sh', wired), { kind: 'hook-support', name: 'hooks/unwired.sh' });
  assert.deepEqual(artifactOf('hooks/stop-point/template.md', wired), { kind: 'hook-support', name: 'hooks/stop-point' });
  assert.equal(artifactOf('hooks/test-block-secrets.sh', wired), null);
  assert.equal(artifactOf('hooks/_retired/x.sh', wired), null);
  assert.equal(artifactOf('skills/synced/b0f/pdf/SKILL.md'), null);
  assert.deepEqual(artifactOf('skills/talk/SKILL.md'), { kind: 'skill', name: 'talk' });
  assert.deepEqual(artifactOf('agents/pricehub-reviewer.md'), { kind: 'agent', name: 'pricehub-reviewer' });
  assert.deepEqual(artifactOf('skill-gate.config.json'), { kind: 'settings', name: 'skill-gate.config.json' });
  assert.deepEqual(artifactOf('memory/feedback_pair-work.md'), { kind: 'memory', name: 'memory/feedback_pair-work.md' });
  assert.equal(artifactOf('memory/project/workspace.md'), null);
  assert.deepEqual(artifactOf('bin/envr'), { kind: 'tool', name: 'envr' });
});

test.after(() => fs.rmSync(T, { recursive: true, force: true }));
