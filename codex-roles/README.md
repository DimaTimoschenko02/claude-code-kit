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
  `disallowedTools`, `skills` (read each `SKILL.md` first), `model` / `effort` (recorded in the header).
- **Model**: every role runs Sol, the newest visible `gpt-<version>-sol` in the catalog Codex keeps in
  `$CODEX_HOME/models_cache.json` (default `~/.codex`). The family is the rule, the version is never pinned: a new
  release makes the roles `stale` and the next run moves them. A role never moves back — a machine whose catalog lags
  or is missing keeps the newer slug. No catalog and no earlier model → no `model` line (Codex runs the parent's).
  A hand-kept role of ours (see tables below) is not rebuilt, but its `model` line follows the catalog within the
  family it names (`stale: <name> (model only)`).
- **Extras per role**: `<root>/.codex/roles.d/<name>.pre.md` and `.post.md`, placeholders `{ROOT}` and `{MAIN}`.
- **Ours vs foreign**: a toml whose first line is `# Converted from …/.claude/agents/<file>.md` is ours and gets
  rewritten, whatever path prefix an older build wrote. A toml without that header is never written or deleted.
  An orphan (our header, source `.md` gone) is listed by `--check` and deleted on write. The converter never writes
  TOML tables, so a file of ours that has one (`[features]` with `shell_tool = false`, `[skills]`…) carries
  hand-added hard gates: it is skipped, never rewritten or deleted, and the run exits 1 naming the tables.
- **Path lint**: `X:X:`, `X:\` and, on Windows, a backticked macOS or Linux home path fail the role; it is not
  written.

Output lines: `written:`, `stale:` (`--check`), `skipped: <file> — <reason>`, `bad path: <role> — <match>`, `orphan:`.
Exit 0 when clean or nothing to do; 1 on stale, skipped, bad path or orphan; 2 on a usage error or no
`.claude/agents`. `--check` writes nothing.

## Session-start sync

`codex-roles-sync.mjs` is a SessionStart hook for both Claude Code and Codex: it finds the session's project
(`$CLAUDE_PROJECT_DIR`, else the hook input's `cwd`, walked up to the folder holding `.claude/agents` and
`.codex/agents`; the home folder never counts) and runs the converter there. Then it runs
`codex-roles --config $CODEX_HOME/config.toml`: every `model = "…"` line of the Codex config (the app's default and
profiles) moves to the newest model of the family it names, never back. Silent, fail-open, always exit 0.

It also starts `codex-hooks-trust.mjs` detached. Codex runs a changed hook only after someone approves it in `/hooks`,
per folder and per machine; the script approves the owner's own hooks instead. It asks a `codex app-server` for
`hooks/list` and writes `currentHash` back with `config/batchWrite`, the same calls `/hooks` makes, so Codex computes
the hash. Approved: `$CODEX_HOME/hooks.json`; a project `.codex/hooks.json` that git tracks clean with its last commit
by this machine's `user.email`; outside git, a folder marked `trust_level = "trusted"` in Codex. Foreign clones,
plugins and managed hooks are left alone. Projects come from Codex's `[projects.*]`, `~/.claude.json` and `--cwd`;
a stamp of the hooks files skips the app-server (about 1.5 s) when nothing changed that day. By hand:
`node codex-roles/codex-hooks-trust.mjs [--cwd <dir>]... [--dry-run] [--force]`; `CODEX_HOOKS_TRUST=off` keeps the
sync hook from starting it.

```jsonc
// ~/.claude/settings.json → hooks.SessionStart, and ~/.codex/hooks.json → hooks.SessionStart
{ "type": "command", "command": "node ~/claude-code-kit/codex-roles/codex-roles-sync.mjs", "timeout": 30 }
```

Tests: `node --test codex-roles/test/codex-roles.test.mjs codex-roles/test/codex-hooks-trust.test.mjs` (temp git repos, a stand-in app-server, no network).
