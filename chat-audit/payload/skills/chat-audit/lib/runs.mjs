#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const DAY_MS = 86_400_000;
const STALE_DAYS = 60;
const ITEM_ID = /^(?:[1-9]\d*|[А-ЯЁ])$/u;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u;
const STATE_DIR = '.claude/state/chat-audit';
const NOTES_DIR = '01 projects/chat-audit';
const USAGE = 'Usage: runs.mjs record --project <id> --audit <name> [--items <comma-separated ids>] '
  + '[--all-mandatory] [--lenses <comma-separated names>] [--report <path>] | refresh';

function readOptional(path) {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function parseCatalogue(text) {
  const items = new Map();
  const lenses = new Map();
  let heading = '';
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) heading = line.slice(3);
    if (!line.startsWith('|')) continue;
    const [, id, title] = line.split(/(?<!\\)\|/, 3).map(cell => cell.trim());
    const mandatory = heading.startsWith('Обязательные');
    if ((mandatory || heading.startsWith('Под конкретный проект')) && ITEM_ID.test(id) && title) {
      if (items.has(id)) throw new Error(`Duplicate audit item: ${id}`);
      items.set(id, { title, mandatory });
    } else if (heading.startsWith('Линзы скилла') && NAME.test(id) && title) {
      lenses.set(id, title);
    }
  }
  if (!items.size || !lenses.size) throw new Error('No audit items or lenses found in the catalogue');
  return { items, lenses };
}

function parseRuns(text) {
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const row = JSON.parse(line);
      if (!NAME.test(row.project ?? '') || !row.machine || !Number.isFinite(Date.parse(row.ts))
          || !Array.isArray(row.items) || !Array.isArray(row.lenses)) throw new Error('Invalid run');
      return [row];
    } catch (error) {
      throw new Error(`Invalid runs.jsonl line ${index + 1}: ${error.message}`);
    }
  });
}

function getMachine(registry, host) {
  const normalize = name => name.toLowerCase().split('.')[0];
  const id = Object.entries(registry.machines).find(([, machine]) =>
    machine.hostnames.some(alias => normalize(alias) === normalize(host)))?.[0];
  if (!id) throw new Error(`Hostname ${host} is missing from .claude/machines.json`);
  return id;
}

function splitList(text) {
  return [...new Set((text ?? '').trim().split(/[\s,]+/).filter(Boolean))];
}

function createRun(options, catalogue, machine, now) {
  const { project, audit, report = null } = options;
  const selected = splitList(options.items);
  for (const id of selected) {
    if (!catalogue.items.has(id)) throw new Error(`Unknown audit item: ${id}`);
  }
  const items = [...catalogue.items].filter(([id, item]) =>
    selected.includes(id) || (options['all-mandatory'] && item.mandatory)).map(([id]) => id);
  const lenses = splitList(options.lenses);
  for (const lens of lenses) {
    if (!NAME.test(lens)) throw new Error(`Invalid audit lens: ${lens}`);
  }
  if (!NAME.test(project ?? '') || !audit?.trim() || !(items.length || lenses.length)) throw new Error(USAGE);
  return { ts: now.toISOString(), project, machine, audit, items, lenses, report };
}

function indexRuns(runs, lenses) {
  const projects = new Map();
  for (const run of runs) {
    if (!projects.has(run.project)) projects.set(run.project, new Map());
    const coverage = projects.get(run.project);
    for (const lens of run.lenses) {
      if (!lenses.has(lens)) lenses.set(lens, 'Дополнительная линза');
    }
    for (const key of [...run.items.map(id => `item:${id}`), ...run.lenses.map(id => `lens:${id}`)]) {
      const previous = coverage.get(key);
      if (!previous || Date.parse(run.ts) > Date.parse(previous.ts)) coverage.set(key, run);
    }
  }
  return [...projects].sort(([first], [second]) => first.localeCompare(second, 'en'));
}

function formatRun(run, today) {
  if (!run) return 'Ни разу';
  const date = new Date(run.ts).toISOString().slice(0, 10);
  const days = Math.floor((Date.parse(today) - Date.parse(date)) / DAY_MS);
  const stale = days > STALE_DAYS ? ' · Просрочено (>60 дн.)' : '';
  return `${date} · ${days} дн. · ${run.machine}${stale}`;
}

