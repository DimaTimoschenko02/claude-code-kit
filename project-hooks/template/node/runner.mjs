#!/usr/bin/env node
// project-hooks, the node shell: runs this project's hook table (../core/index.mjs) for one event in one node
// process and prints the folded answer as a command hook would. Codex starts it per event from the project's
// .codex/hooks.json (`--codex`: Codex payloads are translated, rows with `codex: false` are skipped); tests use it
// to run the table without Claude Code.
//
// usage: node runner.mjs <Event> [--only <name>] [--codex]   (stdin: the hook input)
// Copied from claude-code-kit/project-hooks: change the kit, then `project-hooks install`, not this copy.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOKS } from '../core/index.mjs';
import { fold, normalPath, runEvent } from '../hooks/engine.mjs';
import { claudeInputs, codexOutput, TOOL_EVENTS } from './codex.mjs';

const PLATFORM = process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';
/** node/runner.mjs → <root>/.claude/skills/<name>/node */
export const ROOT = normalPath(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'), PLATFORM);

const fsPath = (p) => normalPath(p, PLATFORM);

/** Git Bash, not the WSL launcher in System32 that Windows finds first for a bare `bash`. */
function bashExe(env = process.env) {
  if (PLATFORM !== 'win32') return 'bash';
  const dirs = String(env.PATH ?? '').split(delimiter).filter((d) => d && !/[\\/](System32|WindowsApps)([\\/]|$)/i.test(d));
  for (const p of [env.CLAUDE_CODE_GIT_BASH_PATH, ...dirs.map((d) => join(d, 'bash.exe')), 'C:/Program Files/Git/bin/bash.exe']) {
    if (p && existsSync(p)) return fsPath(p);
  }
  return 'bash';
}

function runProcess(argv, { cwd, env, stdin, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: cwd ? fsPath(cwd) : undefined, env: { ...process.env, ...env }, windowsHide: true });
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${argv[0]} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => {}); // a child that never reads its stdin
    child.stdin.end(stdin ?? '');
  });
}

/** The io of hooks/contract.ts over node:fs and child_process. */
export function nodeIo({ root = ROOT, codex = process.env.CODEX_COMPAT === '1', env = process.env } = {}) {
  const tryOr = (fn, fallback) => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  return {
    root, platform: PLATFORM, home: fsPath(homedir()), codex,
    env: async (name) => env[name],
    read: async (p) => tryOr(() => readFileSync(fsPath(p), 'utf8'), null),
    write: async (p, text) => {
      mkdirSync(dirname(fsPath(p)), { recursive: true });
      writeFileSync(fsPath(p), text);
    },
    append: async (p, text) => {
      mkdirSync(dirname(fsPath(p)), { recursive: true });
      appendFileSync(fsPath(p), text);
    },
    exists: async (p) => existsSync(fsPath(p)),
    stat: async (p) => tryOr(() => {
      const s = statSync(fsPath(p));
      return { kind: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other', size: s.size, mtimeMs: s.mtimeMs };
    }, null),
    list: async (dir) => tryOr(() => readdirSync(fsPath(dir), { withFileTypes: true })
      .map((d) => ({ name: d.name, kind: d.isDirectory() ? 'directory' : d.isFile() ? 'file' : 'other' })), []),
    run: (argv, init) => runProcess(argv, init),
    bash: async () => bashExe(env),
    path: fsPath,
    now: () => new Date(),
    log: (line) => process.stderr.write(`project-hooks: ${line}\n`),
  };
}

/** The folded classic output of one event for this input (null = nothing to say). */
export function runTable(event, input, { only = null, hooks = HOOKS, ...ioOptions } = {}) {
  const table = only ? hooks.filter((h) => h.name === only) : hooks;
  return runEvent(table, event, { ...input, hook_event_name: event }, nodeIo(ioOptions));
}

/** One Codex event: each classic input it stands for (a patch is one per file) through the table, folded. */
export async function runCodex(event, raw, options = {}) {
  const inputs = TOOL_EVENTS.has(event) ? claudeInputs(raw) : [raw];
  const outs = [];
  for (const input of inputs) {
    const out = await runTable(event, input, { ...options, codex: true });
    if (out) outs.push(out);
  }
  return codexOutput(event, fold(event, outs), raw);
}

async function main() {
  const [event, ...rest] = process.argv.slice(2);
  if (!event) {
    process.stderr.write('usage: node runner.mjs <Event> [--only <name>] [--codex]\n');
    process.exit(64);
  }
  const at = rest.indexOf('--only');
  const only = at >= 0 ? rest[at + 1] : null;
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    input = {};
  }
  const out = rest.includes('--codex') ? await runCodex(event, input, { only }) : await runTable(event, input, { only });
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (process.argv[1] && fsPath(process.argv[1]) === fsPath(fileURLToPath(import.meta.url))) await main();
