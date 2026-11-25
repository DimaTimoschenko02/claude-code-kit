#!/usr/bin/env node
// chat-audit :: memory recall
//
// Answers the `memory` lens question with numbers instead of impressions: when a session worked on a code
// module, did it (or the agents it spawned) open the knowledge written about that module — and did it write
// anything back? Also: which modules get work but have no knowledge file at all, and which knowledge files
// nobody opened in the window.
//
// Module of a code file = the path segment after the last `modules|packages|features|services|domains/`
// (apps/api/src/modules/matching/x.ts → matching; packages/parsers/src/a.ts → parsers). Generic on purpose:
// a project with another layout passes `memory_recall.topics` in .claude/chat-audit.config.json.
//
// Knowledge about module m = a .md under the knowledge roots whose file name starts with m
// (matching.md, matching-module.md) or whose text points into `modules/m` / `packages/m`, plus whatever the
// config maps explicitly: { "memory_recall": { "knowledge": ["docs/modules", ...],
//                                              "skip_dirs": ["tasks", "sprints"],
//                                              "topics": { "supplier-item": ["memory/project/x.md"] } } }
//
// A session "touched" m when it (or its subagents) edited a file of m, or read 2+ of m's files.
// A knowledge file counts as read on a Read of it, or a shell command naming its file name (cat/sed/rg/grep).
// Codex rollouts in the project count too: they read through the shell.
//
// Usage:
//   node memory-recall.mjs --project <dir> [--days 14] [--knowledge <dir,dir>] [--by user|agent] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listSessions, findMemory } from './discover.mjs';

const CONTAINERS = new Set(['modules', 'packages', 'features', 'services', 'domains']);
const CODE_EXT = /\.(ts|tsx|js|mjs|jsx|vue|py|php|go|rs|sql|java|kt|cs|rb)$/;
const SKIP_PATH = /(^|\/)(node_modules|dist|\.claude|\.git|docs|memory)\//;

export function moduleOf(file) {
  if (!file || !CODE_EXT.test(file) || SKIP_PATH.test(file)) return null;
  const segs = file.split('/');
  for (let i = segs.length - 2; i >= 0; i--) {
    if (CONTAINERS.has(segs[i]) && i + 1 < segs.length - 1) return segs[i + 1];
  }
  return null;
}

// Folders that hold dated output (audit runs, harvest inboxes, day plans, logs, archives), not topic knowledge.
const NOT_KNOWLEDGE = /^(\.|node_modules|harvest|plans?|logs?|audits?|archive|sessions?)$|^audit-\d/;

function walkMd(dir, out = [], depth = 0, skip = null) {
  if (depth > 5) return out;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!NOT_KNOWLEDGE.test(e.name) && !(skip && skip.test(e.name))) walkMd(p, out, depth + 1, skip); }
    else if (e.name.endsWith('.md') && e.name !== 'MEMORY.md') out.push(p);
  }
  return out;
}

/** Knowledge files keyed by "<parent>/<name>.md" — the same file reached through a symlink, a worktree copy
 *  or the vault path maps to one key. */
export function loadKnowledge(roots, skip = null) {
  const files = new Map();
  for (const r of roots) {
    let real;
    try { real = fs.realpathSync(r); } catch { continue; }
    for (const p of walkMd(real, [], 0, skip)) {
      const key = keyOf(p);
      if (files.has(key)) continue;
      let text = '';
      try { text = fs.readFileSync(p, 'utf8'); } catch {}
      files.set(key, { key, path: p, bytes: Buffer.byteLength(text), text });
    }
  }
  return files;
}
const keyOf = (p) => path.basename(path.dirname(p)) + '/' + path.basename(p);

function aboutModules(k, modules, topics) {
  const stem = path.basename(k.key, '.md').toLowerCase();
  const hit = new Set();
  for (const m of modules) {
    if (stem === m || stem.startsWith(m + '-')) hit.add(m);
    else if (new RegExp(`(modules|packages|features|services|domains)/${m.replace(/[-]/g, '\\-')}(/|\\b(?!-))`).test(k.text)) hit.add(m);
  }
  for (const [m, list] of Object.entries(topics || {})) if (list.some((x) => k.key.endsWith(x.split('/').slice(-2).join('/')))) hit.add(m);
  return hit;
}

