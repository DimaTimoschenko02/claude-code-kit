// The table's invariants, the same in every project.
// Run: node --test .claude/skills/project-hooks/test/
// Copied from claude-code-kit/project-hooks: change the kit, then `project-hooks install`, not this copy.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import * as table from '../core/index.mjs';
import { ROOT } from '../node/runner.mjs';

const { HOOKS } = table;
/** Command hooks the table keeps in settings on purpose, each with its reason: `[{ command: /re/, why }]`. */
const KEPT = table.KEPT_COMMAND_HOOKS ?? [];

test('every row has a unique name, one event or more, a run or a script, and its script exists', () => {
  const names = HOOKS.map((h) => h.name);
  assert.equal(new Set(names).size, names.length, `duplicate names: ${names}`);
  for (const h of HOOKS) {
    assert.ok([h.event].flat().length, `${h.name}: no event`);
    assert.ok(Boolean(h.run) !== Boolean(h.script), `${h.name}: needs exactly one of run and script`);
    const file = h.script?.find((a) => String(a).includes('${root}'));
    if (file) assert.ok(existsSync(file.replace('${root}', ROOT)), `${h.name}: ${file} is missing`);
  }
});

test('.claude/settings*.json has no command hooks but the kept ones: the mod runs the table, a hook left there runs twice', () => {
  for (const k of KEPT) assert.ok(k.command instanceof RegExp && String(k.why ?? '').trim(), `kept hook ${k.command}: needs a regexp and a why`);
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = join(ROOT, '.claude', name);
    if (!existsSync(file)) continue;
    const groups = Object.values(JSON.parse(readFileSync(file, 'utf8')).hooks ?? {}).flat();
    const commands = groups.flatMap((g) => g.hooks ?? []).filter((h) => h.type === 'command').map((h) => String(h.command));
    const left = commands.filter((c) => !KEPT.some((k) => k.command.test(c)));
    assert.deepEqual(left, [], `${name}: move these into core/index.mjs, or keep one in KEPT_COMMAND_HOOKS with its why`);
  }
});

// Claude Code skips the whole mod, silently, when one of its files imports from outside the plugin dir: every hook of
// the project goes off and nothing says so. node resolves such an import fine, so only this test catches it.
test('every relative import of the mod stays inside the plugin dir', () => {
  const plugin = join(import.meta.dirname, '..');
  const escapes = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (!['node', 'test', 'node_modules'].includes(entry.name)) walk(path); continue; }
      if (!/\.(m?js|ts)$/.test(entry.name)) continue;
      for (const m of readFileSync(path, 'utf8').matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]|\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = resolve(dirname(path), m[1] ?? m[2]);
        if (relative(plugin, target).startsWith('..')) escapes.push(`${relative(plugin, path)} → ${m[1] ?? m[2]}`);
      }
    }
  };
  walk(plugin);
  assert.deepEqual(escapes, [], 'copy what the mod needs into it (core/ports/vendor/) instead of importing it');
});
