# The «spec is silent» rule

Every spec carries this rule in its own section, in the spec's language, plus any task-specific stop the task needs
(«a migration on `orders` — stop»). It goes into the spec, not only into the coder's role: Codex is told by its vendor
to «default to implementing with reasonable assumptions» and not to end a turn on a question, and models detect a
missing requirement on their own only a little better than chance (Ambig-SWE, ICLR 2026). A rule the coder has in front
of it beats its default; a rule in some other file loses to it.

Paste one of the two blocks as the section's body and add the task's own stops under it.

## ru

```markdown
Спека — источник правды; то, что в ней сказано, строится как сказано.
- **Мелкое и обратимое внутри своей части** (имя локальной переменной, порядок полей в ответе, текст лога) — бери
  самый простой вариант и запиши строку в «Отклонения»: что решил и почему.
- **Стоп и вопрос**, остальное в своей части доделай: сигнатура не сходится с реальными типами; нужен файл, маршрут,
  таблица, колонка или зависимость, которых спека не называет; правка чужого файла (не из «Частей»); что-то
  необратимое (миграция, удаление данных, запрос во внешний сервис); спека противоречит коду или сама себе; падает
  тест, не связанный с задачей.
- Тесты не правятся и не удаляются, чтобы пройти. В спеке правишь только «Отклонения».
- Сдаёшь команды проверки и их вывод, а не «всё зелёное».
```

## en

```markdown
The spec is the source of truth; what it states is built as stated.
- **Small and reversible inside your part** (a local name, field order in a response, a log text) — take the simplest
  option and add a line to «Deviations»: what you chose and why.
- **Stop and ask**, finishing the rest of your part: a signature does not match the real types; you need a file, route,
  table, column or dependency the spec does not name; you would edit a file outside your «Parts»; anything
  irreversible (a migration, deleting data, a call to an external service); the spec contradicts the code or itself; a
  test unrelated to the task fails.
- Never edit or delete a test to make it pass. In the spec you edit only «Deviations».
- Hand back the check commands and their output, not «all green».
```
