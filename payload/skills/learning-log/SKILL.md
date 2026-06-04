<!-- cc-learning-log:managed -->
---
name: learning-log
description: Накопление и разбор наблюдений за поведением Claude (self-learning log). Используется когда пользователь говорит "/log <текст>", "/learning-log", "/learning-log analyze", "/learning-log flush", "покажи лог", "разбери лог", "что я там накопил", "анализ ошибок". Также при повторных коррекциях ("я же говорил", "опять то же", "again the same") — предложить добавить запись через /log.
---

# Learning Log

Накопляемые наблюдения за моментами, когда Claude действует не так, как хотел пользователь — **user-correction** (пользователь поправил) и **self-correction** (Claude сам заметил/исправил промах). Сырьё для рефлексии и улучшения инфры (skills, CLAUDE.md, memory).

Auto: фоновый haiku-классификатор (Stop/SessionEnd hook). Manual: команды ниже.

## Хранение (дневная структура)

- **Один файл на день:** `.claude/learning-log/<YYYY-MM>/<YYYY-MM-DD>.md` (месяц — подпапка).
- Внутри файла — записи с заголовком `## HH:MM`, новые **сверху** (prepend). H1 = `# Learning Log — YYYY-MM-DD`.
- Файл-день создаётся автоматически при первой записи за день.
- **Архивации-переезда НЕТ.** Разобранная запись остаётся на месте, меняется только `Status` (+ `Resolution`). `/learning-log` фильтрует по `Status: open`.
- Логи по умолчанию в `.gitignore` (цитируют разговор — приватность). См. README пакета.

## When to use

- `/log <текст>` — форс-запись от Claude в текущей сессии
- `/learning-log` — показать open записи (по всем дневным файлам)
- `/learning-log analyze` — интерактивный разбор накопленного
- `/learning-log flush` — ручной прогон классификатора по необработанному хвосту
- «покажи лог», «разбери лог», «опять то же», «я же говорил» (предложить `/log`)

Также: `claude -p` invocation от автоклассификатора (background) — вызывается из hook'а, не из чата.

## Hard rules

### 1. I/O — обычными инструментами

Дневные файлы — обычный проектный контент. Читать/писать через **Read / Write / Edit / Glob**. Единственный санкционированный прямой писатель помимо тебя — фоновый `learning-log-analyze.sh` (awk/mv, уже портабелен).

> Если в проекте есть PreToolUse-хук, ограничивающий доступ к части файлов (напр. Obsidian-vault guard) — убедись, что `.claude/learning-log/` не попадает под него. Логи живут в `.claude/` (код), не в контентных папках.

### 2. Смена статуса — на месте, не вручную

Перевод записи в `addressed`/`wontfix` (с `Resolution`) делается **только** через `/learning-log analyze` и **на месте** в дневном файле — переезда между файлами нет.

### 3. Не предлагать ничего без явного `/learning-log analyze`

При `/learning-log` (без `analyze`) — только показать список open. Анализ и решения — отдельная команда.

### 4. Перед изменениями skill/CLAUDE.md/memory — подтверждение

Если в `analyze` предлагаю «обнови skill X правилом Y» — показать diff и спросить «применяю?». Не правлю автоматически.

---

## Command: `/log <текст>`

Форс-запись от Claude по контексту текущей сессии в файл **сегодняшнего** дня.

### Workflow

1. Parse `<текст>` — краткое описание момента.
2. Заполнить поля по контексту сессии: **Did** (что сделал), **Wanted** (что хотел пользователь), **Cause** (`skill`/`claude-md`/`memory`/`habit`/`unknown` + фраза), **Related** (skill/файл или `—`), **Status:** `open`, **Source:** `manual (/log)`.
3. Вычислить путь: `DAY=$(date +%Y-%m-%d)`, `MONTH=$(date +%Y-%m)` → `.claude/learning-log/<MONTH>/<DAY>.md`.
4. Записать (новая запись сверху):
   - **Read** файла-дня. Если ошибка «нет файла» → создать **Write**: `# Learning Log — <DAY>` + пустая строка + блок записи.
   - Если файл есть → **Edit**: вставить блок `## HH:MM ...` сразу после строки H1 (перед первым существующим `## HH:MM`).
5. Показать что записано. Без «ок?» до записи.

### Формат записи

```markdown
## 14:32
- **Did:** автоматически отредактировал файлы без отчёта
- **Wanted:** показать кандидатов, дождаться выбора
- **Cause:** skill — нарушено правило "предлагает, не правит сам"
- **Related:** `mind-linking`
- **Status:** open
- **Source:** manual (/log)
```

(Дата — в имени файла. В заголовке только `## HH:MM`. Поле `Related`: бэктики ``` `name` ``` или `[[name]]` если в конфиге `wikilinks: true`.)

---

## Command: `/learning-log`

Показать open записи по всем дневным файлам.

### Workflow

1. **Glob** `.claude/learning-log/**/*.md` → дневные файлы.
2. **Read** каждый (с самых свежих). Дата = из имени файла, время = из `## HH:MM`.
3. Парсинг: каждая `## HH:MM` секция = запись. Извлечь `Status:`, `Cause:`, `Did:`, `Related:`.
4. Фильтр `Status: open`, группировка по `Cause`.
5. Вывод:

