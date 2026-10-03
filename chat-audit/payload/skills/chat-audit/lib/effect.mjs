#!/usr/bin/env node
// chat-audit :: effect — did a change to the agent's own infrastructure (hook, skill, rule, memory, agent, tool,
// settings) move the behaviour it was made for?
//
// Why (2026-10-02): 107 such changes in 16 days on one project and no way to say which worked. A hand audit found
// guards that never fired once, a skill loaded 2 times on 39 occasions, and an outage blamed on the nearest commit
// while the cause was an unversioned global setting. Two sources of changes:
//   - git, by itself: every commit that touches agent config — the project's .claude/ and CLAUDE.md, ~/.claude (a local
//     repo since 2026-10-03, committed by its own Stop hook), the repos behind symlinked skills. One row per artifact,
//     its latest burst of commits, measured for liveness only: does the hook run and decide, is the skill / agent /
//     tool used at all since. Rows `G:<name>`.
//   - the ledger, by hand: a `type:"change"` line (instructions-tuning Step 5, format in modes/land.md) when a change has
//     a behaviour signal to measure — 7 days before vs since. A line for the same commit or artifact replaces its git row.
// Global artifacts are measured on every project's transcripts: one project's view called a skill used elsewhere dead.
//
// Usage:
//   node effect.mjs [--project <dir>] [--ledger <file>] [--id C-1,C-2] [--now <iso>] [--days 30] [--no-git]
//                   [--all-rows] [--json]                                                     # verdict tables
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
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { projectFolders } from './discover.mjs';

