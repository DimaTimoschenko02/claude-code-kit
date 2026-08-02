# Mode 2 — select

Choose which sessions get read, and agree the cost before spending it.

## Run

```bash
node .claude/skills/chat-audit/lib/discover.mjs sessions --project <dir> [--days N] [--grep <regex>] [--scope exact|subtree|all]
```

One line per session: start time, size, user-turn count, short id, auto-title, branch. Sorted newest first.
Sessions under 2 KB are dropped as aborted.

Scope matters when a project has worktrees or sub-repos: `exact` is the directory itself, `subtree` (default)
includes everything under it, `all` is every session on the machine.

## Pick

Follow the horizon from intake:

- **Topic named** ("only the physics sessions") → `--grep` over titles and branches, then show what matched and
  what the filter excluded. A user who names a topic usually knows something you don't; honor it, but say what
  fell outside so they can correct the filter.
- **Days given** → `--days N`, then trim: sessions with 1–2 user turns are usually background jobs, not work.
- **Nothing given** → propose the last 14 days capped at the config's `max_sessions`, show the list, let them
  strike entries.

**Always exclude the current session by default** (`--exclude <sessionId>`). It is still being written, and it
contains this skill's own instructions — an agent reading it will dutifully "find" problems in the audit you are
running right now. The current session is the one with the newest `mtime` for this project; confirm it by its
title before excluding. Include it only if the user explicitly asks.

## State the budget before running anything

```
selected: <n> sessions · <total> MB · <date range>
excluded: <n> (current session, background jobs, outside horizon)
extract:  ~<n> KB slice   →  <n> agents on <model>
```

The slice is roughly 1% of raw size — a 2.4 MB session compresses to about 17 KB. That ratio is what makes the
audit affordable; if a selection is still too large after slicing, cut sessions, never raise the ceiling
silently. When you drop something to fit, say which ones and why — a silent cap reads as full coverage.

Wait for confirmation on the number when the user is present. If they said "decide for me" in intake, state the
budget anyway and proceed.

## Output of this mode

The confirmed session file list. Then go to `extract.md`.

## Do not

- Do not select by size alone. The biggest session is often a long grind on one problem; three small ones from
  different days usually carry more distinct signal.
- Do not silently include sidechains. Sub-agent turns are separate — the extractor counts them apart and they
  answer a different question ("what did the agents do") than the main thread.
