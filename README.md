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
- **learning-log** → run its own `learning-log/install.sh`.

## License

MIT.
