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
{"ts":"<iso>","audit":"<date>-<lens>","lens":"<item id or lens name>","claim":"<one line>","class":"<failure class>","anchor":"<session/ts>","verdict":"accepted|edited|rejected","applied":"<commit, path or null>","recur":<n or 0>}
```

- `lens` — required on every line, findings and changes alike: the mandatory item id as text (`"8"`, `"Ж"`) or the lens
  name (`"tokens"`, `"friction"`, `"free-reader"`) from `audit-mandatory-items.md`. A line without it lands in the
  «без линзы» history note, and `runs.mjs` prints how many there are.
- `class` — the failure class in one sentence, the same words each time the same problem comes up: the history matches
  returns on lens + class. The form words (missing, exists-but-did-not-fire, …) match nothing.
- **A fix that rotted** — the class is back after an accepted change — is one finding line in this shape, so every
  project writes it the same way:
  `"class":"fix-rotted","class_was":"<the class it had>","rotted_change":"C-<k>","fix_lived_days":<days from the change to the return>`.
  The history marks that change rotted with this lifetime (mandatory item 20 «Срок жизни правила»); a return nobody
  wrote this way is still caught by lens + class.

This is what keeps the next run from repeating this one. Rejected findings matter most — without them recorded,
the next audit cheerfully proposes the same thing again and the user loses trust in the tool.

Check the ledger at the start of `analyze.md`, write it at the end of this mode. Never rewrite past lines; a
finding that comes back after being rejected is new information, appended, not an edit of the old verdict.

Then record which items and lenses this run covered:
`node "$HOME/.claude/skills/chat-audit/lib/runs.mjs" record --project "<project id>" --audit "<audit id>" --items "<ids>" --lenses "<names>" --report "<report path>"`
(`--all-mandatory` when every mandatory item ran; omit empty flags). Run it from the project directory: it also
regenerates the project's lens history from the ledger (`--ledger <file>` when the ledger is elsewhere) — one note per
lens with lines, `<MIND_VAULT>/01 projects/chat-audit/history/<project>/<lens>.md`: what was found, what was changed,
the effect measured on this machine, whether the finding came back, which changes rotted and how long they lived. The
notes are generated: fix the ledger and run `runs.mjs refresh`, never edit a note. The project ledger stays on its
machine, while the run log and the notes sync everywhere — they let the reminder say which item has not been checked
for months, and the next run of a lens see what it already advised.

**Every accepted fix is a change line with a signal `effect.mjs` measures, 7 days before vs after.** The commit
alone says only that the artifact changed; `effect.mjs` reads config commits from git and checks the artifact is
alive. A `type:"change"` line — the same line `instructions-tuning` writes on its own edits — adds what liveness
cannot see, whether the behaviour moved. Without it the history can say a class came back, never whether the fix
worked: four token audits advised the same thing because no fix carried a number.

```json
{"type":"change","id":"C-<n+1>","ts":"<iso>","applied_at":"<iso, when logged after the fact>","lens":"<item id or lens name>","session":"<id8>","kind":"hook-guard|hook-injector|skill|rule|memory|agent|tool|settings",
 "paths":["…"],"commit":"<sha>|null","scope":"project|global","class":"<the failure class, one sentence>","trigger":"<session/ts of the complaint>",
 "supersedes":"C-<k>|null","co_changes":["C-<m>"],
 "signal":{"src":"assistant|user|tool:<Name>[.field]|skill|deny:<hook>|hooklog:<hook>|metric:<name>","re":"<regex>","want":"down|zero|up|present","by":0.1}|null,
 "signals_extra":[{"src":"metric:<name>","want":"down|up"}],
 "occasion":{"src":"…","re":"…"}|null,"baseline":null,"verdict":null}
```

`signal` names a line, a tool parameter, a skill load, a hook decision or a number the change should move; sources
and their default occasions are in the header of `lib/effect.mjs`. A number is `metric:<name>`: `want` down|up, `by`
the relative move that counts (default 0.1), more numbers in `signals_extra`, and a number taken by hand (a token
audit's table) as `baseline["<name>"]`. A tokens-lens fix always carries all three:

| what | `src` | `want` |
|---|---|---|
| median context of a main-session call | `metric:main-context-p50` | down |
| compactions per day | `metric:main-compactions-per-day` | down |
| cache-read share of input tokens | `metric:cache-read-share` | up |

No signal to name → `"signal":null` and the report says so: such a fix can be seen to come back, never to work. A fix
never measured keeps `"verdict":"unmeasured"`. Then freeze the baseline — transcripts older than ~30 days are deleted:
`node .claude/skills/chat-audit/lib/effect.mjs record --id C-<n>`. `record` rewrites only that line.

What a verdict asks for (`effect.mjs`, column `action`):

| verdict | next step |
|---|---|
| works | nothing |
| rotted (lens history) | the class came back after it; its lifetime is in the note — the next fix takes another form (see «Recurrence forces form») |
| alive (git rows) | runs; to know whether behaviour moved, add a ledger line with a signal |
| decaying | worked, but the last third of the window is back at the baseline: check the rule is still loaded and not superseded; it recurs after that → make it a hook |
| no-effect | reshape: an observable predicate, or a hook |
| dead | delete it or fold it into what fires |
| external (git rows) | a script starts it headless (`claude -p`, launchd, cron): no transcript names it, so there is no load to count — read that runner's log, never delete it on this table |
| harmful | fix or revert the same day |
| untested · unclear-window · unmeasurable | never cite as working; re-check next run, or add a signal |

The ledger is under `.claude/state/`, which installs ignore. To keep its history in git, make the state ignores
`.claude/state/**` (a directory pattern cannot be re-included) and put these two lines last in `.gitignore`:
`!.claude/state/**/` and `!.claude/state/chat-audit/ledger.jsonl`.

## Do not

- Do not apply anything the user did not accept, including "obvious" ones.
- Do not delete memory or rules as part of an audit. Propose removal; deletion is its own decision.
- Do not close with a summary of what you did. Close with what the user now has to decide or what changed.
