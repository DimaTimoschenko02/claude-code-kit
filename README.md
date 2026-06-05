# cc-learning-log

Drop-in self-learning log for Claude Code.

- **What:** a background Claude Haiku classifier reads each session transcript and records three signal classes (`user-correction`, `self-correction`, `win`) as markdown under the project's `.claude/`.
- **Review:** slash commands (`/log`, `/learning-log`, `/learning-log analyze`, `/learning-log wins`, `/learning-log flush`).
- **Cost:** runs on the Max/Pro subscription. Never the billed API.
- **Blocking:** never — the classifier is a detached background fork.
- **Portability:** drops into any project, including a plain git repo. No Obsidian required.

---

## Requirements

- `bash`, `jq` (≥1.6).
- `claude` CLI logged into a **Max or Pro** plan, present on the interactive PATH (hooks restore PATH for background forks via `_lib/env.sh`).
- Windows: install **Git for Windows** (Git Bash). Clone with `git`; do NOT download the ZIP (CRLF breaks hooks; `.gitattributes` keeps a clone LF-clean).

## Install

```bash
git clone <this-repo> cc-learning-log
cd cc-learning-log
./install.sh /path/to/your/project      # or: ./install.sh   (run from inside the target project)
```

- Re-run any time to upgrade. Config, logs, and state are preserved.
- Report installed vs package version: `./install.sh --check /path/to/project`.

## What gets installed

```
<project>/.claude/
├── hooks/
│   ├── _lib/{env,paths,config}.sh
│   ├── learning-log-trigger.sh         # Stop/SessionEnd -> volume throttle -> fork classifier
│   ├── learning-log-analyze.sh         # background haiku classifier -> writes files
│   └── skill-invocation-log.sh         # PostToolUse[Skill] logger
├── skills/learning-log/SKILL.md        # commands: /log, /learning-log, analyze, wins, flush
├── learning-log.config.json            # settings (commit this)
├── learning-log/                       # the log — GITIGNORED by default
│   ├── <YYYY-MM>/<YYYY-MM-DD>.md        #   mistakes (daily files)
│   ├── wins/candidates.md              #   win candidates (single buffer)
│   └── resolutions.md                  #   fix registry (recurrence + efficacy)
└── state/                              # per-machine, gitignored
```

Side effects: registers the hooks in `.claude/settings.json` (idempotent atomic merge); appends a `# >>> cc-learning-log >>>` block to `.gitignore`.

### Privacy

Entries quote the conversation. `.claude/learning-log/` is gitignored by default. To version the history (private/solo repos): remove `.claude/learning-log/` from the `# >>> cc-learning-log >>>` block in `.gitignore`.

---

## Channels

Three artifacts. Distinct schemas, distinct lifecycles. Mistakes and wins are NOT merged into one format.

### Mistakes — `learning-log/<YYYY-MM>/<YYYY-MM-DD>.md`

Daily files. One entry per behavioral miss. Header `## HH:MM` (date lives in the filename). Newest on top.

```markdown
## HH:MM
- **Did:** what Claude did
- **Wanted:** what should have happened
- **Cause:** skill | claude-md | memory | habit | unknown — phrase
- **Related:** `name` | —                      # [[name]] if wikilinks:true
- **Runtime-fix:** how Claude recovered        # optional; self-correction; Status stays open
- **Status:** open | addressed | wontfix
- **Source:** auto (haiku, <class>, …) | manual (/log)
- **Pattern:** <kebab-key>                      # optional; set during analyze; links to registry
- **Recurrence-of:** <kebab-key>               # optional; marks a recurrence
- **Resolution:** YYYY-MM-DD — what was done   # optional; addressed/wontfix
```

### Wins — `learning-log/wins/candidates.md`

Single buffer. One entry per reusable solution caught in the moment — a candidate for promotion to memory/skill/convention. Header `## YYYY-MM-DD HH:MM`. Newest on top.

```markdown
## YYYY-MM-DD HH:MM
- **What:** the solution / pattern
- **Reusable:** why it is valuable / where to reuse it
- **Target:** memory | skill | convention | —
- **Status:** open | addressed | wontfix
- **Source:** auto (haiku, win, …) | manual (/log)
- **Promoted-to:** <ref>                        # optional; addressed (= promoted)
```

### Registry — `learning-log/resolutions.md`

Fix efficacy + recurrence detection. One row per resolved PATTERN (class of problem), NOT per event — it grows with the number of classes, not occurrences. Written ONLY by `/learning-log analyze`.

```markdown
| Pattern | Fix | Applied | Status | Recur | Last seen |
|---|---|---|---|---|---|
| bypass-skill | rule in SKILL.md §X | 2026-06-01 | failed | 3 | 2026-06-04 |
```

- `applied` — fix written, no recurrence yet.
- `wontfix` — chose not to fix.
- `failed` — an `applied`/`wontfix` pattern recurred → fix was wrong/incomplete → escalate (rule → hook).

---

## Capture classes

The classifier is semantic (no regex prefilter). It returns three classes:

| Class | Meaning | Lands in |
|---|---|---|
| `user-correction` | the user corrected Claude | day file |
| `self-correction` | Claude caught its own miss unprompted | day file (+ `Runtime-fix` if it recovered) |
| `win` | non-trivial, reusable solution | `candidates.md` |

