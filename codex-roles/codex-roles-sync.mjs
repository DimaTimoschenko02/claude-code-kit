#!/usr/bin/env node
// codex-roles-sync — SessionStart hook for Claude Code and Codex. Rebuilds the session project's Codex roles with
// codex-roles, so every role runs today's agent text on the newest Codex model of its family: a new release reaches the
// roles at the next session start in that project, without anyone editing a version.
// The project is $CLAUDE_PROJECT_DIR (Claude Code) or the hook input's `cwd` (Codex), walked up to the folder holding
// both .claude/agents and .codex/agents. The home folder never counts: ~/.codex/agents holds links to project roles,
// which the converter would take for orphans and delete. Silent and fail-open: it must never block a session start.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  let start = process.env.CLAUDE_PROJECT_DIR;
  if (!start && !process.stdin.isTTY) {
    try { start = JSON.parse(readFileSync(0, 'utf8')).cwd; } catch { /* no input: fall back to cwd */ }
  }
  // Windows paths arrive in any case (`c:\users\…` from Codex), so compare them case-blind there.
  const key = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);
  const home = key(resolve(homedir()));
  for (let dir = resolve(start || process.cwd()); key(dir) !== home && dirname(dir) !== dir; dir = dirname(dir)) {
    if (!existsSync(join(dir, '.codex', 'agents')) || !existsSync(join(dir, '.claude', 'agents'))) continue;
    const converter = join(dirname(fileURLToPath(import.meta.url)), 'codex-roles');
    spawnSync(process.execPath, [converter, '--root', dir], { stdio: 'ignore', timeout: 30000, windowsHide: true });
    break;
  }
} catch { /* fail-open */ }
process.exit(0);
