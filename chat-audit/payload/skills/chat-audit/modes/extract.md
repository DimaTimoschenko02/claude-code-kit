# Mode 3 — extract

Turn the selected sessions into a slice small enough for agents to read whole.

## Run all three

```bash
node .claude/skills/chat-audit/lib/extract.mjs --sessions <f1,f2,...> --out .claude/state/chat-audit/slice.json --summary
node .claude/skills/chat-audit/lib/analyze.mjs --project <dir> [--days N] --json > .claude/state/chat-audit/freq.json
node .claude/skills/chat-audit/lib/agents.mjs  --sessions <f1,f2,...> --json > .claude/state/chat-audit/agents.json
```

`agents.mjs` runs by default alongside the other two — it is cheap (pure Node, no agents dispatched) and the
main thread cannot see this material any other way: a `Task` call in the slice shows a description and a
duration, nothing about what happened inside. Skip it only when the selected sessions spawned no subagents
(check `agents` in `freq.json` first — zero agent calls means nothing under `subagents/` either).

They see different things and you need all three:

- **`extract.mjs`** — per session: user turns with timestamps and uuids (the anchors), turns flagged as
  corrections, interruptions, compactions, tool errors, agent spawns, skill invocations, hook firings,
  long turns, files touched, repeated commands.
- **`analyze.mjs`** — across all sessions: tool and binary frequencies, commands repeated 3+ times, retries
  (same command within 3 steps), code written inline from scratch, failures, files re-read across sessions,
  guardrail blocks and classifier denials.
- **`agents.mjs`** — inside every subagent the selected sessions spawned: duration, tool calls, tool errors by
  class (hook block, permission, timeout, not found, read-before-edit, exit code, other), the longest silent
  gap and where it fell, watchdog stalls, and user interruptions. Totals include agent-hours, error rate, hook
  blocks per hook, and agents that ran on the main session's model because none was set explicitly.

## What each signal means

Read the slice for these before dispatching agents — several findings fall out of the numbers alone:

| Signal | Reads as |
|---|---|
| `correctionHints` | user turns that LOOK like push-back (regex, ~43% recall measured) — a starting list, not a count; the real corrections come from an agent reading `--pairs` |
| `interruptions` | the user stopped the agent mid-flight; it was going somewhere they didn't want |
| repeated commands (3+) | a script that was never written |
| `inlineCode` with `candidate: true` | the same program rewritten from memory more than once — a tool waiting to exist |
| `retries` | the command didn't work the first time; either a gap in knowledge or a flaky path |
| files re-read across sessions | knowledge that should live in memory or instructions, being re-fetched instead |
| hook blocks on legitimate work | a guardrail that is too broad |
| `skillsActive` vs recon inventory | skills that exist and never fire |
| long turns + compactions | where context ran out; often where quality dropped |
| agent `errClasses` dominated by one class | a systemic gap (e.g. mostly `hook block`) rather than one-off flakiness |
| agent `maxGapSec` in the minutes | the agent stalled or waited on something silently — check `gapAt` against the tool call before it |
| agent `inherited: true` at volume | agents dispatched without an explicit model, burning the main session's model unnecessarily |

## Anchors

Every user turn in the slice carries `ts` and `uuid`, and every session its id. These are the anchors that make
findings checkable. Pass them through analysis untouched — a finding whose anchor cannot be resolved back to a
real turn does not survive `land.md`.

## Redaction

All three scripts route their output through `.claude/skills/chat-audit/lib/scrub.mjs`. It removes private keys, provider tokens, JWTs, auth
headers, credentials in URLs, secret-shaped assignments, one-time codes and long opaque blobs. Do not disable
it and do not paste raw transcript text around it — the report gets written into memory and committed.

If a needed quote looks like it contains a credential, cite the anchor and describe the content instead of
quoting it.

## Output of this mode

`slice.json` + `freq.json` + `agents.json` on disk, and the counts stated in one line. Then go to `analyze.md`.
