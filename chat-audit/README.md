# chat-audit

Audit your own Claude Code sessions to find how the work could go better — friction, repeated manual work,
knowledge that never got written down, rules that exist but never fire.

Tier-2 package: a skill (router + 7 modes), five dependency-free Node extractors, and one advisory hook.

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
lib/discover.mjs sessions --project <dir> --days 14 [--grep RE] [--scope exact|subtree|all]
lib/extract.mjs  --sessions a.jsonl,b.jsonl --out slice.json --summary
lib/analyze.mjs  --project <dir> --days 21 [--section tools,bash,inline,fails,retries,reads,skills,agents,friction]
lib/memory-drift.mjs --project <dir> [--all]
```

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
  "nudge": true                   // false disables the hook without uninstalling
}
```

## Credits

The frequency and drift analysis is a generalized port of three tools built for a private workspace:
`transcript-stats.py`, `hook-friction.py`, `memory-drift.py`.

## Uninstall

```bash
./uninstall.sh /path/to/project [--purge]   # --purge also drops config and ledger
```
