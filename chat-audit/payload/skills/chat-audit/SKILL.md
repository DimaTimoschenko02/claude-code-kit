---
name: chat-audit
description: Audit past Claude Code sessions to find how the work itself could go better — friction, gaps, repeated manual work, unrecorded knowledge, rules that exist but do not fire. Use when the user asks to look back over chats, sessions, transcripts or history ("re-read the last chats", "where could this have been faster", "what did I have to repeat", "перечитай последние чаты", "пройдись по чатам", "де можна було швидше"), asks what to automate or turn into a skill/hook/tool, asks why the same mistake keeps happening, or asks to review how they and the agent work together. Also use before writing a skill/hook meant to fix a recurring problem — the audit supplies the evidence for it.
---

# Chat audit

Reading past sessions to improve how the work is done — not to summarize what happened.

**The failure this skill exists to prevent:** a request like *"re-read the last chats and find where things could
be faster"* produces two vague bullet points. Not because the sessions lack material — because nothing defined
what "better" means, what will be done with a finding, or which sessions matter. An audit without a purpose
returns platitudes. Establish the purpose first, always.

## Non-negotiables

1. **Never skip intake.** Even when the request looks clear. `modes/intake.md` — one pass, then work.
2. **Never read raw transcripts with your own eyes.** They run to gigabytes. The `.claude/skills/chat-audit/lib/` scripts turn them into a
   small structured slice; agents read the slice. Reading raw `.jsonl` by hand burns the budget and finds less.
3. **Every finding carries an anchor** — session id + timestamp + quote. An agent's report is a claim until
   the anchor is checked. Findings without anchors are dropped, not softened.
4. **A finding that a rule already covers is a different, stronger finding.** "There is no rule for X" and
   "the rule for X exists and did not fire" demand opposite fixes. `modes/recon.md` runs before analysis so
   you can tell them apart.
5. **Propose, do not apply.** The audit ends in a proposal list the user accepts, edits or rejects, one by one.
6. **Repeat runs must not repeat findings.** Everything reported is logged to the ledger
   (`.claude/state/chat-audit/ledger.jsonl`). Check it before reporting; re-surface only what changed.

## Route

Run in order. Each mode file says what it needs and what it hands on.

| Step | Mode | Purpose |
|---|---|---|
| 0 | `modes/intake.md` | Establish goal, lens, horizon, and what a finding will become |
| 1 | `modes/recon.md` | Inventory the infra that already exists — skills, hooks, rules, memory |
| 2 | `modes/select.md` | Choose the sessions, agree the budget |
| 3 | `modes/extract.md` | Run the deterministic slice over the chosen sessions |
| 4 | `modes/analyze.md` | Dispatch agents per lens over the slice |
| 5 | `modes/memory-audit.md` | Check what should have been written down and was not |
| 6 | `modes/land.md` | Present proposals, apply what the user accepts, write the ledger |

Steps 1–2 may swap order when the user already named the sessions. Nothing else reorders.

## Tools

All under `.claude/skills/chat-audit/lib/`, all pure Node (no deps), all safe to run repeatedly:

```bash
node .claude/skills/chat-audit/lib/discover.mjs config    --project <dir>       # config dirs, memory, infra inventory
node .claude/skills/chat-audit/lib/discover.mjs sessions  --project <dir> [--days N] [--grep RE] [--exclude ID] [--scope exact|subtree|all]
node .claude/skills/chat-audit/lib/extract.mjs   --sessions a.jsonl,b.jsonl --out slice.json   # per-session slice, with user turns
node .claude/skills/chat-audit/lib/analyze.mjs   --project <dir> [--days N] [--section tools,bash,inline,fails,retries,reads,skills,agents,friction]
node .claude/skills/chat-audit/lib/memory-drift.mjs --project <dir> [--all]     # anchors in memory that no longer resolve
```

`extract.mjs` answers *what happened in these sessions* (turns, corrections, errors, anchors).
`analyze.mjs` answers *what happens repeatedly across many sessions* (frequencies, retries, hand-written code,
guardrail blocks). Use both — they see different things.

Everything they emit is redacted through `.claude/skills/chat-audit/lib/scrub.mjs` first: transcripts are full of live credentials and
audit reports get committed.

## Configuration

`.claude/chat-audit.config.json`, seeded on install. Read it in intake; it sets the agent model, default
horizon, session-size ceiling and where reports land. Never hardcode paths — memory location differs per
project and is discovered by `discover.mjs`.

## Cost

Agents, not the main session: a slice of 20 sessions does not fit a single context, and analysis is
parallel by nature. Default model comes from config (`sonnet` unless changed) — the main session stays the
orchestrator that decides, the agents only read and report.

Say the budget out loud before spending it: session count, megabytes and roughly what it costs. The user
approves the number, not a surprise.