```
Open в learning-log (N записей):

▸ skill (M)
  ─ 2026-06-04 14:32 — автоматически отредактировал файлы без отчёта
    Cause: нарушено правило "предлагает, не правит сам"
    Related: `mind-linking`
▸ habit (L)
  ─ ...
```

6. В конце: «`/learning-log analyze` — разобрать». Действия сами не предлагать.

> Объём: при большом числе файлов читать последние ~2 месяца и сказать об этом.

---

## Command: `/learning-log analyze`

Интерактивный разбор open записей — главная команда.

### Workflow

1. Загрузить open записи (как в `/learning-log`), помня для каждой её **файл-день** и блок.
2. **Группировка похожих** (одинаковый Related + похожий Did/Wanted), в т.ч. через разные дни (повтор = паттерн).
3. Для каждой группы предложить тип фикса по Cause:
   - `skill` → создать/обновить skill → diff
   - `claude-md` → patch CLAUDE.md → diff
   - `memory` → файл памяти → preview
   - `habit` → «aware, no infra change» (флип в addressed с Resolution «awareness only»)
   - `unknown` → переспросить, переклассифицировать
   - Спросить подтверждение, при ок — выполнить.
4. Для обработанной записи — **флип на месте** в дневном файле через **Edit**:
   - `old_string` = строка `- **Did:** …` + строка `- **Status:** open` этой записи (вместе — уникально на запись; защита от одинаковых `## HH:MM`).
   - Поменять `Status:` на `addressed`/`wontfix`, добавить `- **Resolution:** YYYY-MM-DD — <что сделали>` в конец блока.
   - **Запись не удаляется и не переезжает.**
5. Итог: «обработано N, addressed=X, wontfix=Y, остались open=Z». Предложить commit (если в проекте есть свой sync/commit flow).

### Что НЕ делает analyze

- Не правит skill'ы без подтверждения.
- Не редактирует MEMORY/CLAUDE.md автоматически.
- Не переносит записи никуда — статус флипается на месте.

---

## Command: `/learning-log flush`

Ручной прогон классификатора по необработанному хвосту transcript (страховка, если авто-порог не сработал). Наполняет лог, в отличие от `analyze` (разбирает).

### Workflow

1. Найти transcript текущей сессии **по содержимому** (без хардкода имени проекта):
   ```bash
   PROOT="$(pwd)"   # или корень проекта
   TRANSCRIPT=$(for f in "$HOME"/.claude/projects/*/*.jsonl; do
       [ -f "$f" ] || continue
       c=$(head -n1 "$f" | jq -r '.cwd // empty' 2>/dev/null)
       [ "$c" = "$PROOT" ] && printf '%s\t%s\n' "$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f")" "$f"
     done | sort -rn | head -1 | cut -f2)
   ```
2. Вызвать классификатор напрямую (берёт chunk от anchor до конца, без порога; сам пишет в дневной файл):
   `bash .claude/hooks/learning-log-analyze.sh "$TRANSCRIPT" ".claude/state/learning-log.json"`
3. Показать сколько записей добавилось (число `## HH:MM` в сегодняшнем файле до/после).

**Note:** на очень длинном transcript haiku недетерминирован (может вернуть `[]`). Штатно работает на маленьких chunk'ах. Если пусто на длинной сессии — повторить.

---

## Auto-classifier overview

- **Триггер:** Stop hook форкает классификатор при `threshold` новых user/assistant-сообщений (default 6). SessionEnd — флеш хвоста.
- **Семантика, не regex:** haiku сам решает, есть ли коррекция. Два класса: user-correction + self-correction.
- **Background:** `claude -p --model <haiku>` под Max/Pro-подпиской (не платный API; `force_subscription` снимает `ANTHROPIC_API_KEY`). Не блокирует чат.
- **Output:** prepend в `.claude/learning-log/<YYYY-MM>/<YYYY-MM-DD>.md`.
- **State:** `.claude/state/learning-log.json` (per-machine, gitignored): `anchors` (per-session), `last_run_at`, `last_session_id`.

Пропустил — `/learning-log flush` или `/log <text>`.

## File layout

| Path | What |
|---|---|
| `.claude/learning-log/<YYYY-MM>/<YYYY-MM-DD>.md` | Дневные файлы записей (open + addressed/wontfix, фильтр по Status) |
| `.claude/learning-log.config.json` | Конфиг (threshold, model, persona, language, wikilinks…) |
| `.claude/hooks/learning-log-trigger.sh` | Stop/SessionEnd entry |
| `.claude/hooks/learning-log-analyze.sh` | Background haiku-классификатор |
| `.claude/hooks/skill-invocation-log.sh` | PostToolUse Skill logger |
| `.claude/hooks/_lib/{env,paths,config}.sh` | PATH restore / root resolution / config loader |
| `.claude/state/learning-log.json` | per-machine: anchors, last_run_at, last_session_id |
| `.claude/state/skill-invocations.jsonl` | per-machine recent skill calls |

## What this skill does NOT do

- Не редактирует CLAUDE.md / skills / memory без подтверждения.
- Не делает git commit / push.
- Не запускает background-классификатор сам — это hook'и.
- Не переносит записи в архив — статус флипается на месте.
