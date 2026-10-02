---
name: chat-audit
description: Audit past Claude Code sessions to find how the work itself could go better — friction, gaps, repeated manual work, unrecorded knowledge, rules that exist but do not fire. Use only when the user explicitly asks to run a chat audit ("run chat-audit", "запусти чат-аудит", "проведём chat-audit"); a full audit is a deliberate, budgeted run, so it never starts on its own from a general question about past sessions.
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

All in `lib/` next to this SKILL.md (the skill's base directory), pure Node (no deps), safe to run repeatedly.
The commands below and in the mode files spell it `.claude/skills/chat-audit/lib/` — a project install. With
the global install (`~/.claude/skills/chat-audit/`) the project has no copy: run the same commands from
`~/.claude/skills/chat-audit/lib/`. State (`.claude/state/chat-audit/`) stays in the project either way.

```bash
node .claude/skills/chat-audit/lib/discover.mjs config    --project <dir>       # config dirs, memory, infra inventory
node .claude/skills/chat-audit/lib/discover.mjs sessions  --project <dir> [--days N] [--grep RE] [--exclude ID] [--scope exact|subtree|all] [--include-auto]
node .claude/skills/chat-audit/lib/extract.mjs   --sessions a.jsonl,b.jsonl --out slice.json   # per-session slice, with user turns
node .claude/skills/chat-audit/lib/analyze.mjs   --project <dir> [--days N] [--section tools,bash,inline,fails,retries,reads,skills,agents,friction]
node .claude/skills/chat-audit/lib/agents.mjs    --project <dir> [--days N] | --sessions a.jsonl,b.jsonl [--json]  # subagent transcripts: duration, tool errors by class, gaps, stalls
node .claude/skills/chat-audit/lib/memory-drift.mjs --project <dir> [--memory <dir>] [--fail-on high|medium] [--all]  # anchors in memory that no longer resolve
node .claude/skills/chat-audit/lib/tokens.mjs    [--project <dir>|--all] [--since YYYY-MM-DD] [--top N]  # what the tokens are spent ON
node .claude/skills/chat-audit/lib/effect.mjs    [--project <dir>] [--id C-n,..] [--now <iso>] [--json]  # did each recorded .claude change work
node .claude/skills/chat-audit/lib/effect.mjs    record (--id C-n | --all) [--project <dir>]   # freeze a change line's 7-day baseline
```

`extract.mjs` answers *what happened in these sessions* (turns, corrections, errors, anchors).
`analyze.mjs` answers *what happens repeatedly across many sessions* (frequencies, retries, hand-written code,
guardrail blocks). Use both — they see different things.
`agents.mjs` answers *what happened inside the agents the main thread spawned* — a `Task` call in the main
transcript shows only a description and a duration; the subagent's own transcript
(`<session-dir>/subagents/**/*.jsonl` + sibling `.meta.json`) is where the tool errors, silent gaps and
watchdog stalls actually live. Cheap and agent-free, so `extract.md` runs it by default.
`effect.mjs` answers *did our own changes work*: for every `type:"change"` ledger line (a hook, skill, rule, memory
note, agent, tool or setting the project changed) it counts the line's signal 7 days before vs since and gives a
verdict (works · decaying · no-effect · dead · untested · harmful · unclear-window · unmeasurable). `recon.md` runs it first.
`tokens.mjs` answers *what the spend consists of*: every call re-reads the whole context, so it attributes
each call's context growth to what was appended (tool result by tool and command, hook output, thinking,
compaction residue, startup overhead) and weights it by how many later calls re-read it. Use it when the
question is cost or limits, not friction.

Everything they emit is redacted through `.claude/skills/chat-audit/lib/scrub.mjs` first: transcripts are full of live credentials and
audit reports get committed.

## Configuration

`.claude/chat-audit.config.json` in the project, seeded by a project install. Read it in intake; it sets the
agent model, default horizon, session-size ceiling and where reports land. No config in the project (a global
install seeds none) → use the kit defaults (`agent_model: sonnet`, 14 days, 20 sessions, lenses friction +
repetition) and say so in the intake block. Never hardcode paths — memory location differs per project and
is discovered by `discover.mjs`.

## Cost

Agents, not the main session: a slice of 20 sessions does not fit a single context, and analysis is
parallel by nature. Default model comes from config (`sonnet` unless changed) — the main session stays the
orchestrator that decides, the agents only read and report.

Say the budget out loud before spending it: session count, megabytes and roughly what it costs. The user
approves the number, not a surprise.
