# chat-audit

Audit your own Claude Code sessions to find how the work could go better — friction, repeated manual work,
knowledge that never got written down, rules that exist but never fire.

Tier-2 package: a skill (router + 7 modes), seven dependency-free Node extractors, and one advisory hook.

## The problem it solves

Ask Claude *"re-read the last chats and find where things could have been faster"* and you get two vague
bullets. The sessions are full of material; the request has no goal, no lens and no destination, so there is
nothing to aim at. And gigabytes of `.jsonl` cannot be read by eye — so the model skims and generalizes.

This package fixes both halves:

- **Intake is mandatory.** Before any reading: what improves, which failure mode we hunt, which sessions, and
  what a finding becomes (skill? hook? memory? a line in CLAUDE.md?). Three questions maximum, each with a
  proposed answer, and a "decide for me" escape that records its assumptions.
- **Extraction is deterministic.** Node scripts turn transcripts into a slice roughly 1% of raw size — a 2.4 MB
  session becomes ~17 KB. Agents read the slice, never the raw files.

## Install

```bash
git clone https://github.com/DimaTimoschenko02/claude-code-kit
cd claude-code-kit/chat-audit
./install.sh /path/to/your/project      # or: ./install.sh   (current dir)
./install.sh --check /path/to/project   # installed vs package version
```

Requires `node` (runtime) and `jq` (install only). Works on any OS Claude Code runs on — nothing is
platform-specific and no path is hardcoded.

Then just ask, in your own words: *"пройдись по последним чатам, где я тебя дёргал по одному и тому же"*, or
*"what did I have to repeat this week"*. The hook routes it into the skill.

## What it looks at

| Signal | Reads as |
|---|---|
| corrections ("no, I meant…", "я же говорил") | the agent's default was wrong there |
| interruptions | it was going somewhere you didn't want |
| commands repeated 3+ times | a script that was never written |
| the same program typed inline twice | a tool waiting to exist |
| retries (same command within 3 steps) | a knowledge gap or a flaky path |
| files re-read across sessions | knowledge that belongs in memory, being re-fetched |
| hook blocks on legitimate work | a guardrail that is too broad |
| skills that exist and never fire | a trigger that doesn't trigger |
| memory anchors that no longer resolve | claims that went stale with the code |

## Findings have a shape

Every finding carries an anchor (session + timestamp + quote), a frequency, a cost, and a class:

- `missing` — nothing covers this ground
- `exists-but-did-not-fire` — a rule covers it and did not engage → the fix is form or enforcement, **never
  another rule**
- `exists-but-too-broad` — a guardrail blocked real work
- `already-solved` — dropped, not reported

Unanchored findings are dropped. Expensive findings get an adversarial second pass whose job is to kill them.

## It proposes; you decide

Nothing is applied without your acceptance, one finding at a time. Every verdict — including rejections — goes
to `.claude/state/chat-audit/ledger.jsonl`, so the next run doesn't re-propose what you already turned down.

## Tools

Usable standalone, without the skill:

```bash
lib/discover.mjs config   --project <dir>   # config dirs, memory locations, infra inventory
lib/discover.mjs sessions --project <dir> --days 14 [--grep RE] [--exclude ID-or-prefix,...] [--scope exact|subtree|all]
lib/extract.mjs  --sessions a.jsonl,b.jsonl --out slice.json --summary [--pairs 1600]
lib/analyze.mjs  --project <dir> --days 21 [--section tools,bash,inline,fails,retries,reads,skills,agents,friction]
lib/memory-drift.mjs --project <dir> [--all]        # anchors: file.ts#symbol (preferred), file.ts:NN, `sha`
lib/agent-cost.mjs   --sessions a.jsonl,b.jsonl [--per-session] [--json]
lib/tokens.mjs       [--project <dir>|--all|--dirs d1,d2] [--since YYYY-MM-DD] [--until ...] [--top N] [--json out.json]
```

`--pairs N` attaches the agent's reply that preceded each user turn (head + tail, N chars total). A user
message is a reaction to something; without the reply it answers, lenses like "the answer got better but is
still not what I want" or "I write X and the user never reacts" have nothing to read. Off by default — it
roughly doubles the slice.

`agent-cost.mjs` joins `<session>/subagents/agent-*.jsonl` with their `.meta.json` and reports token spend per
subagent type (calls, output, cache read/create, median and max per call) with the main thread as baseline —
the number behind "review agents on a one-line change".

