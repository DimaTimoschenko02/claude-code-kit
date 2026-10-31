# project-hooks

A project's hooks written once, as a table, and run by both agents:

- **Claude Code** runs the table as a mod, inside the session (`hooks/register.ts`, loaded from the project's
  `.claude/skills/project-hooks/`). A pure row costs no process at all; a command hook in `settings.json` costs one
  process per event, 130–290 ms on Windows and seconds when sessions start in parallel.
- **Codex** runs the same table through its native project hooks (`<repo>/.codex/hooks.json`), one
  `node runner.mjs <Event> --codex` per event. Codex payloads are translated first: a shell call (`exec_command`,
  `shell`) becomes `Bash`, an `apply_patch` becomes one `Write`/`Edit` per file it touches. Codex has no `ask`,
  so an ask denies with its reason.

## A table row

`core/index.mjs` exports `HOOKS`, the project's own file (types in `hooks/contract.ts`):

```js
export const HOOKS = [
  // pure: runs in the session; reads and writes only through `io`
  { name: 'vault-guard', event: 'PreToolUse', matcher: /^(Read|Write|Edit)$/, run: (input, io) => deny(…) },
  // a process kept as it was: argv, `${root}` = project root, a bare `bash` = Git Bash on Windows
  { name: 'stop', event: ['Stop', 'SessionEnd'], script: ['node', '${root}/.claude/hooks/stop.mjs'], codex: false },
  // a cheap gate before the process starts
  { name: 'regen', event: 'PostToolUse', matcher: /^Bash$/, when: (i) => /obsidian (create|move)/.test(i.tool_input.command),
    script: ['node', '${root}/.claude/lib/regen.mjs'] },
];
```

A row answers as a command hook does: a classic output object, a string (additionalContext), or nothing. A script
answers with its stdout (JSON or text) and exit code (2 blocks with stderr). The rows of an event run at once,
except PreToolUse, which runs them in order and stops at the first deny. A row that throws is skipped, so a gate
that must fail closed catches its own errors. A mod result has no `systemMessage`: the mod shows it as a toast.

`hooks/match.mjs` holds the pure matchers rows share (`isGitCommit`, `bashCommand`); a project's own script can
import them too, so the mod's gate and the script agree.

A pure row must not import Node: the mod runs without it. It reaches files, processes and env through `io`
(`read`, `write`, `append`, `stat`, `list`, `run`, `env` — a fixed list of variable names, since the engine
takes only literal names). `io.read` gives null for a file over 4 MiB, so a check that reads a whole transcript
stays a script.

## Install, check

```bash
node ~/claude-code-kit/project-hooks/bin/project-hooks.mjs install <root> --name <project>-hooks
node ~/claude-code-kit/project-hooks/bin/project-hooks.mjs codex <root>   # after the table's events or matchers change
node ~/claude-code-kit/project-hooks/bin/project-hooks.mjs check <root>   # shells, table imports, .codex/hooks.json?
```

`install` copies the shells over the old ones and keeps `core/index.mjs` and `plugin.json`; it rewrites only our
groups in `.codex/hooks.json`, writes nothing when they are already right or the table has no Codex rows, and stops
on a file it cannot parse rather than write over someone's hooks. Then remove the same hooks from
`.claude/settings.json` in the same commit, or they run twice: `node --test .claude/skills/project-hooks/test/*.test.mjs`
fails while one is left there, or a row's script is missing. A command hook kept there on purpose (a gate that must
work where the mod may not load) is listed with its reason in the table's `KEPT_COMMAND_HOOKS`:
`[{ command: /trust-check\.sh/, why: '…' }]`. A project whose formatter or linter runs on commit must skip `.claude/` (eslint `ignores`,
`.prettierignore`): the shells are not in its tsconfig, and a reformatted shell drifts from the kit.

## Limits

- Claude Code loads a mod from `.claude/skills/` in a **trusted** workspace only; elsewhere the hooks are off.
  A mod that fails to load is skipped silently: `claude plugin validate .claude/skills/project-hooks` before commit.
- Codex runs project hooks only in a trusted project, and each hook only after the owner trusts it in `/hooks`
  (trust is tied to the command's hash). On Windows the command is a path relative to the session's cwd, the one
  spelling cmd, PowerShell and Git Bash all run: start Codex at the project root.
- Tests: `node --test project-hooks/test/*.test.mjs`.
