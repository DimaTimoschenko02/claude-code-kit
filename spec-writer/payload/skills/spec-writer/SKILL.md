---
name: spec-writer
description: Writes a task's spec — the one document an AI coder (Codex, a coder subagent) builds from without asking — then has it checked by a fresh agent that reads it as that coder. Use whenever a task's code is about to be handed to another executor and its scope is agreed - «напиши спеку», «спека задачи», «оформи в спеку», «write the spec», «spec for the coder», after a scope approval and before any code is delegated; also when a coder stopped on a gap and the spec needs a fix. Not for a design doc people read to decide (a plan, a proposal, a schema diff for review), not for code the session writes itself right now with nothing left to decide.
---

# Spec writer

A spec exists so that the coder makes no decision nobody approved. Every choice it leaves open is made by the coder
alone and discovered in review, where it costs a rewrite instead of a line. So the spec carries the decisions — the
seams between pieces of code, the contract, the risky inputs, what «done» is — and leaves the bodies to the coder.

The session that talked with the owner writes it: half of the decisions live only in that conversation, and an agent
handed the files would rebuild the other half and lose this one. A fresh agent then reads the result cold.

## Start

Read the project's file `.claude/spec-writer.project.md` (the nearest one above the spec's path; a worktree has its
own copy). It says where specs live, their language, the contract format, how to measure a query, who codes, the
project's gates and extra sections. No such file → build it with the owner from `project-template.md` first; a spec
written without it guesses exactly the project facts the coder cannot.

## Before writing

Every question that would change the contract, the files, the split into parts or the tests is closed first — with
the owner, at most five questions at a time, each with options and your recommendation. The project's own interview
gate, if it has one, covers this. A question may stay open in the spec only when no answer would change what gets
built now; anything else written as «open» is a decision skipped.

Measure before you specify: the main query's plan and row counts, the real types of everything a signature imports,
the current budget of any count the task changes. A number or a type written from memory is the one the coder will
find wrong.

## Writing

Copy `template.<language>.md` — headings stay exactly as there, so the linter, the checker and the reviewer find each
section without reading the prose. What goes in each section and what never does → `sections.md`. The «spec is silent»
section → `silence-rule.md`.

`form: short` only for a small fix with no new contract or file: «Outcome», «Acceptance», the silence rule,
«Deviations». A three-section spec for a one-line bug is the point; a full one for it is the ritual that makes these
tools hated.

The spec is shorter than the code it describes. Over the project's split threshold (default ~400 added lines of code)
the task splits — say so to the owner before the spec grows.

## Checks

- **spec-lint** runs on every write of a spec file (hook `spec-lint.sh`): missing sections, placeholders («TBD»,
  «handle errors»), an acceptance line without a test. Fix what it reports; by hand: `node <this skill>/scripts/spec-lint.mjs <spec>`.
- **The builder check** — agent `spec-builder-check` reads the spec as the coder and returns what it would have to
  guess. Run it on every full spec before hand-off and sort its answer → `builder-check.md`.

## Hand-off and after

The coder gets the spec's path and the project's hand-off rules. It edits only «Deviations». When it stops on a gap,
the gap is the spec's: fix the spec, re-run the builder check on the changed part, restart that part. The reviewer
judges the code against the spec plus «Deviations», and not style.

## Gotchas

- Codex's own guide tells it to «default to implementing with reasonable assumptions». Without the silence rule in the
  spec in front of it, it guesses.
- Models flag a missing requirement on their own barely better than chance and guess right about 41% of the time;
  a separate pass that only hunts gaps before coding is what moved results (Ask or Assume, 2026: 69% resolved).
- A repository overview in the spec costs ~20% more tokens and adds nothing (ETH, 2026). Write only what the code does
  not already say: decisions, contract, risky inputs.
- The rework in past specs did not come from too little text. It came from a choice left to the coder (how a provider
  is registered, hand checks vs one schema) and from a risky input nobody named (a fallback column overwriting
  inherited data, stale labels in old tests). «Decisions» and «Where it bites» exist for these two.
- Bodies in the spec go stale the moment the coder improves them and double the length the owner must read; a spec
  longer than its code has written the code.

## Files

| Need | File |
|---|---|
| What each section holds and what never goes there | `sections.md` |
| The spec skeleton, by language | `template.ru.md`, `template.en.md` |
| The silence rule text | `silence-rule.md` |
| Running the builder check and sorting its answer | `builder-check.md` |
| A project file for a project that has none | `project-template.md` |
| Sections, placeholders and limits the linter checks | `sections.json` |
