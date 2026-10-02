---
name: instructions-tuning
description: "Use when creating, editing, splitting or auditing any file an agent reads to decide how to behave — CLAUDE.md, AGENTS.md, SKILL.md, agent definitions, .claude/rules, text a hook injects, system prompts — or when an instruction keeps getting ignored, misapplied, or contradicts another one. Also when one of our own hooks, scripts or agent tools misfires or stays silent when it should fire. Trigger words: 'инструкции', 'правило', 'правь CLAUDE.md', 'поправь скилл', 'мета-файл', 'хук не сработал'. Diagnoses why an instruction fails, picks the form that fixes it, and keeps the surface lean for current Claude models."
---

# Instructions Tuning

Editing the files an agent reads to decide how to behave. Two facts frame every edit.

**Current Claude models follow instructions closely and literally, and have good judgement.** Most failures now come from too much instruction, not too little: a rule applied exactly where it is wrong, rituals that make the model write more and repeat tool calls, two layers saying opposite things. Anthropic removed over 80% of Claude Code's own system prompt for the Claude 5 generation with no loss on their evals. So the first fix to consider is a deletion, or rewriting a rule into the principle behind it; adding text comes second.

**A rule that keeps failing usually has the wrong form, not the wrong words.** Match the form to the way it fails.

## Where to look

| Situation | Read |
|---|---|
| Fixing or writing one instruction — a CLAUDE.md line, a rule, a skill section | this file |
| Writing a skill, restructuring or splitting one, fixing its `description` | `skill-files.md` |
| Auditing a whole surface — a project's CLAUDE.md, rules, skills — for dated patterns | `audit.md` |
| One of our own hooks, scripts or tools misfires or stays silent | `tool-holes.md` |
| Writing or fixing a bash hook | `bash-hooks.md` |

## Process

Diagnose → pick the form → write → budget-check → apply and record. For a one-line tweak go straight to writing, but never skip diagnosis and the budget check.

### 1. Diagnose

First look for the three causes whose fix is a deletion, not new text:

- **Conflict** — another layer decides the same thing differently: global CLAUDE.md, project CLAUDE.md, a skill, text a hook injects, the user's request. The model spends thinking reconciling them and lands inconsistently. Grep the other layers for the same topic before writing anything.
- **Stale crutch** — the line was written for an older model: emphasis, rituals, step scripts, gold examples (see Write).
- **Bloat** — the file is long enough that rules get lost in it. Suspect length before rewording a rule that keeps being violated.

Then name the failure; the name selects the form:

- needs judgement on cases nobody foresaw → **judgement** (the default)
- follows a rule exactly where the rule is wrong, or performs ritual work → **over-constraint**
- knows the rule but breaks it when it is inconvenient → **pressure**
- produces output of the wrong shape → **shape**
- forgets a required element → **omission**
- behavior should depend on a condition the agent misjudges → **conditional**
- must happen every time, zero exceptions → **determinism**

### 2. Pick the form

| Failure | Form | Why |
|---|---|---|
| Judgement | The goal and the reasoning, in prose: what we want and why. "Write code that reads like the surrounding code: match its comment density, naming, and idiom" replaced a paragraph of comment rules in Claude Code's own prompt. | The model generalizes from a reason to cases the author never saw; a rule covers only the cases it names. |
| Over-constraint | Delete it, or rewrite the absolute into the principle behind it. | An absolute that "might not always be true" gets applied exactly where it is wrong. |
| Pressure | The rule once, plainly, with the concrete cost of breaking it. If transcripts show the specific excuse the agent uses, name that excuse in the same sentence. Still broken → determinism. | The cost is what holds under pressure. Lists of hypothetical excuses and red-flag phrases are repetition, and repetition makes the model reconcile wordings instead of acting. |
| Shape | A positive contract of the target shape: a template with named fields, or an example labeled illustrative when the output is genuinely format-sensitive. | "Don't be verbose" leaves infinite valid outputs; a contract leaves nothing to negotiate. |
| Omission | A required, labeled slot in the template. | A forgotten field is visibly empty. |
| Conditional | A condition keyed to something the agent can check: "if the file is under `X/`". | The agent can check a predicate; it can't check a vibe. |
| Determinism | Stop writing prose: a hook (hand off to the hookify skill), or a permission rule for a hard block. | Instruction files are advisory. A hook guard is a safety net, not a permission system — a hard block belongs in permission rules. |

