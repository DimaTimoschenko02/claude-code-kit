# claude-code-kit

A small, opinionated kit of reusable [Claude Code](https://claude.com/claude-code) pieces —
skills and PreToolUse/SessionStart hooks — that are generic enough to drop into any project.

Everything here is **project-agnostic**: no personal paths, no vault-specific wiring. The bits
that were originally coupled to a particular setup have been decoupled before publishing.

## What's inside

### Skills (`skills/`)

| Skill | What it does |
|---|---|
| **research** | A cost-aware web-research dispatcher. Triages trivial lookups to a single `WebSearch`, routes real research through a tiered workflow engine (lite/normal/deep) with per-phase model routing (Haiku/Sonnet/Opus). Ships its engine as `research.js` (a Workflow script). |

### Hooks (`hooks/`)

| Hook | Event | What it does |
|---|---|---|
| **block-secrets.sh** | PreToolUse | Blocks the agent from reading or exfiltrating credentials — sensitive file paths, env dumps, keychain/cloud-secret-manager reads, token-printing CLI commands. Defense-in-depth against accidental leaks (not a determined adversary). |
| **block-env-files.sh** | PreToolUse | Blocks reading/copying/sourcing any `.env` file (templates like `.env.example` are whitelisted). Complements `block-secrets.sh`. |
| **memory-checkpoint.sh** | SessionStart (`compact`) | After a context compaction, nudges the agent to review whether anything durable should be written to its persistent memory. |

### instructions-tuning (`instructions-tuning/`)

A self-contained, installable package pairing the **instructions-tuning skill** (above)
with a **determinism hook, skill-gate**, that makes the agent actually invoke that skill
before editing a governed file (CLAUDE.md, a SKILL.md, a convention…). Which paths require
which skill is a per-project `skill-gate.config.json` map — the hook is generic and can
gate any skill, not just `instructions-tuning`. Keyed to the context-reset boundary
(one invocation per session / `/compact` window). Its own `README.md` / `install.sh` /
`VERSION`. See [`instructions-tuning/README.md`](instructions-tuning/README.md).

### chat-audit (`chat-audit/`)

A self-contained, installable package that audits your **past Claude Code sessions** to find how the work
itself could go better — friction, work repeated by hand, knowledge never written down, rules that exist but
never fire. It exists because the obvious version of this request ("re-read the last chats and find where
things could be faster") reliably returns two vague bullets: nothing defined what "better" means, and
gigabytes of `.jsonl` cannot be read by eye. So the skill makes intake mandatory (goal, lens, horizon, and
what a finding becomes) and does the reading with deterministic Node extractors that compress a session to
~1% of its size before an agent sees it. Findings carry anchors, get classified against the infra that
already exists, and are proposed — never applied — with every verdict logged so repeat runs don't repeat
themselves. Its own `README.md` / `install.sh` / `VERSION`.
See [`chat-audit/README.md`](chat-audit/README.md).

### Learning log (`learning-log/`)

A self-contained, installable package: a self-learning log for Claude Code that captures the
agent's mistakes and reusable wins over time, with a classifier and per-chat opt-out. It keeps
its own `README.md` / `install.sh` / `VERSION` and is versioned independently — this repo
absorbed its history rather than re-starting it. See [`learning-log/README.md`](learning-log/README.md).

## Install

These are building blocks, not a framework — copy what you want.

- **Skills** → copy the folder into `.claude/skills/<name>/` (project) or `~/.claude/skills/<name>/`
  (global). For `research`, also copy `skills/research/research.js` to `.claude/workflows/research.js`
  so `Workflow({name:"research"})` resolves.
- **Hooks** → copy the `.sh` into `~/.claude/hooks/` (or project `.claude/hooks/`) and wire each
  under the matching event in `settings.json` (`PreToolUse` for the two guards, `SessionStart`
  with matcher `compact` for memory-checkpoint). Make them executable (`chmod +x`).
- **instructions-tuning** (skill + skill-gate hook) → run its own `instructions-tuning/install.sh`.
- **chat-audit** (skill + extractors + nudge hook) → run its own `chat-audit/install.sh`.
- **learning-log** → run its own `learning-log/install.sh`.

## Working on this repo

Skills here are tuned in the field, inside real workspaces — which is how private paths
and employer names end up in them, and how a hand-exported copy silently falls months
behind the version actually in use. Two things keep that in check:

```bash
git config core.hooksPath .githooks   # run once per clone — it is local, not versioned
```

- **`.githooks/pre-commit`** blocks personal content (workspace paths, absolute home
  paths, employer/product names) in **added** lines. Pre-existing matches don't block
  unrelated work. Deliberate exception: `git commit --no-verify`.
- **`install.sh --link`** (packages that support it) installs a skill as a symlink into
  this working tree instead of a copy, so field edits land here and show up in
  `git status` the same day. Project-specific rules belong in that project's
  `.claude/rules/`, never in the skill itself.

## License

MIT.
