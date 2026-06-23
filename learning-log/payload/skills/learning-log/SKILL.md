<!-- cc-learning-log:managed -->
---
name: learning-log
description: Накопление и разбор наблюдений за поведением Claude (self-learning log) — промахи (mistakes) и удачные переиспользуемые решения (wins). Используется когда пользователь говорит "/log <текст>", "/learning-log", "/learning-log analyze", "/learning-log wins", "/learning-log flush", "/learning-log on|off [chat|global]", "/learning-log status", "покажи лог", "разбери лог", "что я там накопил", "анализ ошибок", "выключи лог", "не логируй этот чат". Также при повторных коррекциях ("я же говорил", "опять то же", "again the same") — предложить добавить запись через /log.
---

# Learning Log

Накопляемые наблюдения за поведением Claude. Два канала + реестр:

- **Mistakes** — Claude действовал не так, как хотел пользователь (`user-correction`) или сам поймал свой промах (`self-correction`). Сырьё для фикса инфры (skills, CLAUDE.md, memory).
- **Wins** — удачные нетривиальные решения, которые стоит переиспользовать. Кандидаты в знание (promote → memory/skill/convention).
- **Resolutions registry** — эффективность фиксов промахов + детект рецидива (вернулся ли разобранный баг → фикс был неверный/неполный).

Auto: фоновый haiku-классификатор (Stop/SessionEnd hook). Manual: команды ниже.

## Хранение

| Канал | Путь | Структура |
|---|---|---|
| Mistakes | `.claude/learning-log/<YYYY-MM>/<YYYY-MM-DD>.md` | дневные файлы, заголовок `## HH:MM`, prepend |
| Wins | `.claude/learning-log/wins/candidates.md` | один буфер, заголовок `## YYYY-MM-DD HH:MM`, prepend |
| Registry | `.claude/learning-log/resolutions.md` | таблица, строка = паттерн (не событие) |

- Файлы создаются автоматически при первой записи.
- **Архивации-переезда НЕТ.** Разобранная запись остаётся на месте, меняется только `Status` (+ `Resolution`/`Promoted-to`). `/learning-log` фильтрует по `Status: open`.
- Логи по умолчанию в `.gitignore` (цитируют разговор — приватность). См. README пакета.

## When to use

- `/log <текст>` — форс-запись от Claude в текущей сессии (тип mistake/win — по смыслу)
- `/learning-log` — показать open (mistakes + wins)
- `/learning-log analyze` — разбор промахов (фикс + registry + рецидив)
- `/learning-log wins` — разбор win-кандидатов (promote/discard)
- `/learning-log flush` — ручной прогон классификатора по необработанному хвосту
- «покажи лог», «разбери лог», «опять то же», «я же говорил» (предложить `/log`)

Также: `claude -p` invocation от автоклассификатора (background) — из hook'а, не из чата.

## Hard rules

### 1. I/O — обычными инструментами

Дневные файлы, `wins/candidates.md`, `resolutions.md` — обычный проектный контент. Читать/писать через **Read / Write / Edit / Glob**. Единственный прямой писатель помимо тебя — фоновый `learning-log-analyze.sh` (awk/mv): пишет дневной файл + `candidates.md`. **Registry он не трогает.**

> Если в проекте есть PreToolUse-хук, ограничивающий доступ к части файлов (напр. Obsidian-vault guard) — убедись, что `.claude/learning-log/` не попадает под него. Логи живут в `.claude/` (код), не в контентных папках.

### 2. Смена статуса — на месте, не вручную

Перевод записи в `addressed`/`wontfix` (с `Resolution`/`Promoted-to`) — **только** через `/learning-log analyze` или `/learning-log wins`, и **на месте** в файле — переезда нет.

### 3. Registry пишется только в analyze

`resolutions.md` обновляется **только** командой `/learning-log analyze` при флипе mistake → addressed/wontfix. Фоновый классификатор, `/log`, `/learning-log wins` его не трогают.

### 4. Не предлагать ничего без явного analyze/wins

При `/learning-log` (без подкоманды) — только показать список open. Анализ и решения — отдельные команды.

### 5. Перед изменениями skill/CLAUDE.md/memory — подтверждение

Если в разборе предлагаю «обнови skill X правилом Y» — показать diff и спросить «применяю?». Не правлю автоматически.

---

## Command: `/log <текст>`

Форс-запись от Claude по контексту сессии. **Тип определяю сам** по смыслу:

