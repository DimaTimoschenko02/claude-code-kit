# instructions-tuning

A skill for editing the files an agent reads to decide how to behave — plus a
**determinism hook (skill-gate)** that makes the agent actually invoke that skill
before touching those files.

- **Skill:** `instructions-tuning` — diagnoses *why* an instruction fails and picks
  the right form (prohibition / positive recipe / structural slot / predicate /
  hook) under a conciseness + altitude budget.
- **Gate:** `skill-gate-guard.sh` (PreToolUse Write|Edit) — blocks an edit to a
  *governed* path until its owner skill was invoked **this context window**. Pure
  prose is advisory; the gate is the deterministic backstop for "must invoke first".
- **Config-driven:** which paths require which skill is a per-project JSON map. The
  hook is generic — it can gate any skill, not only `instructions-tuning`.
- **Portability:** drops into any project (plain git repo or notes vault). Requires `jq`.

---

## Why the gate exists

The recurring failure: the agent edits an instruction file (CLAUDE.md, a SKILL.md,
a convention) **without first invoking the owner skill**, even when a rule says to —
then rationalizes the skip ("the skill is already loaded"). Advisory prose doesn't
hold under that pressure. Per the skill's own matrix this is a *determinism failure*
→ the right form is a hook, not stronger wording. skill-gate is that hook.

It is keyed to the **context-reset boundary**, not per-edit: a skill's text persists
across turns, so one invocation per window is enough — but `/compact` summarizes the
skill text out of context, so a pre-compact invocation no longer counts and the gate
asks for a fresh one. (Per-turn enforcement is both overkill and unworkable — tool
results are recorded as user turns, so a "last user message" boundary would drift.)

## Requirements

- `bash`, `jq` (≥1.6).
- Windows: **Git for Windows** (Git Bash). Clone with `git` (don't download the ZIP).

## Install

```bash
git clone <this-repo> claude-code-kit
cd claude-code-kit/instructions-tuning
./install.sh /path/to/your/project      # or: ./install.sh   (from inside the target)
```

- Re-run any time to upgrade. Your `skill-gate.config.json` and state are preserved.
- Report installed vs package version: `./install.sh --check /path/to/project`.

### Global skill (optional)

By default the skill installs project-local (`.claude/skills/instructions-tuning/`).
To share one copy across projects, also copy it to `~/.claude/skills/instructions-tuning/`
— the hooks and config stay per-project regardless.

## What gets installed

```
<project>/.claude/
├── skills/instructions-tuning/SKILL.md   # the skill (package-managed)
├── hooks/
│   ├── skill-gate-guard.sh               # PreToolUse[Write|Edit] — the gate
│   └── skill-invocation-log.sh           # PostToolUse[Skill] — records invocations
├── skill-gate.config.json                # YOUR path->skill gates (commit this; edit it)
└── state/skill-invocations.jsonl         # per-machine, gitignored
```

Side effects: registers the two hooks in `.claude/settings.json` (idempotent atomic
merge); appends a `# >>> instructions-tuning >>>` block to `.gitignore` for `.claude/state/`.

## Configure the gates

`.claude/skill-gate.config.json` — a `gates` array. Each entry maps a path to the
skill that must be invoked before editing it. `path_prefix` matches a directory
(string prefix of the project-relative path); `path_exact` matches one file.

```json
{
  "gates": [
    { "path_prefix": ".claude/skills/", "skill": "instructions-tuning" },
    { "path_prefix": ".claude/hooks/",  "skill": "instructions-tuning" },
    { "path_exact":  "CLAUDE.md",       "skill": "instructions-tuning" },
    { "path_prefix": "tasks/",          "skill": "task" }
  ]
}
```

- First matching gate wins.
- A `skill` name need not ship in this package — point a gate at any project-local
  skill (e.g. `task`). The gate only checks that `/skill` was invoked; it doesn't
  load it.
- No config file, or no gate matches → nothing is blocked (fail-open).

## How a block looks

Editing a governed path with no fresh invocation → the Write/Edit is denied with:

```
🚧 skill-gate: editing ".claude/skills/foo/SKILL.md" requires the owner skill
/instructions-tuning, but /instructions-tuning has not been invoked since the
last context reset (session start or /compact). Invoke /instructions-tuning FIRST,
then retry the edit.
```

Invoke the named skill, then redo the edit — it passes.

## Fail-open by design

The gate blocks **only when it can prove** the required skill was not invoked since
the boundary. Any missing input — no transcript, no log, unparseable config,
`jq` absent, a forked `claude -p` (`CCLL_INACTIVE=1`) — exits 0 and allows the edit.
It never blocks on uncertainty.

## Shared logger

`skill-invocation-log.sh` is also shipped by **cc-learning-log** (its classifier reads
the same `skill-invocations.jsonl` to attribute behaviors). The jsonl schema +
location are the shared contract; the two implementations emit identical records.
The installer keeps an existing copy rather than clobbering it, so install order
doesn't matter and the two packages coexist.

## Uninstall

```bash
./uninstall.sh /path/to/project            # remove the gate hook + its entry; keep skill, config, logger
./uninstall.sh /path/to/project --purge    # also remove skill, config, version, gitignore block, logger (if we added it)
```
