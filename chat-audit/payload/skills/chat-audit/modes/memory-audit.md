# Mode 5 — memory audit

The other half of the picture. Analysis asks *what went wrong in the sessions*; this asks *what the project
knows but never wrote down, and what it wrote down that is no longer true.*

Skip only if recon found no memory anywhere — then the single finding is "there is no durable memory; here is
what a first entry would hold", built from the strongest repeated facts in the slice.

## Four checks

**1. Learned and not written.** From the slice: facts established in a session that never reached memory or
instructions. Strongest signals — files re-read across sessions (`analyze.mjs` → `rereadFiles`), the same
question answered more than once, the same investigation repeated. Each is a candidate memory entry, and the
cost is already measured: the turns spent re-deriving it.

**2. Written and rotten.**

```bash
node .claude/skills/chat-audit/lib/memory-drift.mjs --project <dir>
```

Reports memory anchors that no longer resolve, by severity:

- `high` — `line-out-of-range`, `missing-file`: the code moved. The claim next to the anchor is suspect.
- `medium` — `missing-commit`: a referenced commit is gone (squashed, rebased, or a deleted branch).
- `low` — `missing-symbol`: hidden by default; a weak heuristic that also trips on external APIs, DB objects
  and ordinary prose in backticks. Pass `--all` only when hunting specifically.

Report `high` findings with the surrounding claim, not just the anchor — the anchor is the symptom, the claim
is what the user has to judge.

**3. Written and never used.** Memory files whose subject never appears in the audited sessions, while adjacent
work happened. Either the knowledge is stale, or it is not reachable — the index entry does not say what would
make someone open it. Both are worth one line each; neither is worth deleting on your own initiative.

**4. Rules that keep failing.** If the project keeps a log of past corrections (a learning log, a resolutions
registry, a decisions file — recon found it or it does not exist), cross it against this run's findings. A
problem that was addressed before and is back is the most important output the audit can produce: the previous
fix had the wrong form, and repeating it produces the same result. Say so explicitly, with both dates.

## Output of this mode

Findings in the same shape as `analyze.md`, tagged `source: memory`. Then go to `land.md`.

## Do not

- Do not rewrite memory here. This mode reports; `land.md` proposes; the user decides.
- Do not report every `low` drift finding. They are hidden by default for a reason — a wall of weak signals
  buries the few precise ones.
- Do not treat a scratch day-log as durable memory. `discover.mjs` labels those `remember-plugin`, and
  `memory-drift.mjs` skips them unless asked; their anchors are supposed to rot.
