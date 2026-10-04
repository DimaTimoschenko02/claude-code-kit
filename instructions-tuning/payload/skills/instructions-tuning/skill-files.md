# Skill files

A skill is a folder the agent explores, not a markdown file. Three layers load at different times: the skill listing (every skill's name and `description`) is in context from session start; the SKILL.md body loads when the skill triggers; files the body points to load only when the agent reads them. Every paragraph pushed down a layer stops being paid for on every trigger.

## The description is a trigger, not a summary

It answers one question: when should this fire? Name the intent categories and the words the user actually says, in the language they say them. "Monitors a PR until it merges. Trigger on 'babysit', 'watch CI', 'make sure this lands'" works; "A comprehensive tool for monitoring pull request status" doesn't. Skills tend to under-trigger; the cure is a wider intent category ("whenever the user wants X, even without naming it"), and urgency in wording comes last and only here, never in the body. When a trigger is missed, generalize the category rather than appending one more phrase: a description that only ever grows is enumerating synonyms. Check how often a skill actually fires in the skill-invocation log before rewording.

A description is judged against its neighbours, not alone. Before keeping a change, write 4–5 prompts that should fire it and 4–5 near misses — prompts that share its words but belong to another skill or to no skill — and read them against the descriptions of the skills nearby: a widened category that starts winning the near misses has stolen another skill's trigger.

## Split by situation

Split a skill when it handles several situations and any one run needs only one of them: modes (create / audit / migrate), branches by artifact type, a checklist used for one kind of work, reference material looked up occasionally. Signs it is time: sections that are irrelevant to most invocations; a body you can't read in one sitting; "if X … / if Y …" blocks running a screen each.

The shape after the split: SKILL.md keeps what every run needs — purpose, the default approach, gotchas that always apply — plus a situation → file table. Each situation file is self-contained and reachable from SKILL.md directly (one level deep, no chains); one over ~300 lines opens with a table of contents, so the agent reads the part it needs instead of the whole file. Common homes: `references/` for API signatures and schemas, `scripts/` for helpers the agent runs or imports, `assets/` for output templates, `config.json` for per-install setup the skill asks for once.

Split into two skills instead when the parts do different jobs. One skill serves one category — library reference, product verification, data fetching, business process, scaffolding, code review, CI/CD, runbook, infrastructure ops. A skill straddling categories blurs its own trigger.

## Gotchas are the payload

The highest-signal section of any skill: concrete facts about this system that the model would get wrong by default. "The table is append-only — the current row is the highest version, not the latest `created_at`." "Staging returns 200 without processing the request." A gotcha is a fact, not a plea for good behavior. Start a skill as a few lines and one gotcha, and add a gotcha each time the agent hits a new edge case. A skill distilled from a session starts from that session's transcript, not from memory of it: the steps that worked, the tools used, and every correction the user made — each correction is a gotcha candidate, and a summary of the session has already dropped most of them. Don't restate what the model does anyway: a skill that restates defaults adds context without adding value — spend the words on what pushes it out of its default way of thinking.

## Goal and constraints, not a script

State the outcome, the constraints, and how to check the result; leave the steps to the model unless the order is the point. Ship scripts and small libraries so the agent spends its turns composing rather than re-deriving, and put data quirks in their docstrings where the agent will meet them. The signal is in transcripts: when several runs each write the same helper, that helper belongs in `scripts/`.

## Memory, hooks, composition

- A workflow the skill repeats keeps an append-only log or JSON file in a stable directory; the skill reads its own history to stay consistent and report what changed since last time.
- Opinionated guards that would be maddening if always on — blocking `rm -rf`, freezing edits outside one directory — go in the skill's own frontmatter hooks, active only while the skill is in use.
- Compose by naming another skill in the body; the model invokes it if it is installed.

## Verification skills pay most

Skills that let the agent check its own output — drive the app, assert state through a script, record a run — have had the largest measured effect on output quality. When choosing what to build next, this category comes first.
