# cc-learning-log

A drop-in **self-learning log for Claude Code**. After each session a background
[Claude Haiku](https://www.anthropic.com/claude/haiku) classifier reads the
transcript, detects **user-corrections** ("no, do it this way") and
**self-corrections** ("oops, should have used the skill"), and appends them as
dated markdown entries in your project's `.claude/`. It runs on your **Max/Pro
subscription** (never the paid API), never blocks the chat, and turns your
mistakes into reviewable, fixable signals.

Same idea and mechanics as the system it was extracted from — generalized so it
drops into **any** project (including a plain git repo, no Obsidian required).

---

## Requirements

- `bash`, `jq` (≥1.6)
- `claude` CLI logged into a **Max or Pro** plan, present on your interactive PATH
  (the hooks restore PATH for background forks via `_lib/env.sh`)

## Install

```bash
git clone <this-repo> cc-learning-log
cd cc-learning-log
./install.sh /path/to/your/project     # or just ./install.sh from inside the project
```

Re-run any time to upgrade (`./install.sh --check` reports installed vs package version).
Config, logs, and state are preserved across upgrades.

## What it does to your project

```
<project>/.claude/
├── hooks/
│   ├── _lib/{env,paths,config}.sh
│   ├── learning-log-trigger.sh        # Stop/SessionEnd -> volume throttle -> fork classifier
│   ├── learning-log-analyze.sh        # background haiku classifier (writes day files)
│   └── skill-invocation-log.sh        # PostToolUse[Skill] logger
├── skills/learning-log/SKILL.md       # /log, /learning-log, analyze, flush
├── learning-log.config.json           # your settings (committed)
├── learning-log/<YYYY-MM>/<YYYY-MM-DD>.md   # the log — GITIGNORED by default
└── state/                             # per-machine, gitignored
```

It also registers the hooks in `.claude/settings.json` (idempotent, atomic merge)
and appends a `.gitignore` block.

### Privacy: logs are gitignored by default

Entries quote what happened in your conversations. In a shared/work repo that can
leak process, secrets, or names — so `.claude/learning-log/` is gitignored by
default. To version your learning history (private/solo repos), remove
`.claude/learning-log/` from the `# >>> cc-learning-log >>>` block in `.gitignore`.

## Configuration

`<project>/.claude/learning-log.config.json` (precedence: default → this file → `CCLL_*` env):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `threshold` | `6` | min new user/assistant messages before firing on Stop |
| `model` | `claude-haiku-4-5-20251001` | classifier model |
| `max_chunk_bytes` | `300000` | truncate long backlogs to the last N bytes |
| `stale_lock_minutes` | `5` | reclaim a stuck lock after N minutes |
| `skill_log_lookback` | `20` | recent skill calls fed to the classifier |
| `classifier_timeout_seconds` | `120` | cap a hung `claude -p` |
| `force_subscription` | `true` | unset `ANTHROPIC_API_KEY` so the Max/Pro sub is used, never billed API |
| `persona` | `"the user"` | who Claude is talking to (set to a name to personalize) |
| `language` | `"the conversation's language"` | language for entry text |
| `classifier_extra_instructions` | `""` | appended verbatim to the classifier system prompt |
| `wikilinks` | `false` | `false` → `` `name` ``; `true` → `[[name]]` (Obsidian) |

## Commands

| Command | What |
|---|---|
| `/log <text>` | force-write one entry from the current session into today's file |
| `/learning-log` | list open entries (grouped by cause) across all day files |
| `/learning-log analyze` | review open entries, apply fixes, flip status in place |
| `/learning-log flush` | run the classifier over the unprocessed tail right now |

## Verify it works

```bash
tail -f .claude/state/analyze-errors.log        # diagnostics (incl. "0 entries" reasons)
ls -R .claude/learning-log/                       # day files appear after a few exchanges
```

## Troubleshooting

- **0 entries ever written?** → almost always **PATH**: the forked classifier can't
  find `claude`/`jq`. `_lib/env.sh` covers nvm/brew/`~/.local/bin`/volta/asdf; if your
  setup differs, add your bin dir there.
- **Unexpected API billing?** `force_subscription` unsets `ANTHROPIC_API_KEY` for the
  classifier call so it uses your Max/Pro auth. Keep it `true`.
- **`claude -p` hangs / auth prompt** → run `claude` interactively once after login
  (unlock keychain). The `classifier_timeout_seconds` cap prevents a stuck lock.

## Upgrade

```bash
git pull && ./install.sh --check /path/to/project   # see if outdated
./install.sh /path/to/project                        # re-run to upgrade; data preserved
```

## Uninstall

```bash
./uninstall.sh /path/to/project            # remove scripts + hooks; keep your data
./uninstall.sh /path/to/project --purge    # also remove logs, state, config, .gitignore block
```

## Known limitations / verify in your environment

- **Recursion guard (must smoke-test):** the classifier runs `claude -p`, which could
  in principle re-emit `Stop`. The fork sets `CCLL_INACTIVE=1` and the trigger exits
  immediately when it sees it — confirm no fork storm on your CC version.
- `$CLAUDE_PROJECT_DIR` availability inside Bash-tool subshells varies; the git-toplevel
  fallback in `_lib/paths.sh` covers the gap.
- Windows backgrounding (Git-Bash) is best-effort; hooks use `bash "<path>"` so the +x
  bit and shebang quirks don't matter.

## How it works (for contributors)

- **Per-session anchor** (`state/learning-log.json` `anchors[<session>]`): each chat
  remembers its own last-analyzed turn, so switching chats never re-scans or clobbers.
- **Volume throttle**, not a turn counter or regex prefilter — the haiku decides
  semantically whether a chunk holds a correction.
- **mkdir-atomic lock** (no flock on macOS) with stale reclaim.
- **Chunk truncation** keeps the last `max_chunk_bytes` so a long backlog fits the window.
- **File-based awk insert** (never `awk -v`) so markdown special chars don't break it.
- Entry header is `## HH:MM`; the date lives in the folder/filename. Status flips
  **in place** (`open` → `addressed`/`wontfix`) — no archive move.
