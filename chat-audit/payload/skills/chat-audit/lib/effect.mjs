#!/usr/bin/env node
// chat-audit :: effect — did a change to the agent's own infrastructure (hook, skill, rule, memory, agent, tool,
// settings) move the behaviour it was made for?
//
// Why (2026-10-02): 107 such changes in 16 days on one project and no way to say which worked. A hand audit found
// guards that never fired once, a skill loaded 2 times on 39 occasions, and an outage blamed on the nearest commit
// while the cause was an unversioned global setting. Every change now gets a `type:"change"` line in the ledger
// (written by instructions-tuning Step 5, format in modes/land.md); this tool measures each line's signal
// 7 days before vs since, from transcripts and the hook log, and prints a verdict.
//
// Usage:
//   node effect.mjs [--project <dir>] [--ledger <file>] [--id C-1,C-2] [--now <iso>] [--json]   # verdict table
//   node effect.mjs record (--id C-n[,C-m] | --all) [--project <dir>] [--ledger <file>]
//       freezes the 7-day baseline into the line: transcripts older than ~30 days are deleted by Claude Code.
//
// Signal sources (ledger `signal.src` / `occasion.src`), `re` is a case-insensitive regex:
//   assistant          main-thread reply text block           occasion default: replies
//   user               a human turn                          occasion default: human turns
//   tool:A|B[.field]   tool_use of A or B (Agent = Task); re on input[field], else on command|file_path|whole input
//                                                             occasion default: calls of the same tools
//   skill              Skill load or /slash command, re on the name — measured per SESSION: occasion sessions
//                      that loaded it                        occasion default: every session
//   deny:<hook>        fires of a guard: PreToolUse deny or Stop block by that hook, dedup by tool_use_id; `want` is
//                      ignored — 0 fires both sides = untested, a fire after = works (leaks need an attempts signal).
//                      A denied call that builds a hook payload (hook_event_name / tool_input / HOOK_TEST) is a hook
//                      test, not an attempt, and is dropped.          occasion default: sessions
//   hooklog:<hook>     .claude/state/hooks/*.jsonl lines of that hook (test lines dropped), re on
//                      "decision reason target"               occasion default: every line of that hook
// Dedup: tool_use by id, tool_result by tool_use_id, reply text by message.id + block (resumed sessions copy
// history; a raw grep counts denies ~2.4x).
import fs from 'node:fs';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { projectFolders } from './discover.mjs';

const DAY = 86400e3;
const WINDOW = 7 * DAY;
const MIN_AFTER = 5;
const SMOKE = 2 * 3600e3;
const ACTION = {
  works: '—', 'no-effect': 'reshape: predicate or hook', dead: 'delete or fold into what fires',
  untested: 'never cite as works', leaking: 'widen the scope', harmful: 'fix or revert today',
  'unclear-window': 're-check next run', unmeasurable: 'add a signal or accept as faith',
};

// ------------------------------------------------------------------ ledger

export function readLedger(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
}

/** Rewrite only the changed lines (Map id → row); every other line keeps its bytes — the ledger is append-only history. */
function rewriteLines(file, changed) {
  const raw = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const out = raw.map((l) => {
    try { const o = JSON.parse(l); return o.type === 'change' && changed.has(o.id) ? JSON.stringify(changed.get(o.id)) : l; } catch { return l; }
  });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, out.join('\n') + '\n');
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------------ specs

/** A signal/occasion spec → {kind, names, field, hook, re}. */
function compile(spec) {
  const src = String(spec.src || '');
  const re = new RegExp(spec.re || '.', 'i');
  const [head, rest = ''] = src.split(':');
  if (head === 'tool') {
    const [names, field = null] = rest.split('.');
    const set = new Set(names.split('|'));
    if (set.has('Agent') || set.has('Task')) { set.add('Agent'); set.add('Task'); }
    return { kind: 'tool', names: set, field, re };
  }
  if (head === 'deny' || head === 'hooklog') return { kind: head, hook: rest, re };
  return { kind: head, re };   // assistant | user
}

function defaultOccasion(signal) {
  const src = String(signal.src || '');
  if (src.startsWith('tool:')) return { src: src.split('.')[0], re: '.' };
  if (src === 'assistant') return { src: 'reply', re: '.' };
  if (src === 'user') return { src: 'user', re: '.' };
  if (src.startsWith('hooklog:')) return { src, re: '.' };
  return { src: 'sessions', re: '.' };   // skill, deny:<hook>
}

