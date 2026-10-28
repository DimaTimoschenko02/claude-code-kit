// node --test spec-writer/test — the linter and its hook, both ways: fires on the broken case, stays silent beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lint, globToRegExp } from '../payload/skills/spec-writer/scripts/spec-lint.mjs';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', 'payload', 'skills', 'spec-writer');
const LINT = join(SKILL, 'scripts', 'spec-lint.mjs');
const SECTIONS = JSON.parse(readFileSync(join(SKILL, 'sections.json'), 'utf8')).sections;

const GOOD_RU = `---
task: PH-1
form: full
---

# PH-1: повторный прайс

## Результат

Повторно присланный файл ничего не меняет.

## Контракт

нет: задача без новых маршрутов.

## Решения

\`\`\`ts
export async function ingest(file: StoredFile): Promise<IngestResult>
\`\`\`

**хэш файла** — почему; **вместо** даты — дата врёт; **минус** — переименованный файл тоже дубль.

## Приёмка

- **П1** — второй импорт того же файла ничего не меняет → \`ingest.spec.ts: same file twice\`

## Где укусит

- тот же файл под другим именем — дубль → \`ingest.spec.ts: renamed copy\` (часть: бэк)

## Части

| Часть | Кто | Файлы | Проверка |
|---|---|---|---|
| бэк | кодер | apps/api/src/ingest.ts | \`pnpm test ingest\` |

## Если спека молчит

Мелкое — бери простое. TODO и TBD здесь не заглушки, а текст правила.

## Отклонения
`;

test('a filled full spec passes', () => {
  const r = lint(GOOD_RU, { language: 'ru' });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('a missing section and an acceptance line without a test fail', () => {
  const bad = GOOD_RU.replace('## Части', '## Разное').replace(' → `ingest.spec.ts: same file twice`', '');
  const r = lint(bad, { language: 'ru' });
  assert.ok(r.errors.some((e) => e.includes('«## Части»')));
  assert.ok(r.errors.some((e) => e.startsWith('П1')));
});

test('a placeholder in prose fails, the same word in code or in the silence rule does not', () => {
  assert.ok(lint(GOOD_RU.replace('Повторно присланный', 'TBD: повторно присланный'), { language: 'ru' })
    .errors.some((e) => e.includes('TBD')));
  const inCode = GOOD_RU.replace('Promise<IngestResult>', 'Promise<IngestResult> // TODO body');
  assert.deepEqual(lint(inCode, { language: 'ru' }).errors, []);
});

test('the template itself is not a spec: its hints count as empty', () => {
  const r = lint(readFileSync(join(SKILL, 'template.ru.md'), 'utf8'), { language: 'ru' });
  assert.ok(r.errors.some((e) => e.includes('Результат')));
});

test('short form needs only its four sections; an extra project section only in full', () => {
  const short = `---\nform: short\n---\n## Outcome\nx\n## Acceptance\n- **A1** — y → \`t\`\n## When the spec is silent\nz\n## Deviations\n`;
  assert.deepEqual(lint(short, { language: 'en', extraSections: ['Overlaps'] }).errors, []);
  assert.ok(lint(GOOD_RU, { language: 'ru', extraSections: ['Пересечения'] }).errors.some((e) => e.includes('Пересечения')));
});

test('templates carry exactly the headings of sections.json', () => {
  for (const lang of ['ru', 'en']) {
    const heads = readFileSync(join(SKILL, `template.${lang}.md`), 'utf8').match(/^## .+$/gm).map((h) => h.slice(3));
    assert.deepEqual(heads, SECTIONS.map((s) => s[lang]));
  }
});

test('glob: ** spans folders, * stays in one', () => {
  assert.ok(globToRegExp('docs/design/PH-*-spec.md').test('docs/design/PH-12-spec.md'));
  assert.ok(!globToRegExp('docs/design/PH-*-spec.md').test('docs/design/x/PH-12-spec.md'));
  assert.ok(globToRegExp('**/*-spec.md').test('a/b/c-spec.md'));
});

function project(lang = 'ru', glob = 'docs/design/PH-*-spec.md') {
  const root = mkdtempSync(join(tmpdir(), 'spec-lint-'));
  mkdirSync(join(root, '.claude'));
  mkdirSync(join(root, 'docs', 'design'), { recursive: true });
  writeFileSync(join(root, '.claude', 'spec-writer.project.md'), `---\nlanguage: ${lang}\nspec_glob: ${glob}\n---\n`);
  return root;
}
const hook = (file) => spawnSync('node', [LINT, '--hook'], {
  input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file } }), encoding: 'utf8' });

test('hook blocks a broken spec inside the glob', () => {
  const root = project();
  const f = join(root, 'docs', 'design', 'PH-1-spec.md');
  writeFileSync(f, GOOD_RU.replace('## Приёмка', '## Прочее'));
  const out = JSON.parse(hook(f).stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /Приёмка/);
});

test('hook is silent on a clean spec, a file outside the glob, and a project without the file', () => {
  const root = project();
  const ok = join(root, 'docs', 'design', 'PH-1-spec.md');
  writeFileSync(ok, GOOD_RU);
  assert.equal(hook(ok).stdout, '');
  const other = join(root, 'docs', 'design', 'PH-1-schema.md');
  writeFileSync(other, '# schema\n');
  assert.equal(hook(other).stdout, '');
  const bare = mkdtempSync(join(tmpdir(), 'spec-lint-bare-'));
  writeFileSync(join(bare, 'x-spec.md'), '# nothing\n');
  assert.equal(hook(join(bare, 'x-spec.md')).stdout, '');
});

test('hook finds a spec inside a worktree under the project root', () => {
  const root = project();
  const wt = join(root, '.claude', 'worktrees', 'PH-2', 'docs', 'design');
  mkdirSync(wt, { recursive: true });
  const f = join(wt, 'PH-2-spec.md');
  writeFileSync(f, '# PH-2\n');
  assert.equal(JSON.parse(hook(f).stdout).decision, 'block');
});

test('the seeded project template parses: a comment after an empty value is not a section', async () => {
  const { frontmatter } = await import('../payload/skills/spec-writer/scripts/spec-lint.mjs');
  const { fields } = frontmatter(readFileSync(join(SKILL, 'project-template.md'), 'utf8'));
  assert.equal(fields.extra_sections, '');
  assert.equal(fields.spec_glob, 'docs/specs/*-spec.md');
});

test('hook runs through a symlinked skill folder, as install --link leaves it', () => {
  const root = project();
  mkdirSync(join(root, '.claude', 'skills'));
  symlinkSync(SKILL, join(root, '.claude', 'skills', 'spec-writer'));
  const f = join(root, 'docs', 'design', 'PH-3-spec.md');
  writeFileSync(f, '# PH-3\n');
  const linked = join(root, '.claude', 'skills', 'spec-writer', 'scripts', 'spec-lint.mjs');
  const out = spawnSync('node', [linked, '--hook'], {
    input: JSON.stringify({ tool_input: { file_path: f } }), encoding: 'utf8' }).stdout;
  assert.equal(JSON.parse(out).decision, 'block');
});