Wins are conservative: routine task completion is NOT a win — only insight reusable beyond the current task.

## Commands

| Command | Action |
|---|---|
| `/log <text>` | force-write one entry from the current session; type (mistake/win) inferred from the text |
| `/learning-log` | list open mistakes (grouped by cause) + open wins; flag `failed` rows in the registry |
| `/learning-log analyze` | review open mistakes; apply fixes; write registry rows; detect recurrence; flip status in place |
| `/learning-log wins` | review open win candidates; promote (→ memory/skill/convention) or discard |
| `/learning-log flush` | run the classifier over the unprocessed transcript tail right now |

## Lifecycle

- New entry → `Status: open`.
- `/learning-log` filters by `Status: open`.
- Resolve via `analyze` (mistakes) or `wins` — flips to `addressed`/`wontfix` IN PLACE (no archive move) and appends `Resolution`/`Promoted-to`.
- A `Runtime-fix` does NOT close an entry — Status stays `open` so analyze still reviews the root cause.
- Recurrence: at analyze time, match each open mistake against the registry. On match → bump `Recur`, set `Status: failed`, add `Recurrence-of` to the new entry, escalate the fix.

---

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
| `force_subscription` | `true` | unset `ANTHROPIC_API_KEY` so the Max/Pro sub is used, never the billed API |
| `persona` | `"the user"` | who Claude talks to (set to a name to personalize entries) |
| `language` | `"the conversation's language"` | language for entry text |
| `classifier_extra_instructions` | `""` | appended verbatim to the classifier system prompt |
| `wikilinks` | `false` | `false` → `` `name` ``; `true` → `[[name]]` (Obsidian) |

## Verify

```bash
tail -f .claude/state/analyze-errors.log     # diagnostics, incl. "0 entries" reasons
ls -R .claude/learning-log/                    # files appear after a few exchanges
```

## Troubleshooting

- **0 entries ever written** → almost always PATH: the forked classifier can't find `claude`/`jq`. `_lib/env.sh` covers nvm/brew/`~/.local/bin`/volta/asdf; add your bin dir if it differs.
- **Unexpected API billing** → keep `force_subscription: true` (unsets `ANTHROPIC_API_KEY` for the classifier call).
- **`claude -p` hangs / auth prompt** → run `claude` interactively once after login (unlock keychain). `classifier_timeout_seconds` caps a stuck call.
- **Wins/registry never appear** → wins need a `win`-class detection (conservative; rare). The registry is written only by `/learning-log analyze`, never by the classifier.

## Upgrade

```bash
git pull && ./install.sh --check /path/to/project   # report drift
./install.sh /path/to/project                        # re-run to upgrade; data preserved
```

## Uninstall

```bash
./uninstall.sh /path/to/project            # remove scripts + hooks; keep data
./uninstall.sh /path/to/project --purge    # also remove logs, state, config, .gitignore block
```

---

## Known limitations — verify in your environment

- **Recursion guard (smoke-test):** the classifier runs `claude -p`, which could re-emit `Stop`. The fork sets `CCLL_INACTIVE=1`; the trigger exits when it sees it. Confirm no fork storm on your CC version.
- `$CLAUDE_PROJECT_DIR` availability inside Bash-tool subshells varies; the git-toplevel fallback in `_lib/paths.sh` covers the gap.
- Windows backgrounding (Git Bash) is best-effort; hooks invoke `bash "<path>"` so the +x bit and shebang quirks don't matter.

### Windows

- Target shell: **Git Bash** (Git for Windows). Claude Code uses it as the default hook shell; `$CLAUDE_PROJECT_DIR` is exported, so the registered `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/..."` runs unchanged. No native-cmd / PowerShell port ships.
- `_lib/env.sh` adds Windows bin locations (`%APPDATA%\npm`, WindowsApps shim, native installer) so the background classifier finds `claude` — the #1 "0 entries" cause.
- Verify on first run (cannot be confirmed from macOS/Linux):
  - after a real session, a day file appears under `.claude/learning-log/<YYYY-MM>/`. Empty? Run `command -v claude` in Git Bash; if found interactively but the log stays empty, the fork isn't inheriting PATH — add your `claude` dir to `_lib/env.sh`.
  - background survival: the classifier is detached via `nohup … & disown`. If MSYS reaps the child when the `Stop` hook returns, switch the fork in `learning-log-trigger.sh` to `cmd //c start //b bash "$ANALYZE_SCRIPT" …`.

## Internals (contributors)

- **Per-session anchor** (`state/learning-log.json` `anchors[<session>]`): each chat tracks its own last-analyzed turn — switching chats never re-scans or clobbers.
- **Volume throttle**, not a turn counter or regex prefilter — haiku decides semantically.
- **mkdir-atomic lock** (no flock on macOS) with stale reclaim.
- **Chunk truncation** keeps the last `max_chunk_bytes` so a long backlog fits the window.
- **File-based awk insert** (never `awk -v`) so markdown special chars don't break it.
- **Output routing:** the classifier writes mistakes → day file (`## HH:MM`), wins → `wins/candidates.md` (`## YYYY-MM-DD HH:MM`). The registry is touched only by `/learning-log analyze`.
- Status flips in place (`open` → `addressed`/`wontfix`) — no archive move.