// ------------------------------------------------------------------ transcript pass

function transcriptFiles(project) {
  const out = [];
  for (const { folder } of projectFolders(project, 'subtree')) {
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(folder, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ file: p, session: e.name.slice(0, -6), main: true });
      else if (e.isDirectory()) {
        const walk = (d) => {
          let xs;
          try { xs = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
          for (const x of xs) {
            const q = path.join(d, x.name);
            if (x.isDirectory()) walk(q);
            else if (x.name.endsWith('.jsonl')) out.push({ file: q, session: e.name, main: false });
          }
        };
        walk(path.join(p, 'subagents'));
      }
    }
  }
  return out;
}

const SLASH = /<command-name>\/?([^<\s]+)<\/command-name>/;
// Anchored: a deny is the result itself; the same text inside a grep or a report is a quote (2 of 13 «denies» were).
const DENY = /^\s*(PreToolUse|PostToolUse|Stop):\w* ?hook error: \[([^\]]+)\]/;
const HOOK_TEST = /hook_event_name|tool_input|HOOK_TEST/;
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g;
const hookName = (cmd) => path.basename(String(cmd).trim().split(/\s+/).pop() || '').replace(/\.[^.]+$/, '');

/**
 * One pass over every transcript; calls emit(event) once per deduplicated event:
 *   {type:'reply'|'assistant'|'user'|'tool'|'skill'|'deny'|'session', t, s, ...}
 */
export function scanTranscripts(project, emit) {
  const seenTool = new Set(), seenText = new Set(), seenReply = new Set(), seenUser = new Set(), seenDeny = new Set();
  const hookTests = new Set();   // tool_use ids of calls that feed a payload to a hook — their denies are tests
  for (const { file, session, main } of transcriptFiles(project)) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const isResult = line.includes('"tool_result"');
      if (isResult && !line.includes('hook error')) continue;   // the bulk of the bytes, nothing to count
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const t = Date.parse(o.timestamp);
      if (Number.isNaN(t)) continue;
      const s = session;
      const c = o.message?.content;
      if (o.type === 'assistant' && Array.isArray(c)) {
        c.forEach((b, i) => {
          if (b?.type === 'text' && main && !o.isSidechain) {
            const k = `${o.message.id}|${i}|${b.text.slice(0, 40)}`;
            if (seenText.has(k)) return;
            seenText.add(k);
            if (!seenReply.has(o.message.id)) { seenReply.add(o.message.id); emit({ type: 'reply', t, s }); }
            emit({ type: 'assistant', t, s, text: b.text });
          } else if (b?.type === 'tool_use' && !seenTool.has(b.id)) {
            seenTool.add(b.id);
            if (b.name === 'Bash' && HOOK_TEST.test(String(b.input?.command || ''))) hookTests.add(b.id);
            emit({ type: 'tool', t, s, name: b.name, input: b.input || {}, test: hookTests.has(b.id) });
            if (b.name === 'Skill' && b.input?.skill) emit({ type: 'skill', t, s, name: String(b.input.skill) });
          }
        });
      } else if (o.type === 'user') {
        if (Array.isArray(c) && isResult) {
          for (const b of c) {
            if (b?.type !== 'tool_result' || b.is_error === false || seenDeny.has(b.tool_use_id) || hookTests.has(b.tool_use_id)) continue;
            const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            const m = DENY.exec(text);
            if (!m) continue;
            seenDeny.add(b.tool_use_id);
            emit({ type: 'deny', t, s, hook: hookName(m[2]), text });
          }
          continue;
        }
        if (!main || o.isSidechain || o.isMeta || o.isCompactSummary) continue;
        const text = typeof c === 'string' ? c
          : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n') : '';
        if (!text.trim()) continue;
        const k = o.uuid || `${o.timestamp}|${text.slice(0, 40)}`;
        if (seenUser.has(k)) continue;
        seenUser.add(k);
        const slash = SLASH.exec(text);
        if (slash) emit({ type: 'skill', t, s, name: slash[1] });
        emit({ type: 'session', t, s });
        if (!text.startsWith('<') && !text.startsWith('Caveat:')) emit({ type: 'user', t, s, text });
      } else if (o.type === 'attachment' && o.attachment?.type === 'hook_blocking_error') {
        const a = o.attachment;
        const k = `${s}|${o.timestamp}|${a.blockingError?.command || ''}`;
        if (seenDeny.has(k)) continue;
        seenDeny.add(k);
        emit({ type: 'deny', t, s, hook: hookName(a.blockingError?.command || ''), text: a.blockingError?.blockingError || '' });
      }
    }
  }
}

