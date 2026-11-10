import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readModelPlan, resolveModels } from '../payload/skills/chat-audit/lib/models.mjs';

test('a global install needs no project config and never inherits the main model', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-models-'));
  try {
    const plan = readModelPlan(root);
    assert.equal(plan.config, null);
    assert.equal(plan.orchestrator, 'keep-current');
    assert.equal(plan.phases.lens.model, 'sonnet');
    assert.equal(plan.phases.free_reader.model, 'sonnet');
    assert.equal(plan.phases.memory.model, 'sonnet');
    assert.equal(plan.phases.critic.model, 'opus');
    assert.equal(plan.phases.synthesis.model, 'claude-fable-5-2');
    for (const phase of Object.values(plan.phases)) {
      assert.equal(phase.effort, 'high');
      assert.match(phase.description, /^escalate: chat-audit /);
    }
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('legacy reader settings do not promote every audit phase to that model', () => {
  const phases = resolveModels({ agent_model: 'haiku', models: { memory: { effort: 'medium' } } });
  assert.equal(phases.lens.model, 'haiku');
  assert.equal(phases.free_reader.model, 'haiku');
  assert.equal(phases.memory.model, 'haiku');
  assert.equal(phases.memory.effort, 'medium');
  assert.equal(phases.critic.model, 'opus');
  assert.equal(phases.synthesis.model, 'claude-fable-5-2');
});

test('the project can override one phase without changing the other phases', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-models-'));
  try {
    fs.mkdirSync(path.join(root, '.claude'));
    const file = path.join(root, '.claude', 'chat-audit.config.json');
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ models: { synthesis: { model: 'opus', effort: 'xhigh' } } }));
    const plan = readModelPlan(root);
    assert.equal(plan.config, file);
    assert.equal(plan.phases.synthesis.model, 'opus');
    assert.equal(plan.phases.synthesis.effort, 'xhigh');
    assert.equal(plan.phases.lens.model, 'sonnet');
    fs.writeFileSync(file, '{broken');
    assert.throws(() => readModelPlan(root), /Cannot read audit config/);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('bad model settings fail instead of silently changing the approved budget', () => {
  for (const config of [
    { agent_model: '' }, { models: [] }, { models: { synthesys: {} } },
    { models: { lens: { model: 'inherit' } } }, { models: { synthesis: { model: null } } },
    { models: { synthesis: { effort: 'extreme' } } }, { models: { critic: { typo: 'opus' } } },
  ]) assert.throws(() => resolveModels(config));
  const script = fileURLToPath(new URL('../payload/skills/chat-audit/lib/models.mjs', import.meta.url));
  assert.equal(spawnSync(process.execPath, [script, '--unknown'], { encoding: 'utf8' }).status, 1);
});