function* records(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { yield JSON.parse(line); } catch {}
  }
}

/** Tool calls of a Claude transcript: { name, input }. Codex rollouts: function calls as shell text. */
function* toolCalls(file) {
  for (const o of records(file)) {
    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) if (b?.type === 'tool_use') yield { name: b.name, input: b.input || {} };
    } else if (o.type === 'response_item' && o.payload?.type === 'function_call') {
      yield { name: 'Bash', input: { command: String(o.payload.arguments || '') } };
    } else if (o.type === 'response_item' && o.payload?.type === 'custom_tool_call') {
      yield { name: 'Patch', input: { patch: String(o.payload.input || '') } };
    }
  }
}

function subagentFiles(sessionFile) {
  const dir = path.join(path.dirname(sessionFile), path.basename(sessionFile, '.jsonl'), 'subagents');
  const out = [];
  const walk = (d) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) out.push(p); } };
  walk(dir);
  return out;
}

const PATHISH = /[\w.@~-]*\/[\w.@/-]+/g;

function scanSession(meta, knowledgeNames) {
  const edited = new Map(), readCode = new Map(), readK = { main: new Set(), agents: new Set() }, wroteK = new Set();
  const bump = (map, m, f) => { if (!map.has(m)) map.set(m, new Set()); map.get(m).add(f); };
  const files = [{ f: meta.file, who: 'main' }, ...(meta.source === 'claude' ? subagentFiles(meta.file) : []).map((f) => ({ f, who: 'agents' }))];
  for (const { f, who } of files) {
    for (const { name, input } of toolCalls(f)) {
      const fp = input.file_path || input.notebook_path || '';
      if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) {
        const m = moduleOf(fp); if (m) bump(edited, m, fp);
        const k = keyOf(fp); if (knowledgeNames.has(k)) wroteK.add(k);
      } else if (name === 'Read') {
        const m = moduleOf(fp); if (m) bump(readCode, m, fp);
        const k = keyOf(fp); if (knowledgeNames.has(k)) readK[who].add(k);
      } else if (name === 'Bash' || name === 'Patch' || name === 'Grep') {
        const text = String(input.command || input.patch || input.path || '');
        for (const p of text.match(PATHISH) || []) {
          const m = moduleOf(p);
          if (m) bump(name === 'Patch' || /\*\*\* (Update|Add) File/.test(text) ? edited : readCode, m, p);
        }
        for (const k of knowledgeNames.byBase.keys()) {
          if (text.includes(k)) for (const full of knowledgeNames.byBase.get(k)) {
            // a write through the shell (heredoc, sed -i, tee) is a write, anything else a read
            if (new RegExp(`(>|tee |sed -i)[^\\n]*${k.replace(/\./g, '\\.')}`).test(text)) wroteK.add(full); else readK[who].add(full);
          }
        }
      }
    }
  }
  const touched = new Set(edited.keys());
  for (const [m, s] of readCode) if (s.size >= 2) touched.add(m);
  return { edited, touched, readK, wroteK };
}