const DAY = 86400e3;
const WINDOW = 7 * DAY;
const MIN_AFTER = 5;
const SMOKE = 2 * 3600e3;
const GIT_DAYS = 30;   // Claude Code deletes transcripts after ~30 days: an older change has nothing to be measured on
const ACTION = {
  alive: 'runs; whether behaviour moved needs a ledger line with a signal',
  works: '—', 'no-effect': 'reshape: predicate or hook', dead: 'delete or fold into what fires',
  untested: 'never cite as works', leaking: 'widen the scope', harmful: 'fix or revert today',
  'unclear-window': 're-check next run', unmeasurable: 'add a signal or accept as faith',
  decaying: 'check the rule is still loaded and not superseded; recurs after that → hook',
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

/** `since`: a file last written before it holds no event of any window — skipped unread (all projects = 4.9 GB). */
function transcriptFiles(project, scope = 'subtree', since = 0) {
  const out = [];
  const fresh = (p) => { try { return fs.statSync(p).mtimeMs >= since; } catch { return false; } };
  for (const { folder } of projectFolders(project, scope)) {
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(folder, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) { if (fresh(p)) out.push({ file: p, session: e.name.slice(0, -6), main: true }); }
      else if (e.isDirectory()) {
        const walk = (d) => {
          let xs;
          try { xs = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
          for (const x of xs) {
            const q = path.join(d, x.name);
            if (x.isDirectory()) walk(q);
            else if (x.name.endsWith('.jsonl') && fresh(q)) out.push({ file: q, session: e.name, main: false });
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
export function scanTranscripts(project, emit, { scope = 'subtree', since = 0 } = {}) {
  const seenTool = new Set(), seenText = new Set(), seenReply = new Set(), seenUser = new Set(), seenDeny = new Set();
  const hookTests = new Set();   // tool_use ids of calls that feed a payload to a hook — their denies are tests
  for (const { file, session, main } of transcriptFiles(project, scope, since)) {
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

// A change can work for three days and then fade: the sum over the window still says `works` (C-4, the Ideas tail:
// 6.2% → 4.1% → 3.8% of replies by thirds, 2026-10-02). So a `works` whose gain is gone in the last third of the
// window — back to the baseline rate or worse — is `decaying`. Not for deny: there a fire is the success itself.
// A third shorter than a day is a topic change, not a trend (C-107 read «decaying» 5 h after its change).
export function verdict(change, before, after, hookLogStart, now = Date.now()) {
  const v = baseVerdict(change, before, after, hookLogStart, now);
  const last = after && after.last, want = change.signal && (change.signal.want || 'down');
  if (v !== 'works' || !last || last.occasions < MIN_AFTER || now - Date.parse(change.ts) < 3 * DAY
    || String(change.signal.src).startsWith('deny:')) return v;
  const rb = rate(before), ra = rate(after), rl = rate(last);
  const down = want === 'down' || want === 'zero';
  return (down ? ra < rb && rl >= rb : ra > rb && rl <= rb) ? 'decaying' : v;
}

function baseVerdict(change, before, after, hookLogStart, now) {
  const sig = change.signal;
  if (!sig) return 'unmeasurable';
  const src = String(sig.src || ''), want = sig.want || 'down';
  // A hook with no log line for a full window of logging is not running (or never triggered); before that, too early.
  // The window counts from the later of the change and the log's start: a hook changed before logging began and
  // silent through a full window since is just as dead.
  if (src.startsWith('hooklog:') && !after.occasions) {
    const from = Math.max(Date.parse(change.ts), hookLogStart ?? Infinity);
    return now - from >= WINDOW ? 'dead' : 'unclear-window';
  }
  // Liveness (rows from git): it runs at all — a load, a call, a log line; `fires` also wants a decision.
  if (want === 'alive' || want === 'fires') {
    if (after.hits) return 'alive';
    if (want === 'fires') return 'untested';   // has log lines, never denied, blocked, deferred or injected
    return now - Date.parse(change.ts) >= WINDOW ? 'dead' : 'unclear-window';
  }
  if (after.occasions < MIN_AFTER) return 'unclear-window';
  const rb = rate(before), ra = rate(after);
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

// ------------------------------------------------------------------ changes from git

const SCRIPT = /\.(sh|mjs|cjs|js|py)$/;

function git(dir, args) {
  try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256e6 }); } catch { return null; }
}

/**
 * A path relative to a config root (a .claude dir, ~/.claude) → {kind, name}, or null when it does not shape agent
 * behaviour (tests, retired hooks, the claude.ai skills Claude Code syncs in). A script under hooks/ that no settings file
 * wires is a library: `hook-support`, it has no log of its own. Rules, settings and memory are named by path.
 */
export function artifactOf(r, wired = null) {
  const p = r.split('/'), base = p[p.length - 1], stem = base.replace(/\.[^.]+$/, '');
  if (r === 'CLAUDE.md' || p[0] === 'rules') return { kind: 'rule', name: r };
  if (p[0] === 'skills' && p.length > 2) return p[1] === 'synced' ? null : { kind: 'skill', name: p[1] };
  if (p[0] === 'agents' && p.length === 2 && base.endsWith('.md')) return { kind: 'agent', name: stem };
  if (p[0] === 'hooks') {
    if (p.some((x) => x === '_retired' || x.startsWith('.')) || /^test|selftest/.test(stem)) return null;
    if (SCRIPT.test(base) && !p.includes('_lib') && (!wired || wired.has(stem))) return { kind: 'hook', name: stem };
    return { kind: 'hook-support', name: p.length > 2 ? p.slice(0, 2).join('/') : r };
  }
  if (p.length === 1 && /^settings(\.local)?\.json$|\.config\.json$/.test(base)) return { kind: 'settings', name: r };
  if (p[0] === 'memory' && (base === 'MEMORY.md' || base.startsWith('feedback_'))) return { kind: 'memory', name: r };
  if ((p[0] === 'bin' || p[0] === 'tools') && p.length === 2 && !base.startsWith('.')) return { kind: 'tool', name: stem };
  return null;
}

/** Hook script names wired in these .claude dirs' settings — a hook logs under the same name (hook-log.sh). */
function wiredHooks(dirs) {
  const set = new Set();
  for (const f of dirs.flatMap((d) => [path.join(d, 'settings.json'), path.join(d, 'settings.local.json')])) {
    let o;
    try { o = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    for (const groups of Object.values(o.hooks || {})) for (const g of groups || []) for (const h of g.hooks || []) if (h.command) set.add(hookName(h.command));
  }
  return set;
}

/**
 * Config roots to read: ~/.claude first (its rows are global), then the project's .claude dirs, and for each a skill
 * symlinked from another repo (the kit, the vault) — its history lives in that repo. A target already taken stays
 * with the first root: a skill linked both globally and from the project is global.
 */
function configRoots(project) {
  const roots = [], seen = new Set();
  const take = (dir, scope, skill = null) => {
    let real;
    try { real = realpathSync(dir); } catch { return null; }
    const top = git(real, ['rev-parse', '--show-toplevel'])?.trim();
    if (!top || seen.has(real)) return null;
    seen.add(real);
    const root = { top, rel: path.relative(top, real), scope, skill, dir: real, links: new Set() };
    roots.push(root);
    return root;
  };
  const claudeDirs = [[path.join(os.homedir(), '.claude'), 'global'], [path.join(project, '.claude'), 'project']];
  try {
    for (const e of fs.readdirSync(project, { withFileTypes: true })) if (e.isDirectory()) claudeDirs.push([path.join(project, e.name, '.claude'), 'project']);
  } catch { /* no project dir */ }
  for (const [dir, scope] of claudeDirs) {
    const root = take(dir, scope);
    if (!root) continue;
    let skills = [];
    try { skills = fs.readdirSync(path.join(dir, 'skills'), { withFileTypes: true }); } catch { /* none */ }
    // A linked skill's content history is in its target's repo; here git sees only the link itself.
    for (const s of skills) if (s.isSymbolicLink()) { root.links.add(s.name); take(path.join(dir, 'skills', s.name), scope, s.name); }
  }
  return roots;
}

/** Hand ledger line → the artifacts its paths name (repo-relative paths, kit payload paths). */
function handArtifacts(row) {
  return (row.paths || []).map((p) => {
    const i = p.lastIndexOf('.claude/'), j = p.indexOf('/payload/');
    const r = i > -1 ? p.slice(i + 8) : j > -1 ? p.slice(j + 9) : p;
    return artifactOf(r.replace(/\/$/, '/x'));
  }).filter(Boolean);
}

/** The hook's script text, plus its folder's other scripts when it lives in its own folder (a lib it sources). */
function hookText(file) {
  const dir = path.dirname(file);
  const files = path.basename(dir) === 'hooks' ? [file]
    : (() => { try { return fs.readdirSync(dir).filter((f) => SCRIPT.test(f)).map((f) => path.join(dir, f)); } catch { return [file]; } })();
  return files.map((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
}

// A hook that can say no or speak: deny / block / defer by exit 2, inject by additionalContext or a marked decision.
const DECIDES = /hook_log\s+(deny|block|inject|defer)\b|\bexit 2\b|process\.exit\(2\)|exitCode\s*=\s*2|decision\s*=\s*['"](deny|block|inject|defer)|permissionDecision|additionalContext/;

/** The behaviour a row from git can be measured on without anyone picking a regex: liveness of its kind. */
function liveness(a, file) {
  const name = a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sessions = { src: 'sessions', re: '.' };
  switch (a.kind) {
    case 'hook': {
      // Measured on the shared hook log — a hook keeping its own log would read as dead. A guard or injector is alive
      // when it decides; a recorder (snapshots, a skill-load log) decides nothing by design, and lives by its passes.
      const text = hookText(file);
      if (!/hook[-_]log|hookLog/.test(text)) return { signal: null, occasion: null, note: 'writes no shared hook log' };
      return DECIDES.test(text)
        ? { signal: { src: `hooklog:${a.name}`, re: '^(deny|block|defer|inject)', want: 'fires' }, occasion: null }
        : { signal: { src: `hooklog:${a.name}`, re: '^pass', want: 'alive' }, occasion: null, note: 'recorder: lives by its passes' };
    }
    case 'skill': return { signal: { src: 'skill', re: `^([\\w-]+:)?${name}$`, want: 'alive' }, occasion: null };
    case 'agent': return { signal: { src: 'tool:Agent.subagent_type', re: `^([\\w-]+:)?${name}$`, want: 'alive' }, occasion: sessions };
    case 'tool': return { signal: { src: 'tool:Bash.command', re: `(^|[\\s/])${name}(?![\\w.-])`, want: 'alive' }, occasion: sessions };
    default: return { signal: null, occasion: null };   // rule, memory, settings, hook-support: no mechanical signal
  }
}

/**
 * Change rows from git since `since`: one per artifact — its latest burst (commits less than SMOKE apart) — unless a
 * hand ledger line covers that burst (same commit, or the same artifact within 6 h of it). Skipped: a root commit (the
 * first snapshot of a repo, not a change) and an artifact whose files are gone (retired, moved).
 */
export function gitChanges(project, hand, since) {
  const roots = configRoots(project);
  const wired = { global: wiredHooks([path.join(os.homedir(), '.claude')]), project: wiredHooks(roots.filter((r) => r.scope === 'project' && !r.skill).map((r) => r.dir)) };
  const byArtifact = new Map(), seenSha = new Set();
  for (const root of roots) {
    const paths = root.skill || !root.rel ? [root.rel || '.'] : [`${root.rel}/`, path.join(path.dirname(root.rel), 'CLAUDE.md')];
    const out = git(root.top, ['log', `--since=${new Date(since).toISOString()}`, '--no-merges', '--name-only',
      '--format=%x1e%H%x1f%P%x1f%cI%x1f%s%x1f%b%x1f', '--', ...paths]);
    if (!out) continue;
    for (const rec of out.split('\x1e').slice(1)) {
      const [sha, parents, iso, subject, body, files = ''] = rec.split('\x1f');
      if (seenSha.has(sha) || !parents.trim()) continue;   // a second clone of the same repo; a root commit
      seenSha.add(sha);
      const session = /^Session:\s*(\S+)/m.exec(body)?.[1] || null;
      for (const f of files.split('\n').map((s) => s.trim()).filter(Boolean)) {
        const r = root.rel && f.startsWith(`${root.rel}/`) ? f.slice(root.rel.length + 1) : f;
        const a = root.skill ? { kind: 'skill', name: root.skill } : artifactOf(r, wired[root.scope]);
        if (!a || (a.kind === 'skill' && !root.skill && root.links.has(a.name))) continue;
        if (['rule', 'settings', 'memory'].includes(a.kind) && root.scope === 'project') a.name = f;
        const key = `${root.scope}|${a.kind}|${a.name}`;
        if (!byArtifact.has(key)) byArtifact.set(key, { a, scope: root.scope, top: root.top, commits: new Map() });
        const c = byArtifact.get(key).commits;
        if (!c.has(sha)) c.set(sha, { sha, t: Date.parse(iso), subject, session, files: [] });
        c.get(sha).files.push(f);
      }
    }
  }
  const rows = [];
  for (const { a, scope, top, commits } of byArtifact.values()) {
    const cs = [...commits.values()].sort((x, y) => y.t - x.t);
    const burst = [cs[0]];
    for (const c of cs.slice(1)) { if (burst[burst.length - 1].t - c.t < SMOKE) burst.push(c); else break; }
    const live = [...new Set(burst.flatMap((c) => c.files))].map((f) => path.join(top, f)).filter((f) => fs.existsSync(f));
    if (!live.length) continue;
    const start = burst[burst.length - 1].t, end = burst[0].t;
    // A ledger line covers only the artifacts it names: a commit touching two hooks with a line for one leaves the
    // other unmeasured otherwise. A line naming no path covers its whole commit.
    const fam = (k) => (k.startsWith('hook') ? 'hook' : k);
    const covered = hand.some((h) => {
      const named = handArtifacts(h);
      if (named.length && !named.some((x) => fam(x.kind) === fam(a.kind) && a.name.endsWith(x.name))) return false;
      if (h.commit && burst.some((c) => c.sha.startsWith(h.commit))) return true;
      const ht = Date.parse(h.ts);
      return named.length > 0 && ht >= start - 3 * SMOKE && ht <= end + 3 * SMOKE;
    });
    if (covered) continue;
    rows.push({
      type: 'change', source: 'git', id: `G:${scope === 'global' ? '~/' : ''}${a.name}`, ts: new Date(start).toISOString(),
      session: burst[burst.length - 1].session, kind: a.kind, scope, commit: burst[0].sha.slice(0, 8), commits: burst.length,
      edits: cs.length, paths: [...new Set(burst.flatMap((c) => c.files))], class: burst[0].subject, ...liveness(a, live[0]),
    });
  }
  return rows.sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
}

// ------------------------------------------------------------------ measure

/**
 * Measure ledger changes (and, unless `ids` or `git:false`, the rows from git). A global change is measured on every
 * project's transcripts, a project change on this project's. Returns ledger rows in ledger order, then git rows.
 */
export function measure({ project, ledger, ids = null, now = Date.now(), git: useGit = true, days = GIT_DAYS }) {
  const hand = readLedger(ledger).filter((r) => r && r.type === 'change' && (!ids || ids.includes(r.id)));
  const all = [...hand, ...(useGit && !ids ? gitChanges(project, readLedger(ledger).filter((r) => r && r.type === 'change'), now - days * DAY) : [])];
  const res = new Map();
  for (const scope of ['subtree', 'all']) {
    const group = all.filter((ch) => (ch.scope === 'global') === (scope === 'all'));
    measureGroup(project, group, now, scope).forEach((r, i) => res.set(group[i], r));
  }
  return all.map((ch) => res.get(ch));
}

function measureGroup(project, changes, now, scope) {
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
    const since = Math.min(...specs.map((sp) => Date.parse(sp.ch.ts))) - WINDOW;
    scanTranscripts(project, feed, { scope, since });
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
      after.last = count(sp.hits, sp.occs, sp.perSession, ts + (2 * (now - ts)) / 3, now + 1);   // last third, for decaying
    }
    const v = sp ? verdict(ch, before, after, hookLogStart, now) : 'unmeasurable';
    return {
      id: ch.id, source: ch.source || 'ledger', scope: ch.scope || null, ts: ch.ts, kind: ch.kind, class: ch.class,
      signal: ch.signal ? ch.signal.src : null, before, after, verdict: v, recorded: ch.verdict || null, action: ACTION[v],
      ...(ch.source === 'git' ? { commit: ch.commit, commits: ch.commits, edits: ch.edits, session: ch.session, paths: ch.paths, note: ch.note || null } : {}),
    };
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
  const days = Number(arg('days', GIT_DAYS));
  const res = measure({ project, ledger, ids, now, git: !process.argv.includes('--no-git'), days });
  if (process.argv.includes('--json')) { console.log(JSON.stringify(res, null, 2)); return; }
  const table = (head, rows) => {
    const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
    const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
    console.log(line(head));
    rows.forEach((r) => console.log(line(r)));
  };
  const tally = (rs) => {
    const t = {};
    rs.forEach((r) => { t[r.verdict] = (t[r.verdict] || 0) + 1; });
    return Object.entries(t).map(([k, v]) => `${k} ${v}`).join(' · ');
  };
  const hand = res.filter((r) => r.source !== 'git'), auto = res.filter((r) => r.source === 'git');
  const measured = hand.filter((r) => r.signal), rest = hand.filter((r) => !r.signal);
  const aft = (r) => fmt(r.after) + (r.verdict === 'decaying' ? ` (last ⅓ ${fmt(r.after.last)})` : '');
  table(['id', 'kind', 'class', 'before', 'after', 'verdict', 'recorded', 'action'],
    measured.map((r) => [r.id, r.kind || '', String(r.class || '').slice(0, 48), fmt(r.before), aft(r), r.verdict, r.recorded || '', r.action]));
  console.log(`\n${hand.length} ledger changes: ${tally(hand)}`);
  if (rest.length) console.log(`unmeasurable (signal:null): ${rest.map((r) => r.id).join(' ')}`);
  console.log('before/after = hits/occasions (skill: sessions that loaded it / occasion sessions); before = frozen baseline when recorded.');
  if (!auto.length) return;
  // Rows from git: what needs a look first; `alive` and `unmeasurable` only as counts unless --all-rows.
  const all = process.argv.includes('--all-rows');
  const shown = auto.filter((r) => all || !['alive', 'unmeasurable'].includes(r.verdict));
  console.log(`\nfrom git, last ${days} days — ${auto.length} artifacts changed without a ledger line, liveness since the latest change:`);
  if (shown.length) {
    table(['id', 'kind', 'scope', 'changed', 'edits', 'after', 'verdict', 'action'],
      shown.map((r) => [r.id, r.kind, r.scope, r.ts.slice(0, 10), r.edits, fmt(r.after), r.verdict, r.note || r.action]));
  }
  console.log(`git rows: ${tally(auto)}`);
  const kinds = {};
  auto.filter((r) => r.verdict === 'unmeasurable').forEach((r) => { kinds[r.kind] = (kinds[r.kind] || 0) + 1; });
  if (Object.keys(kinds).length) console.log(`unmeasurable by kind (no mechanical signal): ${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (!all) console.log('--all-rows lists the alive and unmeasurable ones; hook: after = log lines with a decision / all its lines.');
}

// argv[1] is the path as typed; import.meta.url is resolved through symlinks.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
