# spec-writer

A spec is the one document an AI coder (Codex, a coder subagent) builds a task from without asking. Every decision
it leaves open the coder makes alone, and the owner meets that decision in review, where it costs a rewrite instead
of a line. This package makes the spec carry those decisions and checks that it does.

- **Skill `spec-writer`** — how the session that talked with the owner writes the spec: close the questions first,
  measure before specifying, fixed sections (`sections.json` → `template.ru.md` / `template.en.md`), a short form for
  small tasks, a split at ~400 lines of code. Section guidance in `sections.md`; the coder's stop rule in
  `silence-rule.md`; how to sort the check's findings in `builder-check.md`.
- **Agent `spec-builder-check`** (Sonnet, read-only) — reads the spec as the engineer who cannot reach its author and
  lists what it would have to guess: questions, lines the code contradicts (`path:line`), inputs nobody tests.
- **Hook `spec-lint.sh`** (PostToolUse Write|Edit) — after a spec file is written, blocks it back to the model when a
  section is missing or empty, an acceptance line names no test, a «where it bites» line names no test, or a
  placeholder (TBD, TODO, «уточнить») is left in prose. Silent for any file outside the project's `spec_glob`.

Sections: Outcome · Contract · Decisions · Acceptance · Where it bites · Parts · When the spec is silent · Deviations
(ru: Результат · Контракт · Решения · Приёмка · Где укусит · Части · Если спека молчит · Отклонения). The coder edits
only Deviations.

Why it is shaped this way: Codex defaults to assume; models guess ~41% of unstated requirements; a separate gap
detector raised resolution to 69%; overview files cost ~20% more with no gain. Our own rework came from choices left to
the coder and from risky inputs nobody named — the two things Decisions and «Where it bites» exist for.

## Install

```bash
~/claude-code-kit/spec-writer/install.sh --link /path/to/project   # follow this clone (git pull updates it)
~/claude-code-kit/spec-writer/install.sh /path/to/project          # a copy
~/claude-code-kit/spec-writer/install.sh --check /path/to/project
```

Then fill `.claude/spec-writer.project.md` — frontmatter `language` (ru | en), `spec_glob`, `extra_sections`,
`split_lines`, and in the body only what the code does not say: where specs live, the contract format, how to measure
a query, who codes and how a stop comes back, gates and reviewers, project gotchas. That file is never overwritten.

Needs `node` for the hook and `jq` for the install. A Codex coder reads the same spec; generate its role from the
agent file the way the project converts its other agents.

## Test

```bash
cd ~/claude-code-kit/spec-writer && node --test test/*.test.mjs
```

`node --test test/` (a folder) fails with MODULE_NOT_FOUND on this Node — pass the glob.
