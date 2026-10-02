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
- **Recurrence forces form.** Before proposing prose, count how often this class was already "fixed":
  the ledger's earlier lines for the same `class`/claim, and the project's own recurrence registry if it
  keeps one (a learning-log with `Recur` counts, a resolutions file). Seen twice or more → the destination
  is an observable predicate or a hook, never prose; prose is reserved for a judgment gap with no
  predicate. Record the count as `recur` in the ledger line. Why: every class that recurred under a
  prose fix ended up closed by a hook anyway; the prose rounds in between were waste.

## Write the report

To the memory location from recon, as `audits/<YYYY-MM-DD>-<lens>.md` (or the config's `report_dir`):
goal, horizon, sessions audited, findings with anchors, decisions taken. This is the artifact someone reads in
three months to know what was already looked at.

If the project routes all memory writes through its own skill, use it — do not write around a project's
convention just because this skill has a path.

## Write the ledger

`.claude/state/chat-audit/ledger.jsonl`, one line per finding, whatever the verdict:

```json
{"ts":"<iso>","audit":"<date>-<lens>","claim":"<one line>","class":"<class>","anchor":"<session/ts>","verdict":"accepted|edited|rejected","applied":"<path or null>","recur":<n or 0>}
```

This is what keeps the next run from repeating this one. Rejected findings matter most — without them recorded,
the next audit cheerfully proposes the same thing again and the user loses trust in the tool.

Check the ledger at the start of `analyze.md`, write it at the end of this mode. Never rewrite past lines; a
finding that comes back after being rejected is new information, appended, not an edit of the old verdict.

**A change line per applied change.** Every accepted finding that changes a hook, skill, rule, memory note, agent,
tool or setting also gets a `type:"change"` line — the same line `instructions-tuning` writes on its own edits —
so a later `effect.mjs` run can say whether it worked:

```json
{"type":"change","id":"C-<n+1>","ts":"<iso>","session":"<id8>","kind":"hook-guard|hook-injector|skill|rule|memory|agent|tool|settings",
 "paths":["…"],"commit":"<sha>|null","scope":"project|global","class":"<the failure class, one sentence>","trigger":"<session/ts of the complaint>",
 "supersedes":"C-<k>|null","co_changes":["C-<m>"],
 "signal":{"src":"assistant|user|tool:<Name>[.field]|skill|deny:<hook>|hooklog:<hook>","re":"<regex>","want":"down|zero|up|present"}|null,
 "occasion":{"src":"…","re":"…"}|null,"baseline":null,"verdict":null}
```

`signal` names a line, a tool parameter, a skill load or a hook decision the change should move; sources and
their default occasions are in the header of `lib/effect.mjs`. `signal:null` is allowed and is reported as
`unmeasurable` at every audit. Then freeze the baseline — transcripts older than ~30 days are deleted:
`node .claude/skills/chat-audit/lib/effect.mjs record --id C-<n>`. `record` rewrites only that line.

What a verdict asks for (`effect.mjs`, column `action`):

| verdict | next step |
|---|---|
| works | nothing |
| decaying | worked, but the last third of the window is back at the baseline: check the rule is still loaded and not superseded; it recurs after that → make it a hook |
| no-effect | reshape: an observable predicate, or a hook |
| dead | delete it or fold it into what fires |
| harmful | fix or revert the same day |
| untested · unclear-window · unmeasurable | never cite as working; re-check next run, or add a signal |

The ledger is under `.claude/state/`, which installs ignore. To keep its history in git, make the state ignores
`.claude/state/**` (a directory pattern cannot be re-included) and put these two lines last in `.gitignore`:
`!.claude/state/**/` and `!.claude/state/chat-audit/ledger.jsonl`.

## Do not

- Do not apply anything the user did not accept, including "obvious" ones.
- Do not delete memory or rules as part of an audit. Propose removal; deletion is its own decision.
- Do not close with a summary of what you did. Close with what the user now has to decide or what changed.
