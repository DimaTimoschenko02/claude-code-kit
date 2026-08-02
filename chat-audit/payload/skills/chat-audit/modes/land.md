# Mode 6 — land

Turn verified findings into changes the user accepts one by one, then record what was said so the next run
starts where this one stopped.

## Present

Ranked list, most valuable first. One block per finding, short enough to decide on without opening anything:

```
[1] <claim in one sentence>
    seen:  <N times across M sessions> · <anchor: session/timestamp>
    class: missing | exists-but-did-not-fire | exists-but-too-broad
    costs: <what it costs today>
    fix:   <exact change: file, and what it would say>
    →      accept / edit / reject ?
```

Group by destination — memory entries together, instruction edits together, new skills/hooks together. The
user is deciding in batches, not reading a report.

Then the counts: how many findings, how many dropped in verification, what was excluded from the audit and why.
State the coverage honestly — sessions skipped for budget are sessions unexamined, and a silent cap reads as
full coverage when it was not.

## Apply

Only what the user accepted, and only the accepted form of it.

| Destination | Where it goes | Owner skill |
|---|---|---|
| durable fact | the memory location recon found | project's memory convention |
| rule / instruction | `CLAUDE.md`, `AGENTS.md`, `.claude/rules/` | `instructions-tuning` if installed |
| new or changed skill | `.claude/skills/<name>/` | `instructions-tuning` if installed |
| deterministic guarantee | a hook | `hookify` if installed, else write it plainly |
| repeated command / inline code | a script in the project's tools directory | — |

Two rules when applying:

- **Route through the owner skill when one exists.** A rule that keeps being ignored usually has the wrong
  form, not the wrong words, and that is exactly what those skills diagnose. Writing more prose at a rule that
  already failed is the mistake this audit exists to catch.
- **A `exists-but-did-not-fire` finding never gets a second rule.** Change form, placement, or make it
  deterministic. Two rules saying the same thing is how instruction files rot.

## Write the report

To the memory location from recon, as `audits/<YYYY-MM-DD>-<lens>.md` (or the config's `report_dir`):
goal, horizon, sessions audited, findings with anchors, decisions taken. This is the artifact someone reads in
three months to know what was already looked at.

If the project routes all memory writes through its own skill, use it — do not write around a project's
convention just because this skill has a path.

## Write the ledger

`.claude/state/chat-audit/ledger.jsonl`, one line per finding, whatever the verdict:

```json
{"ts":"<iso>","audit":"<date>-<lens>","claim":"<one line>","class":"<class>","anchor":"<session/ts>","verdict":"accepted|edited|rejected","applied":"<path or null>"}
```

This is what keeps the next run from repeating this one. Rejected findings matter most — without them recorded,
the next audit cheerfully proposes the same thing again and the user loses trust in the tool.

Check the ledger at the start of `analyze.md`, write it at the end of this mode. Never rewrite past lines; a
finding that comes back after being rejected is new information, appended, not an edit of the old verdict.

## Do not

- Do not apply anything the user did not accept, including "obvious" ones.
- Do not delete memory or rules as part of an audit. Propose removal; deletion is its own decision.
- Do not close with a summary of what you did. Close with what the user now has to decide or what changed.
