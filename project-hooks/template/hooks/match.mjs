// Pure matchers for `when` gates and pure rows (no Node API: the mod imports them).
// Copied from claude-code-kit/project-hooks: change the kit, then `project-hooks install`, not this copy.

// A gate built on these must not miss a commit, so unusual spellings count as one: a command starts at a line,
// a separator, a subshell or a backtick; VAR=x, sudo/env/command, shell keywords and `sh -c '…'` may stand before
// git; git may be a path or git.exe; global options sit between git and the subcommand, and these take their value
// as the next word.
const START = String.raw`(?:^|[;&|({!\x60])`;
const PREFIX = String.raw`(?:\s*(?:\w+=[^\s;&|(){}!\x60]*|sudo|command|exec|nohup|time|env|then|do|else)\s)*(?:\s*(?:ba|z)?sh\s+-\w*c\s+['"]?)?`;
// A value or a path holds no separator, so each start scans only its own word: linear in the command.
const GIT = String.raw`\s*(?:[^\s;&|(){}!\x60'"]*[\\/])?git(?:\.exe)?`;
const OPTIONS = String.raw`(?:\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env)\s+\S+|-\S+))*`;
const GIT_COMMIT = new RegExp(`${START}${PREFIX}${GIT}${OPTIONS}\\s+commit(?![\\w-])`, 'm');

// `<<WORD`, `<<-'WORD'`, `<<"WORD"`; not the here-string `<<<`.
const HEREDOC = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][\w-]*)\1/;

/** The command without its heredoc bodies: they are data. An unterminated heredoc is no heredoc; nothing is dropped. */
function shellPart(command) {
  const kept = [];
  let delimiter = null;
  for (const line of command.split('\n')) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    kept.push(line);
    delimiter = HEREDOC.exec(line)?.[2] ?? null;
  }
  return delimiter === null ? kept.join('\n') : command;
}

/** Does this shell command run `git commit`, alone, in a chain or wrapped? */
export function isGitCommit(command) {
  return GIT_COMMIT.test(shellPart(String(command ?? '')));
}

/** The Bash command of a tool input ('' for any other tool). */
export function bashCommand(input) {
  return input?.tool_name === 'Bash' ? String(input.tool_input?.command ?? '') : '';
}