- промах («опять не туда», «надо было через skill») → **mistake** → дневной файл сегодня
- удачное переиспользуемое решение («разобрался как X», «рабочий паттерн Y») → **win** → `wins/candidates.md`

### Workflow (mistake)

1. Заполнить: **Did**, **Wanted**, **Cause** (`skill`/`claude-md`/`memory`/`habit`/`unknown` + фраза), **Related** (skill/файл или `—`), **Runtime-fix** (если в моменте уже выкрутился, иначе опустить поле), **Status:** `open`, **Source:** `manual (/log)`.
2. Путь: `.claude/learning-log/<MONTH>/<DAY>.md` (`date +%Y-%m` / `+%Y-%m-%d`).
3. **Read** файла-дня; нет файла → **Write** с H1 `# Learning Log — <DAY>` + блок. Есть → **Edit**: вставить блок `## HH:MM ...` сразу после строки H1 (новая запись сверху).
4. Показать что записано. Без «ок?» до записи.

### Workflow (win)

1. Заполнить: **What**, **Reusable**, **Target** (memory/skill/convention/—), **Status:** `open`, **Source:** `manual (/log)`.
2. Путь: `.claude/learning-log/wins/candidates.md`, заголовок `## YYYY-MM-DD HH:MM`.
3. **Read**/**Write**/**Edit**: prepend под H1 `# Win Candidates`. Нет файла — создать.
4. Показать что записано.

### Формат mistake

```markdown
## 14:32
- **Did:** автоматически отредактировал файлы без отчёта
- **Wanted:** показать кандидатов, дождаться выбора
- **Cause:** skill — нарушено правило "предлагает, не правит сам"
- **Related:** `mind-linking`
- **Status:** open
- **Source:** manual (/log)
```

(Дата mistake — в имени файла, заголовок `## HH:MM`. Win — полный `## YYYY-MM-DD HH:MM` в одном буфере. `Related`: бэктики `` `name` `` или `[[name]]` если в конфиге `wikilinks: true`.)

---

## Command: `/learning-log`

Показать open (mistakes + wins), без действий.

### Workflow

1. **Glob** `.claude/learning-log/**/*.md` → дневные файлы (исключить `wins/candidates.md`, `resolutions.md`).
2. **Read** каждый (с самых свежих). Дата = из имени файла, время = из `## HH:MM`. Фильтр `Status: open`, группировка по `Cause`.
3. **Read** `wins/candidates.md`, фильтр open wins.
4. (Опц.) **Read** `resolutions.md`, подсветить `Status: failed` (рецидивы).
5. Вывод:

```
Mistakes open (N):
▸ skill (M)
  ─ 2026-06-04 14:32 — автоматически отредактировал файлы без отчёта
    Cause: нарушено правило "предлагает, не правит сам"
    Related: `mind-linking`
▸ habit (L)
  ─ ...

Wins open (K):
  ─ 2026-06-05 14:10 — obsidian read без path= отдаёт active file → convention

Registry: R failed-фиксов (рецидивы) — см. /learning-log analyze
```

6. В конце: «`/learning-log analyze` — разобрать промахи · `/learning-log wins` — разобрать успехи». Действия сами не предлагать.

> Объём: при большом числе файлов читать последние ~2 месяца и сказать об этом.

---

## Command: `/learning-log analyze`

Разбор open **mistakes** — главная команда. Включает детект рецидива через registry.

### Workflow

