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
});
