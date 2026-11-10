#!/usr/bin/env node
// Resolve the audit's phase models without scanning transcripts or starting agents.
import fs, { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function resolvePhase(name, fallback, override) {
  if (override !== undefined && (!override || typeof override !== 'object' || Array.isArray(override))) {
    throw new Error(`models.${name} must be an object with model and/or effort`);
  }
  for (const key of Object.keys(override ?? {})) {
    if (key !== 'model' && key !== 'effort') throw new Error(`Unknown models.${name}.${key}`);
  }
  const { model, effort } = { ...fallback, ...override };
  if (typeof model !== 'string' || !model.trim() || model.trim() === 'inherit') {
    throw new Error(`models.${name}.model must name an explicit model, not inherit`);
  }
  if (!EFFORTS.has(effort)) throw new Error(`Invalid models.${name}.effort`);
  return { model: model.trim(), effort, description: `escalate: chat-audit ${name}; approved phase model` };
}

export function resolveModels(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Audit config must be an object');
  const readerModel = config.agent_model ?? 'sonnet';
  const reader = { model: readerModel, effort: 'high' };
  const defaults = {
    lens: reader,
    free_reader: reader,
    memory: reader,
    critic: { model: 'opus', effort: 'high' },
    synthesis: { model: 'claude-fable-5-2', effort: 'high' },
  };
  const overrides = config.models ?? {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('models must be an object');
  for (const name of Object.keys(overrides)) {
    if (!(name in defaults)) throw new Error(`Unknown audit phase: ${name}`);
  }
  return Object.fromEntries(Object.entries(defaults).map(([name, fallback]) => [
    name, resolvePhase(name, fallback, overrides[name]),
  ]));
}

export function readModelPlan(projectDir = process.cwd()) {
  const configPath = path.join(path.resolve(projectDir), '.claude', 'chat-audit.config.json');
  let config = {};
  let source = null;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    source = configPath;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read audit config ${configPath}: ${error.message}`);
  }
  return { config: source, orchestrator: 'keep-current', phases: resolveModels(config) };
}

// argv[1] is the path as typed; import.meta.url is resolved through symlinks.
// The skill is installed as a symlink into the kit repo, so path.resolve (which
// keeps the link) never matched and the CLI silently did nothing (exit 0, no output).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--project')) {
      throw new Error('Usage: node models.mjs [--project <dir>]');
    }
    process.stdout.write(`${JSON.stringify(readModelPlan(args[1]), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