1. **Посчитать ТОЧНО и разделить по КЛАССУ — не на глаз.** `grep -rc 'Status:\*\* open' <month>/` → отчёт начинается с точного N (прикидка при чтении = промах: однажды «~60», реально было 123). По `Source:` раздели: `user-correction` (Дима поправил → Claude НЕ поймал = СИГНАЛ) vs `self-correction` (поймал сам) — у них разная судьба (см. п.4, Runtime-fix). Загрузить все open-блоки, помня для каждого **файл-день** и блок.
2. **Read `resolutions.md`** — держать pattern-key'и (для рецидива и переиспользования ключей).
3. **Группировка похожих** (одинаковый Related + похожий Did/Wanted), в т.ч. через разные дни.
4. Для каждой группы/записи — **сверить с registry** (семантика + Related + Cause): новый паттерн или рецидив уже разобранного?
   - **Новый паттерн:**
     - фикс по Cause: `skill`→diff · `claude-md`→diff CLAUDE.md · `memory`→preview · `habit`→awareness only · `unknown`→переспросить;
     - подтверждение → выполнить;
     - присвоить **pattern-key** (kebab; переиспользуй существующий из registry, если подходит);
     - **добавить строку в registry**: `| <key> | <fix> | <today> | applied | 0 | — |`.
   - **Рецидив** (совпал с registry-строкой):
     - **НЕ предлагать тот же фикс** — провалился. Эскалировать (правило → хук; awareness → правило);
     - в registry-строке: `Recur++`, `Status → failed`, `Last seen = <today>`;
     - в новой записи добавить `- **Recurrence-of:** <key>`;
     - усиленный фикс → подтверждение → выполнить.
   - **Runtime-fix** у записи (в моменте выкрутился) → ТОЛЬКО для `self-correction`: разбираем **корень**; тривиально/разово → `wontfix` «awareness only».
   - ⚠️ **`user-correction` НИКОГДА не валить скопом в `wontfix`/«awareness/self-corrected».** Дима поправил = промах реальный, не «сам поймал». Каждый user-correction: либо `addressed` (назвать КОНКРЕТНЫЙ фикс — какой skill/CLAUDE.md/memory правится прямо сейчас), либо рецидив→registry→escalate. Нет конкретного фикса и не рецидив → оставить `open` (не закрывать ленивым wontfix). Bulk-флип одним текстом по всем — запрещён.
5. Флип на месте (**Edit**): `old_string` = строка `- **Did:** …` + строка `- **Status:** open` этой записи (вместе — уникально на запись). Сменить `Status` на `addressed`/`wontfix`, добавить `- **Resolution:** YYYY-MM-DD — <что сделали>` в конец блока. Запись не удаляется и не переезжает.
6. Итог: «обработано N, addressed=X, wontfix=Y, рецидивов=R, остались open=Z». Предложить commit (если в проекте есть свой sync/commit flow).

### Что НЕ делает analyze

- Не правит skill/CLAUDE.md/memory без подтверждения.
- Не переносит записи — статус флипается на месте.
- Не трогает win-кандидаты (это `/learning-log wins`).

---

## Command: `/learning-log wins`

Разбор open win-кандидатов: promote в знание или discard.

### Workflow

1. **Read** `wins/candidates.md`, фильтр `Status: open`.
2. Для каждого:
   - показать `What` / `Reusable` / `Target`;
   - выбрать цель: **memory** · **skill** · **convention** · **discard**;
   - **проверить дубль** (не плодить существующий вывод);
   - preview/diff → подтверждение → выполнить промоут.
3. Флип на месте (**Edit**): `Status: open → addressed` + `- **Promoted-to:** <ref>`, либо `wontfix`.
4. Итог: «promoted=X, discarded=Y, остались open=Z». Предложить commit.

> Registry у wins нет. Повтор того же вывода = сигнал «не пользуюсь своим знанием», авто-детект — future work.

---

## Command: `/learning-log flush`

Ручной прогон классификатора по необработанному хвосту transcript (страховка, если авто-порог не сработал). Наполняет лог (mistakes + wins), в отличие от `analyze` (разбирает).

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
2. Вызвать классификатор напрямую (берёт chunk от anchor до конца, без порога; сам пишет mistakes в дневной файл + wins в `candidates.md`):
   `bash .claude/hooks/learning-log-analyze.sh "$TRANSCRIPT" ".claude/state/learning-log.json"`
3. Показать сколько записей добавилось.

**Note:** на очень длинном transcript haiku недетерминирован (может вернуть `[]`). Штатно работает на маленьких chunk'ах. Если пусто на длинной сессии — повторить.

---

## Command: `/learning-log on|off [chat|global]` · `/learning-log status`

Тумблер захвата на двух уровнях. **Scope по умолчанию = `chat`** (точечно, авто-истекает с концом сессии — нельзя забыть вернуть). `global` — только по явному слову (постоянный, переживает рестарты).

**Приоритет:** `global off` перебивает всё (выключено везде). При `global on` чат из exclude-списка не логируется, остальные — да. То есть `off chat` = «кроме вот этого чата».

### Резолв session_id текущего чата
`CLAUDE_SESSION_ID` в env нет. Берём transcript текущей сессии по содержимому (как в `flush`); basename без `.jsonl` = session_id:
```bash
PROOT="$(pwd)"
SID=$(for f in "$HOME"/.claude/projects/*/*.jsonl; do
    [ -f "$f" ] || continue
    c=$(head -n1 "$f" | jq -r '.cwd // empty' 2>/dev/null)
    [ "$c" = "$PROOT" ] && printf '%s\t%s\n' "$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f")" "$f"
  done | sort -rn | head -1 | cut -f2 | xargs -I{} basename {} .jsonl)
```

