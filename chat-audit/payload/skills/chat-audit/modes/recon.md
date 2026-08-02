# Mode 1 — recon

Inventory what the project already has, before reading a single session. Without this the audit "discovers"
things that were solved months ago, and — worse — cannot tell a missing rule from a rule that failed.

## Run

```bash
node .claude/skills/chat-audit/lib/discover.mjs config --project <dir>
```

Returns config dirs, the memory locations it found, and the infra inventory: skills, hooks, agents, rules,
commands, instruction files with their heading list, and the hook registrations in `settings.json`.

## Read it for four things

**1. What exists.** Skills, hooks, agents, rules by name. You are not reading their contents yet — the names
and the headings of instruction files are enough to recognize "this ground is covered" later.

**2. Where memory lives, and whether it lives at all.** `discover.mjs` reports every candidate it finds:
`.claude/memory/`, a symlink pointing into a vault, a directory inside the transcript folder, a `.remember`
plugin dir, or nothing. All of these occur in real setups; assume none of them.

- Multiple locations → ask which is durable memory. Do not guess.
- No memory anywhere → that is finding #1 of this audit, and `memory-audit.md` becomes "propose starting one".

**3. What the instructions already promise.** Read the headings of `CLAUDE.md` / `AGENTS.md` — the section list,
not the prose. A heading is enough to know a topic is claimed. During analysis, a finding that lands on a
claimed topic is reclassified: not "missing rule" but "rule exists and did not hold", which is the more
serious of the two and needs a different fix (form, placement or enforcement — not more words).

**4. Which guardrails are live.** Hooks registered in `settings.json` with their events and matchers. This is
the map you check the `friction` lens against.

## Output of this mode

A compact inventory, kept for the rest of the run:

```
skills:   <names>
hooks:    <names + events>
agents:   <names>
rules:    <names>
memory:   <path> (<n> files) | none found
claimed:  <headings of CLAUDE.md / AGENTS.md>
```

Then go to `select.md`.

## Do not

- Do not read every skill body. Names now; bodies only when a specific finding lands on a specific skill.
- Do not treat an empty inventory as an error. A bare project is a legitimate subject — it just means most
  findings will be "this does not exist yet" rather than "this misfires".
