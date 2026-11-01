// bin/kit-links.mjs against a throwaway kit, project and home. Run: node --test tests/kit-links.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { linkedPaths, report, run } from '../bin/kit-links.mjs';

const GITIGNORE = [
  'node_modules',
  '# >>> spec-writer --link >>>',
  '.claude/skills/spec-writer',
  '.claude/agents/spec-builder-check.md',
  '# <<< spec-writer --link <<<',
  '# >>> chat-audit --link >>>',
  '.claude/skills/chat-audit',
  '# <<< chat-audit --link <<<',
  '.claude/skills/devops',
].join('\r\n');

function world() {
  const base = mkdtempSync(join(tmpdir(), 'kit-links-'));
  const kit = join(base, 'kit');
  mkdirSync(join(kit, 'spec-writer/payload/skills/spec-writer/scripts'), { recursive: true });
  writeFileSync(join(kit, 'spec-writer/payload/skills/spec-writer/scripts/spec-lint.mjs'), '');
  mkdirSync(join(kit, 'spec-writer/payload/agents'), { recursive: true });
  writeFileSync(join(kit, 'spec-writer/payload/agents/spec-builder-check.md'), '');
  mkdirSync(join(kit, 'chat-audit/payload/skills/chat-audit'), { recursive: true });
  const project = join(base, 'proj');
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(join(project, '.gitignore'), GITIGNORE);
  const home = join(base, 'home');
  mkdirSync(join(home, '.claude/skills'), { recursive: true });
  return { kit, project, home };
}

test('the link list is the --link blocks of .gitignore, CRLF or not; a path outside a block is not the kit\'s', () => {
  assert.deepEqual(linkedPaths(GITIGNORE), [
    { pkg: 'spec-writer', path: '.claude/skills/spec-writer' },
    { pkg: 'spec-writer', path: '.claude/agents/spec-builder-check.md' },
    { pkg: 'chat-audit', path: '.claude/skills/chat-audit' },
  ]);
});

test('a machine that got the marker but no links (the ProArt case): reported, --fix links them, the next check is clean', () => {
  const w = world();
  const before = run({ project: w.project, kit: w.kit, home: w.home });
  assert.deepEqual(before.map((i) => i.state), ['missing', 'missing', 'missing']);
  const r = report(before, { project: w.project, quiet: true });
  assert.equal(r.ok, false);
  assert.match(r.lines.join('\n'), /\.claude\/skills\/spec-writer — missing[\s\S]*3 of 3 not resolving/);

  const fixed = run({ project: w.project, kit: w.kit, home: w.home, fix: true });
  assert.deepEqual(fixed.map((i) => i.state), ['fixed', 'fixed', 'fixed']);
  assert.ok(lstatSync(join(w.project, '.claude/skills/spec-writer')).isSymbolicLink());
  const after = run({ project: w.project, kit: w.kit, home: w.home });
  assert.deepEqual(after.map((i) => i.state), ['ok', 'ok', 'ok']);
  assert.deepEqual(report(after, { project: w.project, quiet: true }).lines, [], 'quiet and healthy: prints nothing');
});

test('a skill linked in ~/.claude counts as present and is not linked a second time; --pkg narrows to one package', () => {
  const w = world();
  symlinkSync(join(w.kit, 'chat-audit/payload/skills/chat-audit'), join(w.home, '.claude/skills/chat-audit'), 'dir');
  const items = run({ project: w.project, kit: w.kit, home: w.home, fix: true, pkg: 'chat-audit' });
  assert.deepEqual(items.map((i) => [i.path, i.state]), [['.claude/skills/chat-audit', 'global']]);
  assert.throws(() => lstatSync(join(w.project, '.claude/skills/chat-audit')), 'no project-level duplicate');
});

test('a dead link is replaced; a source the kit lacks is reported, not invented', () => {
  const w = world();
  mkdirSync(join(w.project, '.claude/skills'), { recursive: true });
  const gone = join(w.project, 'gone');
  mkdirSync(gone);
  symlinkSync(gone, join(w.project, '.claude/skills/spec-writer'), 'dir');
  rmSync(gone, { recursive: true });
  rmSync(join(w.kit, 'chat-audit'), { recursive: true });
  const items = run({ project: w.project, kit: w.kit, home: w.home });
  assert.deepEqual(items.map((i) => i.state), ['dangling', 'missing', 'nokit']);
  const fixed = run({ project: w.project, kit: w.kit, home: w.home, fix: true });
  assert.deepEqual(fixed.map((i) => i.state), ['fixed', 'fixed', 'nokit']);
  assert.equal(report(fixed, { project: w.project }).ok, false, 'nokit stays a problem');
});

test('CLI: exit 1 and one line per missing link; exit 0 and a summary when healthy', () => {
  const cli = fileURLToPath(new URL('../bin/kit-links.mjs', import.meta.url));
  const empty = mkdtempSync(join(tmpdir(), 'kit-links-cli-'));
  writeFileSync(join(empty, '.gitignore'), '# >>> nopkg-xyz --link >>>\n.claude/skills/nopkg-xyz\n# <<< nopkg-xyz --link <<<\n');
  let rc = 0;
  let out = '';
  try { execFileSync(process.execPath, [cli, empty], { encoding: 'utf8' }); } catch (e) { rc = e.status; out = e.stdout; }
  assert.equal(rc, 1);
  assert.match(out, /\.claude\/skills\/nopkg-xyz — the kit has no source for it/);
  writeFileSync(join(empty, '.gitignore'), 'x\n');
  assert.match(execFileSync(process.execPath, [cli, empty], { encoding: 'utf8' }), /no --link block/);
});
