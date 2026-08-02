# Mode 3 — extract

Turn the selected sessions into a slice small enough for agents to read whole.

## Run both

```bash
node .claude/skills/chat-audit/lib/extract.mjs --sessions <f1,f2,...> --out .claude/state/chat-audit/slice.json --summary
node .claude/skills/chat-audit/lib/analyze.mjs --project <dir> [--days N] --json > .claude/state/chat-audit/freq.json
```

They see different things and you need both:

- **`extract.mjs`** — per session: user turns with timestamps and uuids (the anchors), turns flagged as
  corrections, interruptions, compactions, tool errors, agent spawns, skill invocations, hook firings,
  long turns, files touched, repeated commands.
- **`analyze.mjs`** — across all sessions: tool and binary frequencies, commands repeated 3+ times, retries
  (same command within 3 steps), code written inline from scratch, failures, files re-read across sessions,
  guardrail blocks and classifier denials.

## What each signal means

Read the slice for these before dispatching agents — several findings fall out of the numbers alone:

| Signal | Reads as |
|---|---|
| `corrections` | the agent's default was wrong here — the highest-value lines in any transcript |
| `interruptions` | the user stopped the agent mid-flight; it was going somewhere they didn't want |
| repeated commands (3+) | a script that was never written |
| `inlineCode` with `candidate: true` | the same program rewritten from memory more than once — a tool waiting to exist |
| `retries` | the command didn't work the first time; either a gap in knowledge or a flaky path |
| files re-read across sessions | knowledge that should live in memory or instructions, being re-fetched instead |
| hook blocks on legitimate work | a guardrail that is too broad |
| `skillsActive` vs recon inventory | skills that exist and never fire |
| long turns + compactions | where context ran out; often where quality dropped |

## Anchors

Every user turn in the slice carries `ts` and `uuid`, and every session its id. These are the anchors that make
findings checkable. Pass them through analysis untouched — a finding whose anchor cannot be resolved back to a
real turn does not survive `land.md`.

## Redaction

Both scripts route their output through `.claude/skills/chat-audit/lib/scrub.mjs`. It removes private keys, provider tokens, JWTs, auth
headers, credentials in URLs, secret-shaped assignments, one-time codes and long opaque blobs. Do not disable
it and do not paste raw transcript text around it — the report gets written into memory and committed.

If a needed quote looks like it contains a credential, cite the anchor and describe the content instead of
quoting it.

## Output of this mode

`slice.json` + `freq.json` on disk, and the counts stated in one line. Then go to `analyze.md`.
