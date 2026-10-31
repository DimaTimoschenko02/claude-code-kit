// This project's hook table: what used to be command hooks in .claude/settings.json.
// Both shells run it — hooks/register.ts (Claude Code mod) and node/runner.mjs (Codex). Contract: hooks/contract.ts.
// A row is pure (`run(input, io)`, no Node API, all I/O through `io`) or a `script` kept as a process.
// Pure files the table imports must import only other pure files of this plugin, statically.

/** @type {readonly import('../hooks/contract').HookSpec[]} */
export const HOOKS = [
  // { name: 'example-guard', event: 'PreToolUse', matcher: /^Bash$/, run: (input) => null },
  // { name: 'example-script', event: 'Stop', script: ['node', '${root}/.claude/hooks/stop.mjs'] },
];
