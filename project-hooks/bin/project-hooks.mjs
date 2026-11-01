#!/usr/bin/env node
// Installs or checks the project-hooks shells in a project: <root>/.claude/skills/<dir>/, and the project's Codex
// hooks (<root>/.codex/hooks.json) that run the same table through node/runner.mjs.
//
//   project-hooks install <root> [--dir project-hooks] [--name <root name>-hooks]
//       copies the shells (hooks/, node/, core/index.d.mts, test/) over the old ones; creates core/index.mjs and
//       .claude-plugin/plugin.json only when they are missing, since those are the project's own; then writes the
//       table's events into .codex/hooks.json (other hooks there stay).
//   project-hooks codex <root> [--dir project-hooks]
//       only the .codex/hooks.json step: run it after the table gains or loses an event or a matcher.
//   project-hooks check <root> [--dir project-hooks]
//       exit 1 and what is wrong when a shell differs from the kit's, .codex/hooks.json from the table, or the table
//       imports a file outside the mod folder, a missing one or one git does not track.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'template');
export const SHELLS = ['hooks/engine.mjs', 'hooks/contract.ts', 'hooks/register.ts', 'hooks/hooks.json',
  'hooks/match.mjs', 'node/runner.mjs', 'node/codex.mjs', 'core/index.d.mts', 'test/table.test.mjs'];
const OWN = ['core/index.mjs'];
/** A Codex hook command of ours is recognised by this part of it. */
const RUNNER_MARK = '/node/runner.mjs';

/** Codex runs SessionEnd hooks for at most 3 s; Claude's own limits do not apply there. */
const CODEX_TIMEOUT = { SessionEnd: 3 };
/** Events Codex has: a table row on any other event runs in Claude Code only. */
const CODEX_EVENTS = new Set(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
  'UserPromptSubmit', 'SubagentStop', 'Stop', 'SessionStart', 'SubagentStart', 'SessionEnd']);
/** Events whose input names a tool. */
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest']);
/** Events whose matcher Codex ignores. */
const NO_MATCHER = new Set(['UserPromptSubmit', 'Stop']);

function option(args, name, fallback) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
}

/**
 * The Codex hook groups of a table: one command per event, the union of the rows' matchers.
 * `commandWindows` is a path relative to the session cwd, the one spelling cmd, PowerShell and Git Bash all run
 * (Codex starts a project session at its root); `command` finds the root through git on macOS and Linux, and falls
 * back to the cwd when that is not a repo: a workspace folder that links `.claude` and `.codex` into its repo.
 */
export function codexGroups(hooks, dir = 'project-hooks') {
  const groups = {};
  for (const event of [...new Set(hooks.filter((h) => h.codex !== false).flatMap((h) => [h.event].flat()))]) {
    if (!CODEX_EVENTS.has(event)) continue;
    const rows = hooks.filter((h) => h.codex !== false && [h.event].flat().includes(event));
    // A tool event's matcher would meet Codex's own tool names (exec_command, apply_patch, mcp__x__write_file) and
    // lose the RegExp flags: the runner matches after translating, so Codex gets none. Other events keep the union.
    const matchers = rows.map((h) => (h.matcher?.flags ? undefined : h.matcher?.source));
    const matcher = NO_MATCHER.has(event) || TOOL_EVENTS.has(event) || matchers.some((m) => !m)
      ? undefined : [...new Set(matchers)].join('|');
    const runner = `.claude/skills/${dir}/node/runner.mjs`;
    groups[event] = [{
      ...(matcher ? { matcher } : {}),
      hooks: [{
        type: 'command',
        command: `node "$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)/${runner}" ${event} --codex`,
        commandWindows: `node ${runner} ${event} --codex`,
        timeout: CODEX_TIMEOUT[event] ?? 120,
        statusMessage: `Project hooks (${event})`,
        additionalContextLimit: 60000,
      }],
    }];
  }
  return groups;
}

const isOurs = (group) => (group.hooks ?? []).some((h) => String(h.command ?? '').includes(RUNNER_MARK));

/** .codex/hooks.json with our groups for the table and every other hook kept as it was. */
export function mergeCodexHooks(existing, groups) {
  const config = existing && typeof existing === 'object' ? { ...existing } : {};
  const hooks = {};
  for (const [event, list] of Object.entries(config.hooks ?? {})) {
    const kept = (list ?? []).filter((g) => !isOurs(g));
    if (kept.length) hooks[event] = kept;
  }
  for (const [event, list] of Object.entries(groups)) hooks[event] = [...(hooks[event] ?? []), ...list];
  config.hooks = hooks;
  return config;
}

async function tableOf(target) {
  const file = join(target, 'core', 'index.mjs');
  // the version query: a table changed since this process last imported it is read again
  const { HOOKS } = await import(`${pathToFileURL(file).href}?v=${statSync(file).mtimeMs}`);
  return HOOKS;
}