function renderTable(catalogue, runs, today) {
  const projects = indexRuns(runs, catalogue.lenses);
  const header = ['Пункт / линза', 'Название', ...projects.map(([project]) => project)];
  const lines = [header, header.map(() => '---')];
  const addRow = (id, title, key) => lines.push([
    id, title, ...projects.map(([, coverage]) => formatRun(coverage.get(key), today)),
  ]);
  for (const [id, { title }] of catalogue.items) addRow(id, title, `item:${id}`);
  for (const [id, title] of catalogue.lenses) addRow(id, title, `lens:${id}`);
  return lines.map(row => `| ${row.map(cell => cell.replace(/(?<!\\)\|/g, '\\|')).join(' | ')} |`).join('\n');
}

function renderView({ catalogue, runs, today, created, revision }) {
  return [
    '---', 'kind: note', 'topic: ["[[chat-audit]]"]', `created: ${created}`,
    'description: Последний прогон каждого пункта и линзы чат-аудита по проектам и машинам.',
    '---', '', '# Прогоны чат-аудита', '',
    '> Generated by runs.mjs, do not edit.',
    `<!-- source revision: ${revision} -->`, '',
    `На ${today} (UTC). В ячейке дата последнего прогона, возраст в днях и машина. «Ни разу» означает, что покрытие не подтверждено в журнале.`, '',
    renderTable(catalogue, runs, today), '',
  ].join('\n');
}

function readSources(paths) {
  const catalogue = readFileSync(paths.catalogue, 'utf8');
  const log = readOptional(paths.log);
  const revision = createHash('sha256').update(catalogue.replaceAll('\r\n', '\n')).update('\0')
    .update(log.replaceAll('\r\n', '\n')).digest('hex');
  return { catalogue, log, revision };
}

function replaceView(path, content) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, 'utf8');
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

function refresh(paths, today) {
  // An append can land while another writer computes the table. Check after publishing, so
  // the last writer to finish always sees and includes both runs.
  for (let attempt = 0; attempt < 5; attempt++) {
    const { catalogue, log, revision } = readSources(paths);
    const current = readOptional(paths.view);
    const created = /^created: (\d{4}-\d\d-\d\d)$/m.exec(current.replaceAll('\r\n', '\n'))?.[1] ?? today;
    const next = renderView({ catalogue: parseCatalogue(catalogue), runs: parseRuns(log), today, created, revision });
    if (current.replaceAll('\r\n', '\n') !== next) replaceView(paths.view, next);
    if (revision === readSources(paths).revision) return;
  }
  throw new Error('Audit coverage changed during refresh. Retry refresh.');
}

function record(paths, options, now) {
  const { catalogue, log } = readSources(paths);
  parseRuns(log);
  const registry = JSON.parse(readFileSync(paths.machines, 'utf8'));
  const run = createRun(options, parseCatalogue(catalogue), getMachine(registry, hostname()), now);
  mkdirSync(dirname(paths.log), { recursive: true });
  const newline = log && !log.endsWith('\n') ? '\n' : '';
  appendFileSync(paths.log, newline + JSON.stringify(run) + '\n', 'utf8');
  try { refresh(paths, now.toISOString().slice(0, 10)); }
  catch (error) { throw new Error(`Run recorded. Retry with refresh to update the view: ${error.message}`); }
}

function main([command, ...args]) {
  const root = resolve(process.env.MIND_VAULT || join(homedir(), 'mind'));
  const paths = {
    log: join(root, STATE_DIR, 'runs.jsonl'), machines: join(root, '.claude/machines.json'),
    view: join(root, NOTES_DIR, 'runs.md'), catalogue: join(root, NOTES_DIR, 'audit-mandatory-items.md'),
  };
  const now = new Date();
  if (command === 'refresh') {
    if (args.length) throw new Error(USAGE);
    return refresh(paths, now.toISOString().slice(0, 10));
  }
  if (command !== 'record') throw new Error(USAGE);
  const options = Object.fromEntries(['project', 'audit', 'items', 'lenses', 'report'].map(name => [name, { type: 'string' }]));
  options['all-mandatory'] = { type: 'boolean' };
  record(paths, parseArgs({ args, options }).values, now);
}

try { main(process.argv.slice(2)); }
catch (error) {
  console.error(`runs.mjs: ${error.message}`);
  process.exitCode = 1;
}
