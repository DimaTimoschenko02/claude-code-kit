---
task: <task ID>
form: full            # full | short — short only for a small fix: Outcome, Acceptance, When the spec is silent, Deviations
---

# <ID>: <what we build, in a user's words>

## Outcome

<One or two sentences: what changes for the person who uses it. Link to the task card.>

## Contract

<Every route: method, path, query and body DTO, what it returns, a JSON example. Every background job, CLI command,
environment variable. No external contract — one line «none: <why>».>

## Decisions

<Files by path; for each class and function its full signature with real types (checked against the code) and one
line on what it does. The main query whole. A new module — a dependency diagram (Mermaid). No function bodies.>

**<decision>** — why; **instead of** <option> — why not; **minus** — what we pay.

## Acceptance

- **A1** — <behaviour visible from outside> → `<test or command>`
- **A2** — …

## Where it bites

- <input or state the task is silent about> — <what a person expects> → `<test>` (part: <which>)

## Parts

| Part | Who | Files | Check |
|---|---|---|---|
| <backend> | <executor> | <paths> | <command> |

## When the spec is silent

<block from silence-rule.md + this task's stops>

## Deviations

<written by the executor: what it decided itself and why. Empty for now.>
