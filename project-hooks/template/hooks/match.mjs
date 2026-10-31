// Pure matchers for `when` gates and pure rows (no Node API: the mod imports them).
// Copied from claude-code-kit/project-hooks: change the kit, then `project-hooks install`, not this copy.

// Global options may sit between git and the subcommand: -C dir, -c k=v, --no-pager.
const GIT_COMMIT = /(^|[;&|(])\s*git(\s+(-[Cc]\s+\S+|-\S+))*\s+commit(\s|$)/m;

/** Does this shell command run `git commit`, alone or in a chain? Only the shell part counts: a heredoc body is data. */
export function isGitCommit(command) {
  return GIT_COMMIT.test(String(command ?? '').split('<<')[0]);
}

/** The Bash command of a tool input ('' for any other tool). */
export function bashCommand(input) {
  return input?.tool_name === 'Bash' ? String(input.tool_input?.command ?? '') : '';
}
