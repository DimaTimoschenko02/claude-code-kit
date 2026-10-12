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
| **block-secrets.sh** | PreToolUse | Blocks the agent from reading or exfiltrating credentials — sensitive file paths, env dumps, keychain/cloud-secret-manager reads, token-printing CLI commands. Defense-in-depth against accidental leaks (not a determined adversary). Superseded by the `secrets-redact` mod below, which lets the agent read and use secrets but hides their values. |
| **block-env-files.sh** | PreToolUse | Blocks reading/copying/sourcing any `.env` file (templates like `.env.example` are whitelisted). Complements `block-secrets.sh`; superseded by `secrets-redact` the same way. |
| **memory-checkpoint.sh** | SessionStart (`compact`) | After a context compaction, nudges the agent to review whether anything durable should be written to its persistent memory. |

### Mods (`mods/`)

Claude Code mods: in-process TypeScript function hooks (`on(event, hook)` with `$, e, next`), loaded from a folder
instead of a shell command per event. Each has its own tests (`claude plugin test <folder>`).

| Mod | What it does |
|---|---|
| **secrets-redact** | Hides secret values in everything the model reads — tool results, injected rows, notifications — instead of blocking reads; names and listings stay visible, and a secret can still be used in a command; a rule hides only the value it matched, never the rest of a line. Known values come from env, rc files, `.env*` and `extraFiles`; shape rules catch the rest. A mod that fails to load is skipped silently, so two classic hooks in `guard/` watch it from outside the engine: `alive.sh` (PreToolUse `*`) denies every tool call of a session the mod left no heartbeat for, `canary.sh` (SessionStart) runs the mod's tests once per Claude Code version and warns when they fail. |
| **stop-point** | Keeps a stop point (`.claude/state/resume/<session>.md`) fresh by itself: after every main reply a background Sonnet completion rewrites it from the transcript delta (one write at a time; tool output and agents' reports get the budget, agents are never labelled as the owner), the ~3 KB bound is held in code and wins over carrying the previous point's paths, hashes and URLs: a dropped anchor goes back only while it fits, newest first, and no longer once the transcript has not named it for 10 writes (one short re-ask without the transcript, then a mechanical restore; the writer's text is never cut, an oversize old point is cut on its next write), a compaction waits for it, and after compaction it goes back into context with the files the summary lost. The writer's prompt opens with the format and the current point as cache-marked blocks (the time and the transcript after them), so a write within 5 min of the last reads them from the prompt cache — `cache_read` in `writes.log`. Status line `🟢 точка HH:MM` when the point covers the last reply, `🟡 точка пишется…` while it is behind, `🔴 точка: ошибка …` (one line with cache-warm's part when both are loaded); `/stop-point` shows the file, the last write's cost and the project addendum in use. A project's own addendum to the format lives in the mod's `projects/<name>.md` (frontmatter `root: /abs/path`; the longest root holding the session root applies; local only, git-ignored — a repo's own text never reaches the writer). On resume the freshness check lists branch, uncommitted files and commits since the write for the root's repository, or for each repository one level below a workspace that is none (up to 12, changed ones first). Silent in SDK sessions that have no transcript. |
| **dictate** | Voice dictation: `/pack` holds several prompts as one batch until a release word, and misheard project terms are fixed from `~/.claude/dictate-terms.json`. While a pack is open it listens for Claude Code's voice mode stopping on its own (2-minute cap, 15 s pause): a double beep ~15 s before the cap, one beep at the stop, the stopped chunk's last sentences in the band above the prompt until the next chunk, and a capped chunk is marked so the model expects a repeat. |
| **mods-help** | `/mods` lists the slash commands the loaded mods serve in this session, read live from the engine, and the mods that work without one — so a new mod's command needs no announcing. |
| **session-panel** | A side pane per session: links the replies carried, grouped under their task (a done card — ticked, or its `status:` among `doneStatuses` in `cardsDir` — folds its PR and design away), and one line per `result:`. A line's markdown is drawn, not shown raw: `code` in the replies' code colour, **bold**, *italic*, links, and the lead up to the first clause break in bold; editing shows the raw text. Every place a line names is a link where it stands: `#140` and a commit sha (checked with git, so a job id stays text) into the session's GitHub repo, a bare address, a path that exists inside the session's folder, its repo, `cardsDir`, the `vault` or `linkRoots` (default `~/claude-code-kit`, `~/mind`): a vault note opens in Obsidian, any other file — scripts and executables too — in WebStorm at its `:line`, a folder in Finder; a bundle, a launcher file (`.command`, `.webloc`, `.dmg`, `.pkg`…) or a link leading out stays text, a task id whose card is in the panel. One gate for every address drawn, markdown or bare: the web, `obsidian://open`, and an editor link only to a file so checked; anything else is plain text. The owner ticks, rewrites, deletes and adds lines in place; the changes reach the model with the next message. `/sp` opens or closes it; the model adds what no reply carried with `mcp__session-panel__add`. |
| **cache-warm** | Keeps an idle session's prompt cache alive while the last reply waits for the owner: a tool-less fork of the session's own transcript every TTL − 10 min (50 min on the 1 h cache) reads the cached prefix and renews it, for a window after the reply (`defaultHours`, 2). `auto` warms only a reply with a filled «Ждёт тебя» slot or a `needs input:` line — measured, those are the replies the owner comes back to an hour or more later; a cache under 40 min is never warmed (a read every few minutes costs more than the rewrite). The owner's next message ends the window. The status line shows when the cache really lapses after every reply, warmed or not (`🔥 кэш до 20:15` while warms keep it, plain `кэш до 20:15` for the cache's own expiry, e.g. an hour after an unwarmed reply), moves forward while a turn runs, and carries stop-point's part on the same line (`🔥 кэш до 20:15 · 🟢 точка 19:42`). `/warm` shows the state — when the next warm runs and how many tokens the last one read from the cache, so a live mod is visible; `/warm 3` (or `1h 30m`, `90m`, `1ч 30мин`) sets this session's window, `/warm off | on | auto` its mode — kept per session id, so a respawn keeps them; `/warm default 4` changes it for sessions without their own. Time is read off the wall clock every minute, not off one long timer (a timer counts only the process's awake time): a warm whose moment passed while the Mac slept goes out on waking if the cache still lives, and is logged as missed if it died — a closed lid sends nothing, so no mod can keep the cache through it. A refused warm is retried in 2 min. Every arming, warm (tokens read and written), failure and miss is one line in `~/.claude/state/cache-warm/warms.log`, which `/warm` names. |
| **observer** | Our own side observer, beside the built-in you-should-know: after every main reply a background Sonnet completion (never the session's model, never a subagent; one at a time, a reply during a check queues one more) reads what happened since its last check — the owner's messages and Claude's replies whole, tool calls in one line, results only when they failed or were denied — with the project's rules (`.claude/CLAUDE.md`, `CLAUDE.md`, `~/.claude/CLAUDE.md`, capped), an inventory of our tools computed by code (skills and commands, agent types, mods, the project's `bin/` scripts — so it never proposes what exists), its own notes for the session (rewritten by each check) and the facts the mod counted. Those three stable parts open every call as one prompt-cache block (measured: 13k tokens written once, then read at a tenth of the price within 5 minutes). Counting is code, across the whole session: identical Bash commands, hook blocks by hook, denials by reason, API errors by kind; at 3, 6, 12… a fact goes to the next check once. Its answer is parsed strictly: `KNOW` (what the owner should know and will likely miss) goes to the band above the prompt (dismissable, gone after two prompts); `REPEAT` (повторы и затыки, with the tool form that would fix it) goes to `~/.claude/state/observer/<session>.md`, reaches the band only when it rests on a counted fact, and is handed once to the main model with the next prompt. A reworded repeat of an earlier finding is dropped. Every check is one line in `~/.claude/state/observer/checks.log` (time, tokens, cache, lines emitted); `/observer` shows the session's findings, the counters over threshold and the last check's cost, `/observer off | on` switches it per session. Headless `claude -p` runs check nothing unless `CLAUDE_OBSERVER_HEADLESS=1`; SDK sessions without a transcript stand down silently. |
| **wake-resume** | Finishes a turn the Mac's sleep cut. When a main turn ends on the engine's own `Your computer went to sleep mid-response` line (matched as the reply's whole last line, so a reply quoting it is no cut; StopFailure and turn.complete name one cut), it waits for a full wake — someone at the keyboard (`UserIsActive` in `pmset -g assertions`), or 5 min awake without a gap with `pmset -g log` ending on a full `Wake`, never a dark wake — and then submits one continuation prompt framed as the plugin's message: it says it is automatic and names the cause read from `pmset -g log` (`крышка закрыта в 19:51, от батареи; проснулся в 20:36`, or that there was no sleep). Guards: one continuation per cut turn; none when the owner wrote anything first (a slash command does not count) or the cut turn waited on him (a permission prompt, `AskUserQuestion`, `ExitPlanMode`); a draft in the prompt box holds it; at most 3 in a row without the owner writing; subagents ignored. The waiting cut lives in `$.state`, so a reload keeps it; status `⏸ ход оборван сном Mac — продолжу сам, когда проснётся` while it waits. Works in `claude --bg` daemon sessions and `claude -p` stream-json runs. `/wake` shows the pending cut and the last sleep; every cut, continuation and skip is one line in `~/.claude/state/wake-resume/resume.log`. macOS only. It cannot keep the Mac awake with the lid closed — Claude Code already holds `caffeinate -i` while busy, which a closed lid on battery overrides; the mod only resumes afterwards. |

### Agents (`agents/`)

| Agent | What it does |
|---|---|
| **mod-builder** | Creates and changes mods end to end — code, tests, checks, settings wiring, smoke run, commit — so a mod request made mid-task goes to a background agent instead of derailing the session. Learns from its own runs: `memory: user` keeps lessons in `~/.claude/agent-memory/mod-builder/` (its `MEMORY.md` is loaded at every start); `mods/bin/mod-check` (validate + tests + tsc + live smoke) appends every failed check to that memory's `inbox.md`, and the agent's Stop hook `mods/bin/mod-builder-stop` keeps it working until each failure became a lesson. The owner's corrections reach it in the prompt of the next run: the calling session passes his words verbatim. `mods/bin/mod-wire` adds a mod to `CLAUDE_CODE_PLUGIN_DIRS`. Expects the kit at `~/claude-code-kit`; install: symlink into `~/.claude/agents/`. |

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
- **Mods** → list the folders in `CLAUDE_CODE_PLUGIN_DIRS` (colon-separated) under `env` in `~/.claude/settings.json`;
  it is read at process start, so restart sessions after a change: `/exit` → `claude -c` for a terminal session,
  `claude respawn <id>|--all` for background ones (they live in the daemon, reopening the terminal leaves them be).
  One-off: `claude --plugin-dir <folder>`.
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
