// node --test statements.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isUserComment, cardStatements } from './statements.mjs';

test('PR comments: the user opens threads; agent replies (bold, hashes, formal) are dropped; replies in the user own style stay', () => {
  assert.equal(isUserComment({ body: 'could it be done with just one sql query?' }), true);
  assert.equal(isUserComment({ body: 'it s a class not a single problem', in_reply_to_id: 1 }), true);
  assert.equal(isUserComment({ body: 'Ты прав, исправлено в f5c4380a. CLI уже проверял', in_reply_to_id: 1 }), false);
  assert.equal(isUserComment({ body: '**Да, так и было**: список ключей жил сам по себе' }), false);
  assert.equal(isUserComment({ body: 'Если про переносы и отступы — согласен.', in_reply_to_id: 1 }), false);
});

test('PR-level comments get the style test even without a thread', () => {
  assert.equal(isUserComment({ body: 'Конфликтует с dev — идёт через dev-bridge/main.' }, { threaded: false }), false);
  assert.equal(isUserComment({ body: 'нахуя тут слайс?' }, { threaded: false }), true);
});

test('cards: an answer carries its question; an open question (empty answer) is skipped; «Рішення» is one statement', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cards-')), 'PH-1.md');
  fs.writeFileSync(f, [
    '# PH-1', '## Рішення', '- **Заказ = прайс-лист** — User 22.10', '', '## Питання',
    '1. **Прятать поле?** контекст', '   **Рекомендую: 1**', '   - **Ответ:** пусть по дефолту выключены',
    '2. **Второй вопрос?**', '   - **Ответ:**',
    '3. **Третий?**', '   - **Ответ (User, 03.11):** 2 — так проще',
  ].join('\n'));
  const s = cardStatements(f, 'k');
  const answers = s.filter((x) => x.source === 'card-answer');
  assert.equal(answers.length, 2);
  assert.equal(answers[0].text, 'пусть по дефолту выключены');
  assert.match(answers[0].context, /Прятать поле/);
  assert.deepEqual(answers[1].tags, ['User, 03.11']);
  assert.equal(s.filter((x) => x.source === 'card-decision').length, 1);
});
