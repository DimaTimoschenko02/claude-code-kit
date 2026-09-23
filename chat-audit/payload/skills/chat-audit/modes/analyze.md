# Mode 4 — analyze

Dispatch one agent per lens over the slice, then verify what comes back.

## Dispatch

One agent per lens chosen in intake. They are independent — send them in a single message so they run in
parallel. Model comes from `chat-audit.config.json` (`agent_model`, default `sonnet`); the main session stays
the orchestrator and does not do the reading.

Each agent gets, in its prompt:

1. **The slice** — path to `slice.json` and `freq.json`, plus which sections matter for its lens, plus any
   extra source the lens named (see "a lens names its own sources" below).
2. **The recon inventory** — skills, hooks, rules, memory location, claimed CLAUDE.md headings. Without this it
   reports things that already exist.
3. **The goal and destination** from intake — a finding aimed at a hook must name a deterministic trigger; one
   aimed at memory must state a durable fact. Tell the agent what shape its output has to take.
4. **The ledger** — findings already reported in past runs (`.claude/state/chat-audit/ledger.jsonl`), so it
   does not resurface them.

## Free reader

Dispatched alongside the lens agents by default, one per shard, no lens at all. Its job isn't findings — it's
naming lenses nobody defined yet. Same slice and recon inventory, no goal/destination framing. Required output
per candidate:

```
name:      <short lens name>
catches:   <what kind of problem this would surface>
anchors:   <2+ from the slice showing the pattern actually occurs>
count:     <how many times, in this shard>
sources:   <what a real lens using this would need beyond slice.json/freq.json>
```

Accepted 2026-09-23. A candidate goes through the same verification as a finding — an anchor that doesn't
resolve kills the candidate too.

## A lens names its own sources

Most lenses read only `slice.json` + `freq.json`. A lens that needs more says so in its own dispatch, and the
orchestrator supplies it before sending the agent — never after, as a follow-up round-trip:

| Extra need | Source |
|---|---|
| what a spawned agent actually did (not just its description + duration) | `agents.mjs` → `agents.json` |
| the full reply a user turn reacted to, not just the turn | `extract.mjs --pairs` |
| what shipped, not just what was discussed | `git log` in the project repo(s) |
| what the day was supposed to be | `memory/plans/YYYY-MM-DD.md` (or this project's equivalent) |

`agents` lens: source is `agents.json`, not the slice — the main thread's transcript never shows what happened
inside a `Task` call, only its description and duration. Looks for agents that stalled (`maxGapSec`, watchdog
events), hit one tool-error class repeatedly, or ran `inherited: true` — no explicit model, burning whatever
the main session happened to be running on. Anchor is `parent session (8 chars) + agentId`, plus `gapAt` or an
event timestamp where relevant — not a user-turn uuid; say so, or `land.md` will look for one and find none.

Agents return **text**, in the shape below, and nothing else. Never ask an agent to write a file: a
subagent's Write is refused by the harness ("subagents return text"), and the orchestrator then re-types
the report by hand — ~30k tokens of context for four agents (2026-09-06). Files are written once, in
`land.md`, by the orchestrator.

## Required output shape

Every finding, no exceptions:

```
claim:       <one sentence — what is wrong or missing>
evidence:    <session id + timestamp + short quote or exact count>
frequency:   <how many times, across how many sessions>
class:       missing | exists-but-did-not-fire | exists-but-too-broad | already-solved
cost:        <what it costs now — turns wasted, work redone, question re-asked>
fix:         <concrete: which skill/hook/memory file/instruction line, and what it says>
confidence:  high | medium | low
```

`class` is the field that makes the audit useful. Cross-check against recon before assigning it:

- **missing** — nothing in the inventory covers this ground.
- **exists-but-did-not-fire** — a skill, hook or rule covers it and the transcript shows it did not engage.
  The fix is never "write another rule"; it is form, placement or enforcement.
- **exists-but-too-broad** — a guardrail blocked legitimate work. Evidence is the block plus what was being
  attempted.
- **already-solved** — covered and working. Drop it, do not report it.

## Verify before reporting

An agent's report is a claim. Cheap verification, in this order:

1. **Anchor resolves.** The session id and timestamp point at a real turn saying what the agent says it says.
   Unresolvable anchor → drop the finding.
2. **Count is real.** If the claim is "N times", it came from `freq.json`, not from the agent's impression.
3. **Not already covered.** Check the named skill/hook/rule actually lacks it — read that file now, not the
   whole inventory.

For findings that would cost real work to act on (a new hook, a rewritten skill), send a second agent to argue
the opposite: *"here is the claim and the evidence — show why this is not worth doing"*. A finding that
survives a hostile read is worth the user's attention; one that doesn't was going to waste their afternoon.

Skip the adversarial pass for cheap findings — a one-line memory entry costs less to accept than to double-check.

## Rank

Order by `frequency × cost`, not by severity of language. Something that cost two turns fifteen times beats a
dramatic one-off. Note the one-off separately if it was expensive enough.

## Output of this mode

The verified, ranked finding list. Then go to `memory-audit.md`.

## Do not

- Do not let one agent take every lens. Lens diversity is the point — a single reader finds one kind of thing.
- Do not accept findings without frequency. "Sometimes the agent does X" is not actionable; "6 times across
  4 sessions" is.
- Do not report style opinions about the transcripts. The subject is the work, not the prose.
