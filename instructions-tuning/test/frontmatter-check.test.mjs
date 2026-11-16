// frontmatter-check.mjs — the instructions-tuning skill's PostToolUse hook on SKILL.md and agent definitions — and the
// hook command in the skill's own frontmatter that starts it.
// Cases are what the first sweep over real skills and agents found: an installer marker comment above `---` (the skill
// never lists), an unquoted `: ` in a one-line description (Claude Code reads it, so no finding), prompt files under a
// skill's own `agents/` (not agent definitions), and descriptions over 1024 on a skill versus an agent. The second
// half is the class this port closed: a hook that exits 0 when its runtime or script is missing says «fine» about
// files it never read.
// Run from the kit root: node --test instructions-tuning/test/frontmatter-check.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', 'payload', 'skills', 'instructions-tuning');
const SCRIPT = join(SKILL, 'scripts', 'frontmatter-check.mjs');
const yaml = createRequire(import.meta.url)(join(SKILL, 'scripts', 'vendor', 'js-yaml.min.cjs'));

const root = mkdtempSync(join(tmpdir(), 'fm-check-'));
after(() => rmSync(root, { recursive: true, force: true }));

function write(rel, text) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}
const payload = (path) => JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path } });
const hook = (path) => spawnSync(process.execPath, [SCRIPT], { input: payload(path), encoding: 'utf8' });
const good = (name = 'demo') => `---\nname: ${name}\ndescription: Use when the user asks for a demo.\n---\nbody\n`;

test('a good skill passes', () => {
  assert.equal(hook(write('skills/demo/SKILL.md', good())).status, 0);
});

test('a marker comment above the frontmatter fails: the skill would never list', () => {
  const r = hook(write('skills/marker/SKILL.md', '<!-- managed -->\n---\nname: demo\ndescription: Use when asked.\n---\nbody\n'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no frontmatter/);
});

test('an unquoted `: ` inside a one-line description passes: Claude Code reads it as a string', () => {
  const r = hook(write('agents/builder.md', '---\nname: builder\ndescription: Builds mods, above all mid-task: hand it the words.\nmodel: opus\n---\nbody\n'));
  assert.equal(r.status, 0, r.stderr);
});

test('a CRLF file with such a value passes too', () => {
  const r = hook(write('skills/crlf/SKILL.md', '---\r\nname: demo\r\ndescription: Use when: asked.\r\n---\r\nbody\r\n'));
  assert.equal(r.status, 0, r.stderr);
});

test('a hooks block with broken indentation fails as invalid YAML', () => {
  const r = hook(write('agents/broken.md', '---\nname: builder\ndescription: Builds mods.\nhooks:\n  Stop:\n   - hooks:\n  - type: x\n---\n'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not valid YAML/);
});

test('an agent without description and with a bad name reports both', () => {
  const r = hook(write('agents/x.md', '---\nname: Bad Name\n---\nbody\n'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no `description`/);
  assert.match(r.stderr, /lowercase/);
});

test('an agent definition needs a name', () => {
  const r = hook(write('agents/nameless.md', '---\ndescription: Does things.\n---\n'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no `name`/);
});

test('a description over 1024 fails on a skill only, counted in characters not UTF-16 units', () => {
  const long = `Use when ${'x'.repeat(1100)}`;
  assert.equal(hook(write('skills/long/SKILL.md', `---\nname: demo\ndescription: ${long}\n---\n`)).status, 2);
  assert.equal(hook(write('agents/long.md', `---\nname: demo\ndescription: ${long}\n---\n`)).status, 0);
  // 900 emoji = 1800 UTF-16 units but 900 characters: under the limit
  assert.equal(hook(write('skills/emoji/SKILL.md', `---\nname: demo\ndescription: "${'😀'.repeat(900)}"\n---\n`)).status, 0);
  assert.equal(hook(write('skills/exact/SKILL.md', `---\nname: demo\ndescription: ${'ж'.repeat(1024)}\n---\n`)).status, 0);
  assert.equal(hook(write('skills/over/SKILL.md', `---\nname: demo\ndescription: ${'ж'.repeat(1025)}\n---\n`)).status, 2);
});

test('a duplicate key is not an error, a non-map and a non-string description are', () => {
  assert.equal(hook(write('skills/dup/SKILL.md', '---\nname: a\nname: b\ndescription: x\n---\n')).status, 0);
  assert.match(hook(write('skills/list/SKILL.md', '---\n- a\n- b\n---\n')).stderr, /not a key: value map/);
  assert.match(hook(write('skills/num/SKILL.md', '---\nname: demo\ndescription: 5\n---\n')).stderr, /not a string/);
});

test('a prompt file under a skill\'s own agents/ is not an agent definition', () => {
  write('skills/creator/SKILL.md', '---\nname: creator\ndescription: Use when.\n---\n');
  assert.equal(hook(write('skills/creator/agents/grader.md', '# Grader\nNo frontmatter here.\n')).status, 0);
});

test('other files, a missing file, a non-JSON payload and an empty one exit 0 at once', () => {
  assert.equal(hook(write('notes/readme.md', 'no frontmatter\n')).status, 0);
  assert.equal(hook(join(root, 'skills/ghost/SKILL.md')).status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT], { input: 'not json', encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT], { input: '', encoding: 'utf8' }).status, 0);
});

test('a manual run takes the path as an argument', () => {
  const bad = write('skills/manual/SKILL.md', '---\nname: demo\n---\n');
  const r = spawnSync(process.execPath, [SCRIPT, bad], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no `description`/);
  assert.equal(spawnSync(process.execPath, [SCRIPT, join(root, 'skills/demo/SKILL.md')], { encoding: 'utf8' }).status, 0);
});

// --- the hook command from the skill's own frontmatter: what runs on a real machine, node or no node ---

const frontmatter = yaml.load(/^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(SKILL, 'SKILL.md'), 'utf8'))[1]);
const COMMAND = frontmatter.hooks.PostToolUse[0].hooks[0].command;