`tokens.mjs` answers "where do the tokens go". On a long-context model almost all tokens are cache reads, so
spend is context size × number of calls, and a chunk costs its size × the calls that re-read it before the next
compaction. The script splits each call's context growth across what was appended since the previous call —
the previous output with exact counts (thinking stays in context), everything else by characters — and
reports that weighted cost by class: tool results per tool, Bash per command, Read per directory, hook output
per hook, startup overhead, post-compaction residue. Also: spend by project, origin (main / subagent type),
model and context-size bucket, cache rebuilds by cause (idle past TTL vs. a changed prefix), and the costliest
sessions. Dollars are API list prices — a weight, not a bill, on a subscription. It prints only class names,
command names and session titles, never transcript text.

`discover` finds things rather than assuming them: `CLAUDE_CONFIG_DIR` and sibling configs (dual-account
setups), `projects/` symlinked between accounts, and memory living in `.claude/memory/`, a symlink into a
notes vault, a directory inside the transcript folder, or nowhere at all — all of which occur in real setups.

Everything they print goes through `lib/scrub.mjs`: private keys, provider tokens, JWTs, auth headers,
credentials in URLs, secret-shaped assignments and one-time codes are redacted before they can land in a report
you commit.

## Config

`.claude/chat-audit.config.json`:

```json
{
  "agent_model": "sonnet",        // analysis runs on agents, not your main session
  "default_days": 14,
  "max_sessions": 20,
  "max_slice_kb": 600,
  "exclude_current_session": true, // it's still being written, and it contains the skill's own instructions
  "default_lenses": ["friction", "repetition"],
  "report_dir": null,             // null -> the memory location discovery found
  "nudge": false                  // the UserPromptSubmit nudge; off by default since 1.1.0 — it fired on any
                                  // mention of the word "chat-audit"; set true if you want the reminder
}
```

## Credits

The frequency and drift analysis is a generalized port of three tools built for a private workspace:
`transcript-stats.py`, `hook-friction.py`, `memory-drift.py`.

## Uninstall

```bash
./uninstall.sh /path/to/project [--purge]   # --purge also drops config and ledger
```

## Changes

- **1.5.0** (2026-10-02) — `effect.mjs`: did a change to the agent's own infrastructure work. Reads
  `type:"change"` ledger lines (new record type, written by `instructions-tuning` and by `land.md` for applied
  findings), counts each line's signal 7 days before vs since over main and subagent transcripts plus the hook log
  (`.claude/state/hooks/*.jsonl`), and prints a verdict per change; `record` freezes the baseline into the line.
  Dedup by tool_use id / tool_use_id / message id; a deny must be the tool result itself (quotes in reports are
  not), hook test harness calls and the ±2 h authoring window are dropped from action signals, heredoc bodies are
  data. `recon.md` runs it first.
- **1.4.0** (2026-09-23) — `agents.mjs`: new step reading subagent transcripts (`<session>/subagents/**/*.jsonl` +
  `.meta.json`) — duration, tool errors by class, silent gaps, watchdog stalls, interruptions; run by default in
  `extract.md`, sourced by an `agents` lens in `analyze.md`. `analyze.md`: free reader (one agent per shard, no
  lens, proposes candidate lenses) dispatched by default; "a lens names its own sources" rule. `discover.mjs`:
  automatic security-review sessions (the review hook's own prompt) marked `auto` and excluded by default
  (`--include-auto` to include, excluded count printed). `memory-drift.mjs`: `--fail-on high|medium` sets the
  exit code; two `missing-commit` false positives dropped (a session's own short id, a file's magic-number
  signature). `scrub.mjs`: redacts a `user \`x\` / \`password\`` style DB credential (mixed-case alphanumeric
  12+ token after a slash+space) without touching filesystem paths.
- **1.3.0** (2026-09-16) — `tokens.mjs`: token spend attributed to content classes. `agent-cost`: usage is
  counted once per API response (it was summed per content-block line, inflating every figure).
- **1.2.0** (2026-09-06) — `discover`: `--days` filters by session START (mtime is only a pre-filter), `userTurns`
  counts human turns only (tool_result records excluded; the old number was ~10× inflated), `--exclude` accepts
  id prefixes. `extract`: `corrections` → `correctionHints` (regex recall measured at 43%). `memory-drift`:
  `file.ts#symbol` anchors resolved inside the named file (`symbol-not-in-file`). Modes: agents return text,
  never write files; recurrence ≥2 forces a predicate/hook (`recur` in the ledger); `example ?? shape` in
  `analyze` tables.
- **1.1.0** — `extract --pairs`, `agent-cost.mjs`, memory-drift fixes (worktrees, same-basename, `.claude` indexed),
  nudge off by default.