Emphasis — caps, `IMPORTANT`, `MUST` — is a tested fix for one instruction that a plain sentence observably failed to move, never a first-draft register. When several lines are marked critical the markers carry no information, and an anxious file produces a hedging agent.

### 3. Write it

**Explain how to think, not what to copy.** A concrete example is the strongest signal in a prompt: the model matches its length, tone and structure and stays inside it. Give the principle instead. Use an example only when copying is the goal — an output format, a file template — or when it carries a fact the model lacks, such as the current API shape versus the one it was trained on, or a data quirk. If you give several, make them deliberately different.

**Goal, constraints and how to verify — not a step script.** The model's own plan usually beats a hand-written one. Keep numbered steps only where the order itself is the point: a deploy, a destructive sequence, an auth flow.

**Keep the reason, drop the history.** "The gate reads a shared file, so a parallel session resets it" is a reason; the date, the session id and who said it are archaeology. A rule's authority is the behavior it prescribes, not the incident that produced it.

**No old-model rituals.** "Think carefully", "think step by step", mandatory N-step procedures, "verify twice", "do not be lazy", scratchpads, "summarize every N tool calls", "hold all findings until the end", "never use bullets". Current models think before every reply and plan unprompted; to change how much they think, change effort.

**A requirement is stated without hedges.** "Try to" or "if possible" on a real requirement reads as permission to skip it. If the line is not a requirement, it is a principle — write it as one, or delete it.

**Reference a capability as a call to use it** — "route via X", "verify against the DB before asserting". A passive "X exists" gets ignored. A detail doc needed only sometimes takes a plain pointer.

Imperative, verb-first. One term per concept. One default plus an escape hatch, never a menu of options. Prose for behavior, because bullets sever a rule from its reason; tables for reference data.

### 4. Budget-check

For each line: *would removing it make the agent make a mistake?* If not, cut it. Keep what only the author knows — the product, the environment, gotchas, the reasons behind constraints; that context is never cruft. Cut what the model already knows or can see in the repo. Cruft is not length: never justify a cut by character count alone.

**Recency trap.** One session's stumble encoded as a permanent rule makes every later session step around a pothole that isn't there. Before keeping a rule, ask whether it would have helped most recent sessions or only the one that wrote it.

**Progressive disclosure over one big file.** CLAUDE.md stays lean and points to skills and files that load when needed. `@path` imports load at launch regardless; only `.claude/rules/` with `paths:` frontmatter defers until matching files are touched.

**One place per fact.** Two files that agree are fine; two that disagree are a conflict (step 1).

Limits: CLAUDE.md under 200 lines — every line is resent on every turn. SKILL.md body under 500 lines, and split by situation well before that (`skill-files.md`). `description` at most 1024 characters.

### 5. Apply and record

Show the diff with one line of why, get a light OK, apply. Then check that behavior actually shifts — one observation, not a test suite.

A removal is a hypothesis. If what the rule guarded against comes back, re-add it in its smallest form; don't restore the original.

**Record the change** (when chat-audit is installed — in the project, `.claude/skills/chat-audit/`, or globally,
`~/.claude/skills/chat-audit/`; the ledger lives in the project either way). Append one
`type:"change"` line to `.claude/state/chat-audit/ledger.jsonl` — format in chat-audit `modes/land.md`. Required:
`class` = the failure class from step 1, one sentence; `signal` = the line, tool parameter, skill load or hook decision
this edit should move (`src`, `re`, `want`); `occasion` = when it applies (`null` → the source's default). Then
`node <chat-audit dir>/lib/effect.mjs record --id C-<n> --project <dir>` freezes the 7-day baseline.
No observable signal → `signal:null` is allowed, but the change is reported as `unmeasurable` at every audit.

## What this skill does not do

- Measured tuning against an eval is a separate job: `/claude-api build-eval`, then `/claude-api hillclimb`.
- "Must happen every time" rules go to the hookify skill; this skill only diagnoses that a hook is the answer.
- It edits instruction prose and structure; it does not invent project content.

## Project deltas

This skill is the universal engine. Project-specific conventions attach via the project's own `.claude/rules/` (path-scoped) or project CLAUDE.md — they are not carried here. Example: in the `mind` vault, editing files under `99 meta/**` also obeys the vault's wiki-link / `description`-frontmatter / single-source-of-truth conventions, supplied by `mind/.claude/rules/meta-99.md` and loaded only when those files are touched.