/** Hook-log lines, project and global, test runs dropped. */
export function readHookLog(project) {
  const out = [];
  for (const dir of [path.join(project, '.claude/state/hooks'), path.join(os.homedir(), '.claude/state/hooks')]) {
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        if (!l) continue;
        try {
          const o = JSON.parse(l);
          if (!o.test) out.push({ type: 'hooklog', t: Date.parse(o.ts), s: o.session, hook: o.hook, text: `${o.decision} ${o.reason || ''} ${o.target || ''}` });
        } catch { /* skip */ }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ matching + measuring

function matches(spec, ev) {
  switch (spec.kind) {
    case 'reply': return ev.type === 'reply';
    case 'assistant': case 'user': return ev.type === spec.kind && spec.re.test(ev.text);
    case 'sessions': return ev.type === 'session';
    case 'skill': return ev.type === 'skill' && spec.re.test(ev.name);
    case 'deny': return ev.type === 'deny' && ev.hook.includes(spec.hook) && spec.re.test(ev.text);
    case 'hooklog': return ev.type === 'hooklog' && ev.hook === spec.hook && spec.re.test(ev.text);
    case 'tool': {
      if (ev.type !== 'tool' || ev.test || !spec.names.has(ev.name)) return false;
      const i = ev.input;
      if (spec.field) return i[spec.field] !== undefined && i[spec.field] !== null && spec.re.test(String(i[spec.field]));
      // A heredoc body is data (a script, a quote), not the command being run.
      return spec.re.test(i.command != null ? String(i.command).replace(HEREDOC, '') : String(i.file_path ?? JSON.stringify(i)));
    }
    default: return false;
  }
}

function count(hits, occ, perSession, from, to) {
  const inW = (e) => e.t >= from && e.t < to;
  if (!perSession) return { hits: hits.filter(inW).length, occasions: occ.filter(inW).length };
  const occS = new Set(occ.filter(inW).map((e) => e.s));
  const hitS = new Set(hits.filter((e) => inW(e) && occS.has(e.s)).map((e) => e.s));
  return { hits: hitS.size, occasions: occS.size };
}

const rate = (w) => (w && w.occasions ? w.hits / w.occasions : 0);

export function verdict(change, before, after, hookLogStart) {
  const sig = change.signal;
  if (!sig) return 'unmeasurable';
  const src = String(sig.src || '');
  if (src.startsWith('hooklog:') && (hookLogStart === null || hookLogStart > Date.parse(change.ts)) && !after.occasions) return 'unclear-window';
  if (src.startsWith('hooklog:') && !after.occasions) return 'dead';
  if (after.occasions < MIN_AFTER) return 'unclear-window';
  const rb = rate(before), ra = rate(after), want = sig.want || 'down';
  if (src.startsWith('deny:')) return after.hits ? 'works' : 'untested';
  if (src === 'skill') {
    if (after.hits <= 1 || ra < 0.1) return 'dead';
    return ra >= 0.5 ? 'works' : 'no-effect';
  }
  if (want === 'present') return ra >= 0.5 && ra > rb ? 'works' : 'no-effect';
  if (want === 'up') {
    if (!rb) return ra > 0 ? 'works' : 'no-effect';
    return ra >= 1.5 * rb ? 'works' : ra <= 0.5 * rb ? 'harmful' : 'no-effect';
  }
  if (!before.hits && !after.hits) return 'untested';   // down|zero with nothing to prevent either side
  if (want === 'zero' && !after.hits) return 'works';
  if (ra <= 0.5 * rb) return 'works';
  if (rb && ra >= 2 * rb) return 'harmful';
  return 'no-effect';
}

/** Measure every ledger change that has a signal. Returns rows in ledger order. */
export function measure({ project, ledger, ids = null, now = Date.now() }) {
  const changes = readLedger(ledger).filter((r) => r && r.type === 'change' && (!ids || ids.includes(r.id)));
  const specs = [];
  for (const ch of changes) {
    if (!ch.signal) continue;
    const sig = compile(ch.signal);
    const occ = compile(ch.occasion || defaultOccasion(ch.signal));
    // Counted in sessions when the occasion is a session, or the signal is a skill load (one load per session is enough).
    specs.push({ ch, sig, occ, perSession: sig.kind === 'skill' || occ.kind === 'sessions', hits: [], occs: [] });
  }
  const feed = (ev) => {
    for (const sp of specs) {
      if (matches(sp.sig, ev)) sp.hits.push({ t: ev.t, s: ev.s });
      if (matches(sp.occ, ev)) sp.occs.push({ t: ev.t, s: ev.s });
    }
  };
  let hookLogStart = null;
  if (specs.length) {
    scanTranscripts(project, feed);
    const log = readHookLog(project);
    log.forEach(feed);
    hookLogStart = log.reduce((m, e) => (m === null || e.t < m ? e.t : m), null);
  }
  return changes.map((ch) => {
    const sp = specs.find((x) => x.ch === ch);
    const ts = Date.parse(ch.ts);
    let before = null, after = null;
    if (sp) {
      // The author's smoke tests and live checks sit right around the change: for actions (tool calls, guard fires)
      // the 2 h on each side of it are not behaviour. Text signals keep them — a reply right after a rule is compliance.
      if (sp.sig.kind === 'deny' || sp.sig.kind === 'tool') {
        const far = (e) => Math.abs(e.t - ts) >= SMOKE;
        sp.hits = sp.hits.filter(far);
        sp.occs = sp.occs.filter(far);
      }
      const b = ch.baseline && Number.isFinite(ch.baseline.hits) ? ch.baseline : count(sp.hits, sp.occs, sp.perSession, ts - WINDOW, ts);
      before = { hits: b.hits, occasions: b.occasions };
      after = count(sp.hits, sp.occs, sp.perSession, ts, now + 1);
    }
    const v = sp ? verdict(ch, before, after, hookLogStart) : 'unmeasurable';
    return { id: ch.id, kind: ch.kind, class: ch.class, signal: ch.signal ? ch.signal.src : null, before, after, verdict: v, recorded: ch.verdict || null, action: ACTION[v] };
  });
}

// ------------------------------------------------------------------ CLI

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

function fmt(w) { return w ? `${w.hits}/${w.occasions}` : '—'; }

function main() {
  const project = path.resolve(arg('project', process.cwd()));
  const ledger = path.resolve(arg('ledger', path.join(project, '.claude/state/chat-audit/ledger.jsonl')));
  const ids = arg('id') ? arg('id').split(',') : null;
  const now = arg('now') ? Date.parse(arg('now')) : Date.now();   // re-check a past state: what the table said then
  if (process.argv[2] === 'record') {
    const all = process.argv.includes('--all');
    if (!ids && !all) { console.error('record needs --id C-n[,C-m] or --all'); process.exitCode = 2; return; }
    const rows = readLedger(ledger);
    const want = rows.filter((r) => r && r.type === 'change' && r.signal && (ids ? ids.includes(r.id) : !r.baseline));
    const res = measure({ project, ledger, ids: want.map((r) => r.id) });
    for (const r of want) {
      const m = res.find((x) => x.id === r.id);
      r.baseline = { days: 7, hits: m.before.hits, occasions: m.before.occasions, at: new Date().toISOString().slice(0, 10) };
    }
    rewriteLines(ledger, new Map(want.map((r) => [r.id, r])));
    console.log(`baseline frozen for ${want.length} change line(s): ${want.map((r) => `${r.id} ${r.baseline.hits}/${r.baseline.occasions}`).join(', ')}`);
    return;
  }
  const res = measure({ project, ledger, ids, now });
  if (process.argv.includes('--json')) { console.log(JSON.stringify(res, null, 2)); return; }
  const measured = res.filter((r) => r.signal), rest = res.filter((r) => !r.signal);
  const head = ['id', 'kind', 'class', 'before', 'after', 'verdict', 'recorded', 'action'];
  const rows = measured.map((r) => [r.id, r.kind || '', String(r.class || '').slice(0, 48), fmt(r.before), fmt(r.after), r.verdict, r.recorded || '', r.action]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
  console.log(line(head));
  rows.forEach((r) => console.log(line(r)));
  const tally = {};
  res.forEach((r) => { tally[r.verdict] = (tally[r.verdict] || 0) + 1; });
  console.log(`\n${res.length} changes: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (rest.length) console.log(`unmeasurable (signal:null): ${rest.map((r) => r.id).join(' ')}`);
  console.log('before/after = hits/occasions (skill: sessions that loaded it / occasion sessions); before = frozen baseline when recorded.');
}

// argv[1] is the path as typed; import.meta.url is resolved through symlinks.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
