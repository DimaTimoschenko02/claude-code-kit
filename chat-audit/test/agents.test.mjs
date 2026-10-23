// agents.mjs — error classes. Cases are the real bodies the 2026-10-04 audit misread: a failed command whose output
// merely quoted "not found" (127 counted, 7 real), and hook denials worded without "block" or "deny".
// Run: node --test chat-audit/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../payload/skills/chat-audit/lib/agents.mjs';

const cls = (t) => classifyError(t).cls;

test('a failed command is classed by its exit code and the shell\'s own lines, not by what it printed', () => {
  assert.equal(cls('Exit code 1\n# PH-73 — note\nthe supplier row was not found in the feed'), 'command failed (exit code)');
  assert.equal(cls('Exit code 1\n---\nname: hooks\nthe hook may deny a call'), 'command failed (exit code)');
  assert.equal(cls('Exit code 127\n(eval):1: command not found: psql'), 'command not found');
  assert.equal(cls('Exit code 1\ncat: matching/dto/x.ts: No such file or directory'), 'not found');
  assert.equal(cls('Exit code 1\n(eval):1: no matches found: *.tmp'), 'glob no match');
});

test('a hook denial is a hook block, with the hook named', () => {
  const r = classifyError('PreToolUse:Write hook error: [$CLAUDE_PROJECT_DIR/.claude/hooks/skill-gate-guard.sh]: 🚧 skill-gate: x');
  assert.deepEqual(r, { cls: 'hook block', hook: 'skill-gate-guard.sh' });
});

test('tool errors are classed by their head', () => {
  assert.equal(cls('<tool_use_error>String to replace not found in file.</tool_use_error>'), 'edit mismatch');
  assert.equal(cls('<tool_use_error>Unknown skill: pricehub:code-style</tool_use_error>'), 'unknown skill');
  assert.equal(cls('File does not exist. Note: your current working directory is /x.'), 'not found');
  assert.equal(cls('File content (26247 tokens) exceeds maximum allowed tokens (25000).'), 'read too large');
  assert.equal(cls('File content (3.2MB) exceeds maximum allowed size (256KB).'), 'read too large');
  assert.equal(cls('Exit code 1\n(eval):1: no such file or directory: ./bin/x'), 'not found');
});

// 2026-10-23: 423 of 1 185 subagent errors in one workspace were `other`, nearly all Claude Code's own refusals.
test('Claude Code\'s own refusals have classes, not `other`', () => {
  assert.equal(cls('This agent is isolated in the worktree /r/.claude/worktrees/agent-a1, but this command changes directory to the shared checkout'), 'worktree isolation');
  assert.equal(cls('<tool_use_error>This session is isolated in the worktree /r/.claude/worktrees/PH-159. Edit the worktree copy</tool_use_error>'), 'worktree isolation');
  assert.equal(cls('Cannot enter worktree: /r/.claude/worktrees/PH-130 is the current working directory.'), 'worktree switch refused');
  assert.equal(cls('<tool_use_error>EnterWorktree cannot create a worktree from a subagent with a cwd override</tool_use_error>'), 'worktree switch refused');
  assert.equal(cls('<tool_use_error>Blocked: sleep 60 followed by: tail -5 x.log. To wait for a condition, use Monitor'), 'sleep blocked');
  assert.equal(cls('<tool_use_error>Error: No such tool available: Grep. Grep is not available</tool_use_error>'), 'tool unavailable');
  assert.equal(cls('root: "/tmp/x" is outside the session\'s working directories ("/r") or your scratchpad'), 'outside working dirs');
  assert.equal(cls('Error POSTing to endpoint: {"jsonrpc":"2.0","id":4,"error":{"code":-32600}}'), 'external service');
  assert.equal(cls('JavaScript execution error: TypeError: Cannot read properties of null'), 'external service');
});

test('a guard without a bracketed path is still a hook block, named as far as its text allows', () => {
  assert.deepEqual(classifyError('PreToolUse:Bash hook error: secrets-redact mod is not running in this session'), { cls: 'hook block', hook: 'secrets-redact (mod)' });
  assert.deepEqual(classifyError('PreToolUse:EnterWorktree hook error: Background agents still run: «PH-9»'), { cls: 'hook block', hook: 'unnamed' });
  assert.deepEqual(classifyError('🚧 skill-gate: "apps/x.ts" belongs to skill code-style'), { cls: 'hook block', hook: 'skill-gate' });
  assert.deepEqual(classifyError('PreToolUse:Bash hook error: [bash /h/block-secrets.sh]: 🛑 BLOCKED'), { cls: 'hook block', hook: 'block-secrets.sh' });
});
