import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../payload/skills/chat-audit/lib/runs.mjs', import.meta.url));
const catalogue = [
  '## Обязательные — скриптами', '| № | Пункт |', '|---|---|', '| 5 | Хуки и отказы |',
  '## Обязательные — бывшие кандидаты', '| И | Качество инструментов |',
  '## Под конкретный проект — не обязательные', '| 21 | Петля заказчика |',
  '## Линзы скилла — где они в списке', '| rules | правила |', '| tooling | инструменты |',
].join('\r\n');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'audit coverage архив '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, MIND_VAULT: root };
  const log = join(root, '.claude/state/chat-audit/runs.jsonl');
  const notes = join(root, '01 projects/chat-audit');
  const cataloguePath = join(notes, 'audit-mandatory-items.md');
  const write = (file, data) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  };
  write(cataloguePath, catalogue);
  write(join(root, '.claude/machines.json'), JSON.stringify({
    machines: { workstation: { hostnames: [hostname().toUpperCase()] } },
  }));
  return {
    run: (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' }),
    runAsync: (...args) => promisify(execFile)(process.execPath, [script, ...args], { env }),
    readRuns: () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse),
    readView: () => readFileSync(join(notes, 'runs.md'), 'utf8'),
    writeLog: (...runs) => write(log, runs.map(row => JSON.stringify(row)).join('\n')),
    writeCatalogue: content => write(cataloguePath, content),
  };
}

test('record appends UTF-8 coverage and maps the hostname, including a mandatory shortcut', t => {
  const f = fixture(t);
  const first = f.run('record', '--project', 'alpha', '--audit', 'partial',
    '--items', 'И, 21', '--lenses', 'rules', '--report', 'reports/Отчёт с пробелом.md');
  assert.equal(first.status, 0, first.stderr);
  const second = f.run('record', '--project', 'beta', '--audit', 'full', '--all-mandatory');
  assert.equal(second.status, 0, second.stderr);
  const [partial, full] = f.readRuns();
  assert.deepEqual(partial, {
    ts: new Date(partial.ts).toISOString(), project: 'alpha', machine: 'workstation', audit: 'partial',
    items: ['И', '21'], lenses: ['rules'], report: 'reports/Отчёт с пробелом.md',
  });
  assert.deepEqual(full.items, ['5', 'И']);
  assert.deepEqual(full.lenses, []);
  assert.equal(full.report, null);
  assert.match(f.readView(), /\| 5 \| Хуки и отказы \| Ни разу \| [\d-]+ · \d+ дн\. · workstation \|/);
  assert.match(f.readView(), /\| 21 \| Петля заказчика \| [\d-]+ · \d+ дн\. · workstation \| Ни разу \|/);
});

test('refresh takes the latest timestamp for each project and exposes new catalogue rows', t => {
  const f = fixture(t);
  const base = { project: 'alpha', machine: 'old', audit: 'historical', items: ['И'], lenses: ['autonomy'], report: null };
  const last = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const stale = new Date(Date.now() - 61 * 86_400_000).toISOString();
  f.writeLog({ ...base, ts: last, lenses: [], machine: 'new' }, { ...base, ts: stale });
  f.writeCatalogue(catalogue.replace('| 5 | Хуки и отказы |', '| 5 | Хуки и отказы |\r\n| 22 | Новый пункт |'));
  const result = f.run('refresh');
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.readView(), /\| И \| Качество инструментов \| [\d-]+ · 60 дн\. · new \|/);
  assert.match(f.readView(), /\| autonomy \| Дополнительная линза \| [\d-]+ · 61 дн\. · old · Просрочено/);
  assert.match(f.readView(), /\| 22 \| Новый пункт \| Ни разу \|/);
  const invalid = f.run('record', '--project', 'alpha', '--audit', 'typo', '--items', '99');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unknown audit item: 99/);
  assert.equal(f.readRuns().length, 2);
});

test('parallel writers keep both log entries and both columns in the generated view', async t => {
  const f = fixture(t);
  await Promise.all(['alpha', 'beta'].map(project =>
    f.runAsync('record', '--project', project, '--audit', 'complete', '--items', 'И')));
  assert.deepEqual(f.readRuns().map(row => row.project).sort(), ['alpha', 'beta']);
  assert.match(f.readView(), /\| И \| Качество инструментов \| [\d-]+ · \d+ дн\. · workstation \| [\d-]+ · \d+ дн\. · workstation \|/);
});
