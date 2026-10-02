# Auditing a surface

To sweep a whole project's instructions — CLAUDE.md files, rules, skills, agent definitions — run **`/doctor prompt-audit`** (the same audit as `/claude-api prompt-audit`) from that project's root. It is Anthropic's maintained rubric for dated prompting patterns, shipped with Claude Code and updated with each model release, so use it instead of re-deriving one, and re-run it after every model release. It inventories the surface, produces a report with `file:line`, pattern, confidence and action, plus a proposed diff, and applies nothing on its own. Its keep-list binds as hard as its pattern tables: context, reasons, contracts and fragile exact scripts stay.

Its scope stops at each `SKILL.md` and knows nothing about how our layers fit together. Add these checks:

1. **Skill structure.** Each skill against `skill-files.md`: a folder or a single file; situations that should move to their own files; `description` as a trigger; whether it has gotchas at all.
2. **Conflicts between layers.** For each topic decided in more than one place — global CLAUDE.md, project CLAUDE.md, a skill, text a hook injects — list the places. Agreeing duplicates are fine; disagreeing ones are a finding, and the fix names one owner and deletes the rest.
3. **Hook text.** Strings a hook injects into context — `additionalContext`, block reasons, reminders — are instructions too; the same rubric applies. Injected text belongs in messages, which keeps the prompt cache intact; a hook must never change the tool set or the model mid-session.
4. **Copies that drift.** The same skill copied into several projects instead of linked. Diff the copies and link them back to one source.
5. **Model and effort routing.** Rules that name models or effort levels are pinned to one generation. Re-check each against the current lineup and the provider's own guidance for it.
6. **Archaeology.** Dates, session ids, and quotes of who said what inside a rule. Keep the reason, drop the history.

Apply the findings through this skill's process — one hunk per finding, each change recorded — not as one bulk rewrite. Every removal is a hypothesis to watch.
