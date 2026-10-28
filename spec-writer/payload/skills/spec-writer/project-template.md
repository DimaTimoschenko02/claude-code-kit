---
name: spec-writer-project
description: What spec-writer needs to know about this project — where specs live, language, contract format, how to measure, who codes, gates, extra sections.
language: en                      # ru | en — the language of the spec text and headings
spec_glob: docs/specs/*-spec.md   # repo-relative glob; spec-lint checks files matching it
extra_sections:                   # project headings every full spec also has, comma-separated; empty for none
split_lines: 400                  # added lines of code above which a task splits
---

# Specs in <project>

Only what the code does not already say. Each line here is a fact the spec writer would otherwise guess.

## Where and how

- **File:** <path pattern>, on <branch>; linked from <the task card / issue> as <field>.
- **Language:** <language>; code identifiers stay as in the code.

## Contract format

<How a route and its DTO are written here: validator, docs annotations, naming. Where an existing example lives.>

## Measuring before writing

<Commands that show a query's plan and row counts on real data; where the schema and the real types live.>

## Who codes and how a stop comes back

<The coder (Codex role, subagent), how it is started, how it reports a stop, who runs database tests.>

## Gates and reviewers

<What must be approved before the spec (scope, schema diff), what holds the order (hooks), who reviews the code against
the spec, the round limit.>

## Project gotchas

<Facts about this project's code that a spec keeps getting wrong. Add one each time a coder stop or a review round
traces back to the spec.>
