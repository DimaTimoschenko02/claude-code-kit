// The table's invariants, the same in every project.
// Run: node --test .claude/skills/project-hooks/test/
// Copied from claude-code-kit/project-hooks: change the kit, then `project-hooks install`, not this copy.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