### `/learning-log off chat` (default) / `on chat`
Правит `.claude/state/ll-excluded-sessions.json` (JSON-массив session_id; читается hook'ом trigger.sh):
```bash
EX=".claude/state/ll-excluded-sessions.json"; mkdir -p "$(dirname "$EX")"
[ -f "$EX" ] || echo '[]' > "$EX"
# off chat:  добавить уникально
jq --arg s "$SID" 'if any(.[]?; .==$s) then . else . + [$s] end' "$EX" > "$EX.t" && mv "$EX.t" "$EX"
# on  chat:  убрать
jq --arg s "$SID" 'map(select(. != $s))' "$EX" > "$EX.t" && mv "$EX.t" "$EX"
```

### `/learning-log off global` / `on global`
Правит `enabled` в конфиге (durable, переживает переустановку пакета):
```bash
CFG=".claude/learning-log.config.json"
jq '.enabled=false' "$CFG" > "$CFG.t" && mv "$CFG.t" "$CFG"   # off global
jq '.enabled=true'  "$CFG" > "$CFG.t" && mv "$CFG.t" "$CFG"   # on  global
```

### `/learning-log status`
Показать оба уровня + накопление:
```bash
GLOBAL=$(jq -r '.enabled // true' .claude/learning-log.config.json 2>/dev/null)
THISCHAT=$(jq -e --arg s "$SID" 'any(.[]?; .==$s)' .claude/state/ll-excluded-sessions.json >/dev/null 2>&1 && echo excluded || echo active)
LASTRUN=$(jq -r '.last_run_at // "never"' .claude/state/learning-log.json 2>/dev/null)
```
Вывести компактно:
```
global:    on            (или off)
this chat: active ✓       (или excluded ✗)
last run:  2026-06-15T12:02Z
```

---

## Auto-classifier overview

- **Триггер:** Stop hook форкает классификатор при `threshold` новых user/assistant-сообщений (default 6). SessionEnd — флеш хвоста.
- **Семантика, не regex:** haiku сам решает класс. Три класса: `user-correction`, `self-correction`, `win` (win — консервативно).
- **Background:** `claude -p --model <haiku>` под Max/Pro-подпиской (не платный API; `force_subscription` снимает `ANTHROPIC_API_KEY`). Не блокирует чат.
- **Output:** mistakes → prepend в `.claude/learning-log/<YYYY-MM>/<YYYY-MM-DD>.md`; wins → prepend в `.claude/learning-log/wins/candidates.md`. Registry классификатор не трогает.
- **State:** `.claude/state/learning-log.json` (per-machine, gitignored): `anchors` (per-session), `last_run_at`, `last_session_id`.

Пропустил — `/learning-log flush` или `/log <text>`.

## File layout

| Path | What |
|---|---|
| `.claude/learning-log/<YYYY-MM>/<YYYY-MM-DD>.md` | Mistakes (дневные, open + addressed/wontfix) |
| `.claude/learning-log/wins/candidates.md` | Win-кандидаты (буфер) |
| `.claude/learning-log/resolutions.md` | Registry эффективности фиксов (паттерн = строка) |
| `.claude/learning-log.config.json` | Конфиг (threshold, model, persona, language, wikilinks, log_dir, enabled…) |
| `.claude/state/ll-excluded-sessions.json` | per-chat opt-out: session_id'ы, которые hook пропускает |
| `.claude/hooks/learning-log-trigger.sh` | Stop/SessionEnd entry |
| `.claude/hooks/learning-log-analyze.sh` | Background haiku-классификатор (mistakes + wins) |
| `.claude/hooks/skill-invocation-log.sh` | PostToolUse Skill logger |
| `.claude/hooks/_lib/{env,paths,config}.sh` | PATH restore / root resolution / config loader |
| `.claude/state/learning-log.json` | per-machine: anchors, last_run_at, last_session_id |
| `.claude/state/skill-invocations.jsonl` | per-machine recent skill calls |

## What this skill does NOT do

- Не редактирует CLAUDE.md / skills / memory без подтверждения.
- Не делает git commit / push.
- Не запускает background-классификатор сам — это hook'и.
- Не переносит записи в архив — статус флипается на месте.
