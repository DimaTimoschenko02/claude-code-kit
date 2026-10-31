// check refuses a table whose imports Claude Code cannot load: outside the mod folder, missing, or untracked by git.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { check, install } from '../bin/project-hooks.mjs';

async function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'ph-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await install(root, { name: 'p-hooks' });
  const core = join(root, '.claude', 'skills', 'project-hooks', 'core');
  const table = (imports) => writeFileSync(join(core, 'index.mjs'), `${imports}\nexport const HOOKS = [];\n`);
  return { root, core, table };
}

test('a table importing inside the mod passes; outside the folder or a missing file fails', async (t) => {
  const { root, core, table } = await project(t);
  writeFileSync(join(core, 'rows.mjs'), 'export const rows = 1;\n');
  table("import { rows } from './rows.mjs';");
  assert.deepEqual(await check(root), []);

  mkdirSync(join(root, '.claude', 'lib'), { recursive: true });
  writeFileSync(join(root, '.claude', 'lib', 'shared.mjs'), 'export const shared = 1;\n');
  writeFileSync(join(core, 'rows.mjs'), "export { shared as rows } from '../../../lib/shared.mjs';\n");
  assert.match((await check(root)).join('\n'), /rows\.mjs imports \.\.\/\.\.\/\.\.\/lib\/shared\.mjs: outside the mod folder/);

  table("/** @typedef {import('../hooks/contract').Hook} Hook */\n// import { x } from './gone.mjs';\nconst lazy = () => import('./later.mjs');");
  assert.match((await check(root)).join('\n'), /index\.mjs imports \.\/later\.mjs: no such file/);
});

test('in a git work tree a file the table imports but git does not track fails', async (t) => {
  const { root, core, table } = await project(t);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  table("import { rows } from './rows.mjs';");
  writeFileSync(join(core, 'rows.mjs'), 'export const rows = 1;\n');
  git('add', '-A');
  git('rm', '-q', '--cached', '.claude/skills/project-hooks/core/rows.mjs');
  assert.match((await check(root)).join('\n'), /core\/rows\.mjs: not tracked by git/);
  git('add', '.claude/skills/project-hooks/core/rows.mjs');
  assert.deepEqual(await check(root), []);
});
