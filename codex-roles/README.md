# codex-roles

Builds OpenAI Codex roles (`.codex/agents/<name>.toml`) from a project's Claude Code agents (`.claude/agents/*.md`),
so a Codex session runs the same role text. The toml is generated, never edited: change the `.md` and run it again.
Node, no dependencies.

```bash
node ~/claude-code-kit/codex-roles/codex-roles [--root <project>] [--check]
```

- **Root** is `--root`, else the current folder, never the script's own location. It resolves to where
  `<root>/.claude` really lives, so a symlinked workspace and the repo give the same bytes.
- **Main checkout**: in a git worktree, roles point at the main checkout's memory, skills and agent memory
  (parent of `git rev-parse --git-common-dir`).
- **Preamble** comes from the agent's frontmatter: `tools` (no Write/Edit and no `memory` → read-only),
  `disallowedTools`, `skills` (read each `SKILL.md` first), `model` / `effort` (recorded; Codex runs its own default).
- **Extras per role**: `<root>/.codex/roles.d/<name>.pre.md` and `.post.md`, placeholders `{ROOT}` and `{MAIN}`.
- **Ours vs foreign**: a toml whose first line is `# Converted from …/.claude/agents/<file>.md` is ours and gets
  rewritten, whatever path prefix an older build wrote. A toml without that header is never written or deleted.
  An orphan (our header, source `.md` gone) is listed by `--check` and deleted on write.
- **Path lint**: `X:X:`, `X:\` and, on Windows, a backticked macOS or Linux home path fail the role; it is not
  written.

Output lines: `written:`, `stale:` (`--check`), `skipped: <file> — <reason>`, `bad path: <role> — <match>`, `orphan:`.
Exit 0 when clean or nothing to do; 1 on stale, skipped, bad path or orphan; 2 on a usage error or no
`.claude/agents`. `--check` writes nothing.

Tests: `node --test codex-roles/test/codex-roles.test.mjs` (temp git repos, no network).