export function memoryRecall({ project, days = 14, knowledge = null, by = null }) {
  const cfgPath = path.join(project, '.claude', 'chat-audit.config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).memory_recall || {}; } catch {}
  const roots = (knowledge || cfg.knowledge || []).map((r) => path.resolve(project, r));
  for (const m of findMemory(project)) if (m.kind === 'project') roots.unshift(m.realPath);
  const K = loadKnowledge(roots, cfg.skip_dirs?.length ? new RegExp(`^(${cfg.skip_dirs.join('|')})$`) : null);
  const names = new Set(K.keys());
  names.byBase = new Map();
  for (const k of K.keys()) { const b = path.basename(k); if (!names.byBase.has(b)) names.byBase.set(b, []); names.byBase.get(b).push(k); }

  const sessions = listSessions(project, { days, codex: true, by });
  const rows = [], allModules = new Set();
  for (const meta of sessions) {
    const s = scanSession(meta, names);
    if (!s.touched.size) continue;
    for (const m of s.touched) allModules.add(m);
    rows.push({ meta, ...s });
  }
  const about = new Map();   // module -> [knowledge keys]
  for (const k of K.values()) for (const m of aboutModules(k, allModules, cfg.topics)) {
    if (!about.has(m)) about.set(m, []); about.get(m).push(k.key);
  }
  const perModule = new Map();
  const touchedReads = new Set();
  const out = rows.map(({ meta, edited, touched, readK, wroteK }) => {
    const mods = [...touched].map((m) => {
      const ks = about.get(m) || [];
      const rMain = ks.filter((k) => readK.main.has(k)), rAg = ks.filter((k) => readK.agents.has(k) && !readK.main.has(k));
      const w = ks.filter((k) => wroteK.has(k));
      const pm = perModule.get(m) || { module: m, sessions: 0, edited: 0, withKnowledge: ks.length, readMain: 0, readAny: 0, wroteBack: 0 };
      pm.sessions++; if (edited.has(m)) pm.edited++;
      if (rMain.length) pm.readMain++; if (rMain.length || rAg.length) pm.readAny++; if (w.length) pm.wroteBack++;
      perModule.set(m, pm);
      for (const k of [...rMain, ...rAg]) touchedReads.add(k);
      return { module: m, edited: edited.has(m), knowledge: ks.length, readMain: rMain, readAgents: rAg, wrote: w };
    });
    return { session: meta.session.slice(0, 8), source: meta.source, launchedBy: meta.launchedBy, launch: meta.launch,
      started: meta.started, title: meta.title, modules: mods,
      readKnowledge: [...new Set([...readK.main, ...readK.agents])], wroteKnowledge: [...wroteK] };
  });
  const modules = [...perModule.values()].sort((a, b) => b.sessions - a.sessions);
  for (const m of modules) m.files = (about.get(m.module) || []).map((k) => `${k} (${Math.round(K.get(k).bytes / 1024)}K)`);
  const unread = [...K.values()].filter((k) => [...about.values()].some((l) => l.includes(k.key)) && !touchedReads.has(k.key))
    .map((k) => k.key);
  return { roots: roots.map((r) => { try { return fs.realpathSync(r); } catch { return r; } }), knowledgeFiles: K.size,
    sessionsScanned: sessions.length, sessionsTouchingModules: out.length, modules, sessions: out, moduleKnowledgeUnread: unread };
}

function main() {
  const a = process.argv.slice(2);
  const opt = (n, d = null) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : d; };
  const project = path.resolve(opt('project', process.cwd()));
  const r = memoryRecall({ project, days: Number(opt('days', 14)), knowledge: opt('knowledge')?.split(','), by: opt('by') });
  if (a.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`knowledge: ${r.knowledgeFiles} files in ${r.roots.join(', ')}`);
  console.log(`sessions: ${r.sessionsScanned} scanned, ${r.sessionsTouchingModules} worked on a code module\n`);
  console.log('module             sess  edit  know  read(main)  read(any)  wrote-back');
  for (const m of r.modules) {
    const pct = (n) => `${n}/${m.sessions}`.padEnd(10);
    console.log(`${m.module.padEnd(18)} ${String(m.sessions).padStart(4)}  ${String(m.edited).padStart(4)}  ${String(m.withKnowledge).padStart(4)}  ${pct(m.readMain)}  ${pct(m.readAny)} ${m.wroteBack}/${m.sessions}`);
  }
  console.log('\nknowledge per module:');
  for (const m of r.modules) console.log(`  ${m.module}: ${m.files.join(', ') || '— none —'}`);
  const freq = new Map();
  for (const s of r.sessions) for (const k of s.readKnowledge) freq.set(k, (freq.get(k) || 0) + 1);
  console.log(`\nknowledge actually opened (sessions): ${[...freq].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  console.log(`\nmodule knowledge nobody opened in the window: ${r.moduleKnowledgeUnread.join(', ') || '—'}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
