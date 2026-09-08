---
name: instructions-tuning
description: "Use whenever creating OR editing any instruction/meta file an agent reads — CLAUDE.md, AGENTS.md, SKILL.md, agent definitions, system prompts, hooks, or .claude/rules. Trigger on any request to write, tune, fix, tighten, reword, or improve a rule/instruction for an agent; when an instruction keeps getting ignored; or when the user says 'инструкции', 'правило', 'правь CLAUDE.md', 'поправь скилл', 'мета-файл'. Diagnoses WHY an instruction fails and picks the right FORM (prohibition / positive recipe / structural slot / predicate-conditional / hook) under a conciseness + altitude budget. Also covers fixing a HOLE found in our own tooling — a hook, script, tool or agent that misfires, stays silent when it should fire, or lacks the tools its own instructions require: when to fix without asking, and how to fix the class instead of the instance."
---

# Instructions Tuning

Editing the files an agent reads to decide how to behave. The job is not "write a rule" — it is **match the form of the instruction to the way it fails.** A rule that keeps getting ignored is usually the wrong *form*, not the wrong *content*. Empirically (and per Anthropic's own docs) a clear instruction plus one canonical example beats either alone; a bare prohibition beats a vague one; and anything that *must* happen every time beats every wording by being a hook instead of prose.

## Process

Work in this order. Skip the heavy steps for a one-line tweak — but never skip step 1 (diagnose) or step 4 (budget).

1. **Diagnose** — what file, and what *kind* of failure are we fixing?
2. **Pick the form** — run the failure type through the matrix below.
3. **Write it** — in the chosen form, dogfooding the matrix on your own wording.
4. **Budget-check** — cut anything the agent already knows; verify length/altitude limits.
5. **Apply** — show the diff + one line of *why*, get a light OK. No spec, no gate.

## Step 1 — Diagnose

Two questions before touching anything:

**Which file?** Each has hard limits (see Budget). CLAUDE.md ≤200 lines. SKILL.md body <500 lines. `description` ≤1024 chars. A hook is code, not prose.

**Which failure?** Name it precisely — the name selects the form:
- The agent *knows* the rule but breaks it under pressure / when inconvenient → **pressure failure**
- The agent produces output of the *wrong shape* (wrong structure, tone, verbosity) → **shape failure**
- The agent *omits a required element* (forgets a step/field) → **omission failure**
- The behavior should *depend on a condition* the agent misjudges → **conditional failure**
- The action *must happen every single time, zero exceptions* → **determinism failure**
- The rule needs *judgment on cases the author didn't foresee* → **judgment gap**

## Step 2 — Match the form to the failure (the core)

| Failure | Right form | Why this form |
|---|---|---|
| **Pressure** | Prohibition + a short *rationalization table* (the excuses the agent will tell itself → the rebuttal) + red-flag phrases | Naming the loophole closes it. "Violating the letter is violating the spirit." |
| **Shape** | A **positive recipe / contract** — the exact target shape. NOT a prohibition. | Prohibitions backfire on shaping problems: "don't be verbose" leaves infinite valid outputs. A recipe leaves nothing to negotiate. |
| **Omission** | A **structural REQUIRED slot** in a template — make the missing element a labeled field the agent fills | Structure carries the rule; a forgotten field is visibly empty. |
| **Conditional** | A conditional **keyed to an observable predicate** ("if the file is under `X/` …"), not a fuzzy judgment | The agent can check a predicate; it can't reliably check a vibe. |
| **Determinism** | **Stop writing prose — make it a hook** (PreToolUse) and delegate to the hookify skill | CLAUDE.md/SKILL.md are *advisory* — "no guarantee of strict compliance." Hooks are deterministic. |
| **Judgment gap** | State the **rationale / the story of what broke** — the reasoning becomes the rubric for unforeseen cases | "Use constructor injection — field injection breaks testability" generalizes; "NEVER use field injection" doesn't. |

Two cross-cutting levers:
- **Escalation ladder:** soft rule → emphasized rule (`IMPORTANT` / `YOU MUST`) → hook. Reach for emphasis only after a plain instruction is observably ignored; reach for a hook when emphasis isn't enough and it must be guaranteed.
- **The "why" is conditional, not universal.** Attach a rationale ONLY for judgment gaps where the reasoning isn't obvious. For a mechanical convention ("links via `[[wiki]]`"), state it bare — a "why" the agent already knows is wasted tokens.

## Step 3 — Write it

- **Imperative, verb-first.** "Filter X before Y", not "X should be filtered".
- **One canonical example beats a description** for shape/quality rules. Input→output pair. Not five edge cases.
- **One default + an escape hatch**, never a menu of options the agent must choose between.
- **Reference a capability as a call to *use* it, not as passive availability.** A skill / tool / memory / hook the agent should reach for → imperative: "route via X", "verify with the DB before asserting", "log it to memory". Passive "X exists" / "for this there's X" gets ignored — the agent won't reach for what's merely mentioned. *Exception:* a detail/spec doc needed only sometimes → a plain pointer is fine ("full rules — [[X]]"); there the call-to-action is the inline rule, not "re-read this every time".
- **Consistent terminology** — pick one term and keep it (always "field", never field/box/element).
- **No nuance clauses.** Exemption clauses ("usually", "unless it makes sense") don't scope — they dissolve the rule. If there's a real exception, make it a predicate (conditional form).

## Step 4 — Budget-check (Anthropic constraints, always)

- **Pruning test** — for each line: *"would removing this make the agent make a mistake?"* No → cut it. "The context window is a public good."
- **Right altitude** — not brittle-hardcoded logic, not vague generality. Specific enough to guide, flexible enough to be a heuristic.
- **Concise ≠ short** — minimize *low-signal* tokens (things the agent already knows), keep high-signal ones even if long.
- **Bloat is the #1 failure** — "bloated files cause the agent to ignore your actual instructions; important rules get lost in the noise." If a rule keeps being violated, suspect the file is too long *before* rewording the rule.
- **Limits:** CLAUDE.md ≤200 lines · SKILL.md body <500 lines · `description` ≤1024 chars, third-person, states *what* + *when* · references one level deep (ToC if >100 lines) · forward-slash paths · no time-sensitive prose ("before Aug 2025…") — use a collapsed "old patterns" section.
- **Imports don't save context.** `@path` loads at launch regardless. Only `.claude/rules/` with `paths:` frontmatter defers loading until matching files are touched.

## Step 5 — Apply

Show the diff, one line of *why*, get a light OK. For a CLAUDE.md/SKILL.md edit, after applying, sanity-check that behavior actually shifts — one observation, not a test suite. (Full eval loops / TDD are deliberately out of scope here.)

## Дыры в инструментах — чинить самому

Область: **свои** инструменты — хуки, скрипты и либы в `.claude/`, тулзы в `bin/`, набор
инструментов у агента, формат его отчёта. Продуктовый код, чужие репозитории, CI, прод — не сюда,
там по-прежнему спрашиваем.

### Спрашивать или чинить — по тому, ЧТО меняется

| Меняется | Решение |
|---|---|
| механика, обслуживающая меня: ошибка в коде хука, сломанный вызов, агенту не выдан инструмент, агент не вернул отчёт в ожидаемой форме | **чиню молча.** Цель инструмента прежняя, чинится способ, которым он её достигает |
| назначение или поведение — моё либо агента: у агента другая цель, скилл не покрывает часть работы, правило начинает требовать другого | **обсуждаю.** Это уже решение о том, как мы работаем, а не починка |

Тест на границу: *«после правки инструмент делает то же, что и раньше, просто теперь работает?»*
Да → чиню. Нет, он начнёт делать что-то ещё → спрашиваю.

**Дыра = инструмент даёт неверный результат** — ложно сработал, молча не сработал, потерял данные.
«Неудобно» и «я бы сделал иначе» дырой не являются: без этого признака починка расползётся во вкусовщину.

### Когда

**После того как сдан текущий deliverable**, не посреди задачи. Заметил в процессе — одна строка
в ответе о находке, правка следующим шагом. Переключение посреди работы дороже самой дыры.

### Как — сначала класс, потом файл

🔴 Главная ошибка: починить тот экземпляр, об который споткнулся, и уйти. Перед правкой:

> *Этот инструмент единственный такой, или он экземпляр паттерна?* Ответ ищи не в файле, а в
> назначении: **зачем** инструмент существует, **когда** срабатывает, **на чьё состояние** опирается.

Образец (2026-08-10): один хук читал общий файл сброса, из-за чего чужая сессия обнуляла гейт.
Вопрос «на чьё состояние опирается» превратил один баг в класс — 8 мест с общим состоянием при
5-7 параллельных сессиях, из них 3 кусались ежедневно. Точечная починка оставила бы семь.

Дефект класса ищется в обе стороны:
- **тот же механизм у соседей** — кто ещё читает тот же файл, зовёт ту же либу, повторяет ту же строку;
- **обратное направление** — гейт может не только срабатывать вхолостую, но и молчать, когда должен
  сработать. Второе незаметно, поэтому проверяется специально.
- **внутри одного файла** — *если в файле СФОРМУЛИРОВАН принцип, проверь все места, где тот же
  вопрос решается второй раз.* Половины файла пишутся в разное время под разную боль, и правило не
  едет за границу своей секции само. Образец (2026-08-16): хук приёмки карты засчитывал ПРИЁМКУ по
  эффекту, с явным комментарием «намерение — не результат», а двадцатью строками выше писал
  АВТОРСТВО по намерению — по одному `tool_input`, не глядя, упал ли инструмент. Чинить надо не
  логику, а её недостающую половину.

После правки — проверить оба конца: и что дыра закрыта, и что штатный сценарий не сломался
(в образце: чужой `SessionStart` больше не сбрасывает гейт **и** свой `/compact` по-прежнему сбрасывает).

## Пишешь bash-хук — чеклист

Диагноз сказал «это детерминизм → хук». Дальше класс дефектов смещается: правило верное,
ломается реализация. Разбор learning-log 2026-08-13 дал 13 таких записей за 12 дней — больше,
чем любой содержательный класс. Все восемь пунктов ниже выведены из конкретных срабатываний,
это не гигиена вообще.

1. **stdin парсить только `jq`.** Жадный `sed` по JSON захватил хвост с `session_id`, и проверка
   темы срабатывала всегда, независимо от текста промпта.
2. **Отсечь системные события.** `<task-notification>` и `[SYSTEM NOTIFICATION]` приезжают тем же
   каналом, что промпт пользователя: хук выстрелил по собственному выводу агента.
   `case "$prompt" in *'<task-notification>'*) exit 0 ;; esac`
3. **Состояние — per-session файл, не общий.** Параллельные окна тут норма: чужой SessionStart
   затирал общий маркер и сбрасывал гейт посреди работы — четыре раза за сессию.
4. **Свежесть контекста меряется reset-файлом, не wall-clock TTL.** Окно «2 часа» истекало
   в середине использования; `/clear` и `/compact` выносят текст из контекста, а `resume` — нет,
   и время об этом ничего не знает. Читай reset-маркер, а не часы.
5. **Вывод человеку ≤3 строк.** 25 строк инструкций, положенные в `reason`, уехали человеку в чат.
   Детали — в файл рядом, в сообщении ссылка.
6. **Regex: границы слов + исключить тела heredoc.** Хук трижды подряд принял примеры команд
   внутри heredoc за исполняемые команды.
7. **Не писать состояние внутрь рабочего репо.** `gitflow-check` клал файлы в `.claude/state/`
   репозитория и ломал собственную проверку чистоты дерева. Стейт — в `<workspace>/.claude/state/`.
8. **Тест обязателен в ОБЕ стороны, до подключения:** срабатывает на целевом случае И молчит на
   соседнем. Половина списка выше — «сработало, когда не должно», и ловится только вторым тестом.
   Проверять и сам факт подключения: `settings.json` валиден, хук в нужном событии.

## What this skill does NOT do

- No TDD / failing-test-first gate, no eval-viewer, no description-optimizer loops — too heavy for routine tuning.
- Deterministic "must happen every time" rules → hand off to the **hookify** skill (this skill only *diagnoses* that a hook is the right answer).
- It edits instruction *prose and structure*; it does not invent project content.

## Project deltas

This skill is the universal engine. Project-specific conventions attach via the project's own `.claude/rules/` (path-scoped) or project CLAUDE.md — they are NOT carried here. Example: in the `mind` vault, editing files under `99 meta/**` also obeys the vault's wiki-link / `description`-frontmatter / single-source-of-truth conventions, supplied by `mind/.claude/rules/meta-99.md` and loaded only when those files are touched.