/** Runs the skill's hook command in a fresh $HOME that holds the scripts (unless `scripts: false`) and a PATH of `path`. */
function runCommand(file, { scripts = true, path = process.env.PATH } = {}) {
  const home = mkdtempSync(join(root, 'home-'));
  const project = mkdtempSync(join(root, 'proj-'));
  if (scripts) cpSync(join(SKILL, 'scripts'), join(home, '.claude', 'skills', 'instructions-tuning', 'scripts'), { recursive: true });
  const bash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim() || 'bash';
  return spawnSync(bash, ['-c', COMMAND], {
    input: payload(file), encoding: 'utf8',
    env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: project, PATH: path },
  });
}

/** A PATH holding bash's `cat` and nothing else: no node, no ruby, no python. */
function bareBin() {
  const dir = mkdtempSync(join(root, 'bin-'));
  const cat = spawnSync('bash', ['-c', 'command -v cat'], { encoding: 'utf8' }).stdout.trim();
  try { symlinkSync(cat, join(dir, 'cat')); } catch { copyFileSync(cat, join(dir, 'cat')); }
  return dir;
}

test('hook command: a broken SKILL.md reaches the model as exit 2 with the problem', () => {
  const r = runCommand(write('skills/cmd-bad/SKILL.md', '---\nname: demo\n---\n'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no `description`/);
});

test('hook command: a good SKILL.md and an unrelated file pass', () => {
  assert.equal(runCommand(write('skills/cmd-good/SKILL.md', good())).status, 0);
  const r = runCommand(write('notes/cmd.md', '# notes\n'));
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

test('hook command: no node on PATH is said out loud for a SKILL.md or agent file, not passed', () => {
  const path = bareBin();
  for (const f of ['skills/nonode/SKILL.md', 'agents/nonode.md']) {
    const r = runCommand(write(f, '---\nname: demo\n---\n'), { path });
    assert.equal(r.status, 2, f);
    assert.match(r.stderr, /NOT checked.*node/);
  }
});

test('hook command: no script anywhere is said out loud too', () => {
  const r = runCommand(write('skills/noscript/SKILL.md', good()), { scripts: false });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /NOT checked.*frontmatter-check\.mjs not found/);
});

test('hook command: with no node, an unrelated file is still silent — the noise only where a check was owed', () => {
  const r = runCommand(write('notes/nonode.md', '# notes\n'), { path: bareBin(), scripts: false });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});