/** A JSON file's value; null when it is missing. A file there that does not parse throws: we never write over it. */
const readJson = (file) => {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} does not parse (${error.message}): fix it by hand, it may hold other hooks`);
  }
};

/** Our groups into <root>/.codex/hooks.json. Returns the file, or null when nothing had to be written. */
export async function writeCodexHooks(root, { dir = 'project-hooks' } = {}) {
  const file = join(root, '.codex', 'hooks.json');
  const current = readJson(file);
  const groups = codexGroups(await tableOf(join(root, '.claude', 'skills', dir)), dir);
  // a table Codex does not run creates no file; a file already right stays as it is, byte for byte
  if (current === null && !Object.keys(groups).length) return null;
  const next = mergeCodexHooks(current, groups);
  if (JSON.stringify(next) === JSON.stringify(current)) return null;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return file;
}

export async function install(root, { dir = 'project-hooks', name = `${basename(resolve(root))}-hooks` } = {}) {
  const target = join(root, '.claude', 'skills', dir);
  const written = [];
  for (const file of [...SHELLS, ...OWN.filter((f) => !existsSync(join(target, f)))]) {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    copyFileSync(join(TEMPLATE, file), join(target, file));
    written.push(file);
  }
  const manifest = join(target, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifest)) {
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, readFileSync(join(TEMPLATE, '.claude-plugin', 'plugin.json'), 'utf8').replace('__NAME__', name));
    written.push('.claude-plugin/plugin.json');
  }
  const codexFile = await writeCodexHooks(root, { dir });
  if (codexFile) written.push(codexFile);
  return { target, written };
}

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/**
 * The files the table reaches through relative imports, and what is wrong with them. Claude Code loads a mod only
 * from inside its folder and skips a mod that fails to load without a word, so a file outside it or a missing one
 * turns every hook off.
 */
export function tableImports(target) {
  const seen = new Set();
  const problems = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    // comments go first: a JSDoc type import('../hooks/contract') is never loaded
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [, spec] of code.matchAll(RELATIVE_IMPORT)) {
      const next = resolve(dirname(file), spec);
      const inside = relative(target, next);
      const from = relative(target, file).replaceAll('\\', '/');
      if (inside.startsWith('..') || isAbsolute(inside)) problems.push(`${from} imports ${spec}: outside the mod folder, Claude Code refuses it`);
      else if (!existsSync(next)) problems.push(`${from} imports ${spec}: no such file`);
      else visit(next);
    }
  };
  visit(join(target, 'core', 'index.mjs'));
  return { files: [...seen], problems };
}

/** Files git does not track: on disk here, missing on every other clone. Empty outside a git work tree. */
function untracked(root, files) {
  const paths = files.map((f) => relative(root, f).replaceAll('\\', '/'));
  let listed;
  try {
    listed = execFileSync('git', ['ls-files', '-z', '--', ...paths], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  const tracked = new Set(listed.split('\0'));
  return paths.filter((p) => !tracked.has(p));
}

export async function check(root, { dir = 'project-hooks' } = {}) {
  const target = join(root, '.claude', 'skills', dir);
  const drift = SHELLS.filter((file) => {
    const theirs = join(target, file);
    return !existsSync(theirs) || readFileSync(theirs, 'utf8') !== readFileSync(join(TEMPLATE, file), 'utf8');
  });
  const { files, problems } = tableImports(target);
  drift.push(...problems, ...untracked(root, files).map((p) => `${p}: not tracked by git, other clones lose the mod (git add it)`));
  if (problems.length) return drift;
  const codexFile = join(root, '.codex', 'hooks.json');
  const current = readJson(codexFile);
  const groups = codexGroups(await tableOf(target), dir);
  const wanted = current === null && !Object.keys(groups).length ? null : mergeCodexHooks(current, groups);
  if (JSON.stringify(current) !== JSON.stringify(wanted)) drift.push('.codex/hooks.json (run: project-hooks codex <root>)');
  return drift;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, root, ...args] = process.argv.slice(2);
  if (!['install', 'codex', 'check'].includes(command) || !root) {
    process.stderr.write('usage: project-hooks install|codex|check <root> [--dir project-hooks] [--name <name>]\n');
    process.exit(64);
  }
  const dir = option(args, '--dir', undefined);
  if (command === 'install') {
    const { target, written } = await install(root, { dir, name: option(args, '--name', undefined) });
    process.stdout.write(`${target}\n${written.map((f) => `  ${f}`).join('\n')}\n`);
  } else if (command === 'codex') {
    process.stdout.write(`${(await writeCodexHooks(root, { dir })) ?? '.codex/hooks.json already matches the table'}\n`);
  } else {
    const drift = await check(root, { dir });
    if (drift.length) {
      process.stdout.write(`check failed:\n${drift.map((f) => `  ${f}`).join('\n')}\n`);
      process.exit(1);
    }
    process.stdout.write('shells match the kit, the table imports only tracked files inside the mod, .codex/hooks.json matches the table\n');
  }
}
