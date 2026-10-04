#!/usr/bin/env node
// Token attribution over Claude Code transcripts.
//
// ccusage answers "how many tokens"; this answers "spent on WHAT".
// Every API call re-reads the whole context from cache, so a chunk that entered the
// context at call i costs (its size) x (calls left in that context segment).
// For each call we take the context growth since the previous call and split it across
// what was appended in between (tool results by tool, hook injections, user text,
// assistant output) proportionally to characters. Compaction starts a new segment.
//
// Why (2026-09-16): the user asked where the tokens go. ccusage showed 97% of them are
// cache reads, i.e. the bill is context size x call count; the open question is what that
// context consists of, and nothing off the shelf answers it.
//
// Usage (defaults to the current project and its worktrees, last 30 days):
//   node tokens.mjs [--project <dir>] [--all] [--dirs <transcript-dir>,...]
//                   [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--top N] [--json out.json]
//
// Dollars are API list prices, a weight rather than a bill on a subscription.
// Char-to-token split is proportional within one call's growth, so small classes are rough.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { scrub } from './scrub.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
    return acc;
  }, []),
);
const PROJECTS = path.join(process.env.HOME, '.claude', 'projects');
const slug = path.resolve(String(args.project === true || !args.project ? process.cwd() : args.project)).replace(/[^A-Za-z0-9]/g, '-');
const DIRS = args.dirs
  ? String(args.dirs).split(',').filter(Boolean)
  : fs.readdirSync(PROJECTS)
      .filter((d) => args.all || d === slug || d.startsWith(slug + '--claude-worktrees'))
      .map((d) => path.join(PROJECTS, d));
const SINCE = args.since ? Date.parse(args.since) : Date.now() - 30 * 86400e3;
const UNTIL = args.until ? Date.parse(args.until) + 86400e3 : Infinity;
const TOP = Number(args.top || 15);

// $/MTok. Cache read 0.1x input, 1h write 2x, 5m write 1.25x (Fable 5.1 read is 0.25 flat).
const PRICES = {
  opus: { in: 5, out: 25 },
  sonnet: { in: 2, out: 10 },
  fable: { in: 10, out: 50, cr: 0.25 },
  haiku: { in: 1, out: 5 },
};
function price(model) {
  const k = Object.keys(PRICES).find((p) => model?.includes(p)) || 'opus';
  const p = PRICES[k];
  return { in: p.in, out: p.out, cr: p.cr ?? p.in * 0.1, cw1h: p.in * 2, cw5m: p.in * 1.25 };
}

function listFiles() {
  const out = [];
  const walk = (d, depth) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'tool-results' || depth > 3) continue;
        walk(p, depth + 1);
      } else if (e.name.endsWith('.jsonl')) {
        const st = fs.statSync(p);
        if (st.mtimeMs >= SINCE) out.push({ p, size: st.size });
      }
    }
  };
  for (const d of DIRS) walk(d, 0);
  return out;
}

const len = (v) => (v == null ? 0 : typeof v === 'string' ? v.length : JSON.stringify(v).length);

function toolKey(name) {
  if (!name) return 'tool:?';
  if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__');
    return `mcp:${server}` + (server === 'claude-in-chrome' || server === 'blender' ? `:${tool}` : '');
  }
  return `tool:${name}`;
}

function bashKey(cmd) {
  if (!cmd) return '?';
  let c = cmd.replace(/^\s*(cd\s+\S+\s*&&\s*)+/, '').trim();
  // Leading `NAME=value` assignments are not the command, and `PGPASSWORD=…` must not reach the report: quoted values
  // are skipped whole; a command that is only assignments, or whose value does not parse, keys as `NAME=…`.
  const assign = c.match(/^(?:[A-Za-z_]\w*=(?:'[^']*'|"(?:[^"\\]|\\.)*"|[^\s'"])*(?:\s+|$))+/);
  if (assign) {
    const rest = c.slice(assign[0].length).trim();
    if (!rest || /^['"]/.test(rest)) return `${assign[0].split('=')[0]}=…`;
    c = rest;
  } else if (/^[A-Za-z_]\w*=/.test(c)) return `${c.split('=')[0]}=…`;
  const m =
    c.match(/^(npx\s+tsx\s+tools\/)([\w.-]+)/) ||
    c.match(/^(npm\s+run\s+)([\w:-]+)/) ||
    c.match(/^(npx\s+)(vitest|tsc|ccusage)/) ||
    c.match(/^(git\s+)(\w+)/) ||
    c.match(/^(python3?\s+)(\S+)/) ||
    c.match(/^(node\s+)(\S+)/) ||
    c.match(/^(bash\s+)(\S+)/);
  if (m) return (m[1] + m[2].replace(/^_.*/, '_scratch')).replace(/\s+/g, ' ');
  return scrub(c.split(/\s+/)[0].replace(/=.*/s, '=…')).slice(0, 30);
}

// Read results grouped by top-level directory of the session's project
function readKey(fp, cwd) {
  if (!fp) return '?';
  if (/\.(png|jpe?g|webp|gif)$/i.test(fp)) return 'image';
  if (/\/(\.claude\/)?memory\//.test(fp) || fp.endsWith('MEMORY.md')) return 'memory';
  if (fp.includes('/.claude/projects/') || fp.includes('/tool-results/')) return 'transcripts / spilled tool output';
  if (!cwd || !fp.startsWith(cwd + '/')) return 'outside project';
  const rel = fp.slice(cwd.length + 1).replace(/^\.claude\/worktrees\/[^/]+\//, '');
  return rel.split('/').slice(0, rel.startsWith('.claude/') ? 2 : 1).join('/');
}

// Aggregates
const agg = {
  calls: 0, cost: 0, in: 0, out: 0, cr: 0, cw: 0, thinking: 0,
  cwRebuild: 0, cwRebuildCalls: 0, cwRebuildCost: 0,
  byOrigin: {}, byProject: {}, byModel: {}, byCat: {}, byBash: {}, byRead: {}, byHook: {}, byBucket: {},
  sessions: [], baselines: [], agentBaselines: {},
};
const bump = (o, k, f) => {
  o[k] ??= { calls: 0, cr: 0, cw: 0, out: 0, cost: 0, tokens: 0, n: 0 };
  f(o[k]);
};

async function processFile({ p, size }) {
  const isSub = p.includes('/subagents/');
  let agentType = 'main';
  if (isSub) {
    try {
      agentType = JSON.parse(fs.readFileSync(p.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType || 'subagent';
    } catch { agentType = 'subagent'; }
    if (path.basename(p).startsWith('agent-acompact')) agentType = 'compact';
  }
  const project = (p.match(/projects\/([^/]+)/)?.[1] || '?').replace(/^-Users-dimti-?/, '').replace(/--claude-(worktrees|jobs).*/, '') || 'home';
  const toolNames = new Map(); // tool_use_id -> {key, sub}
  const seen = new Set();
  let title = '';
  let cwd = '';
  let isJob = false;

  // Pending chunks appended since last call: [{cat, sub, chars}]
  let pending = [];
  let asstPending = [];
  let asstVis = 0, asstTh = 0;
  // Per segment chunk ledger: [{cat, sub, tokens, atCall}]
  let segment = [];
  let segCalls = 0;
  let segBaseline = 0;
  let segBaselineCat = 'startup overhead';
  let prevCtx = null;
  let sessionCalls = 0, sessionCost = 0, peak = 0, ctxSum = 0, sessCr = 0, sessCw = 0, sessOut = 0;
  let firstTs = null, lastTs = null, model = '';
  let rebuilds = 0;
  let prevTs = null;

  const flushSegment = () => {
    // chunk persists for the rest of the segment: re-read on every later call
    for (const c of segment) {
      const reads = segCalls - c.atCall;
      if (reads <= 0) continue;
      const t = c.tokens * reads;
      const cost = (t * (segment.crPrice || 0.5)) / 1e6;
      bump(agg.byCat, c.cat, (o) => { o.cr += t; o.cost += cost; o.tokens += c.tokens; o.n++; });
      if (c.cat === 'tool:Bash') bump(agg.byBash, c.sub, (o) => { o.cr += t; o.cost += cost; o.tokens += c.tokens; o.n++; });
      if (c.cat === 'tool:Read') bump(agg.byRead, c.sub, (o) => { o.cr += t; o.cost += cost; o.tokens += c.tokens; o.n++; });
      if (c.cat.startsWith('hook')) bump(agg.byHook, c.sub, (o) => { o.cr += t; o.cost += cost; o.tokens += c.tokens; o.n++; });
    }
    if (segCalls > 0) {
      const t = segBaseline * segCalls;
      const cost = (t * segment.crPrice) / 1e6 || 0;
      bump(agg.byCat, segBaselineCat, (o) => { o.cr += t; o.cost += cost; o.tokens += segBaseline; o.n++; });
    }
    segment = [];
    segCalls = 0;
  };

  const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const ts = j.timestamp ? Date.parse(j.timestamp) : null;
    if (j.cwd) cwd = j.cwd.replace(/\/\.claude\/worktrees\/[^/]+$/, '');
    if (j.type === 'custom-title') title = scrub(j.customTitle);
    if (j.type === 'agent-name' && !title) title = scrub(j.agentName);
    if (j.type === 'bridge-session') isJob = true;
    if (j.type === 'system' && j.subtype === 'compact_boundary') {
      flushSegment();
      prevCtx = null;
      segBaselineCat = 'post-compact carry (summary+preserved)';
      pending = [];
      asstPending = [];
      asstVis = asstTh = 0;
      continue;
    }
    if (ts && (ts < SINCE || ts >= UNTIL)) continue;

    if (j.type === 'assistant' && j.message?.usage) {
      const m = j.message;
      const id = `${m.id}:${j.requestId}`;
      if (!seen.has(id) && m.model !== '<synthetic>') {
        seen.add(id);
        const u = m.usage;
        const cr = u.cache_read_input_tokens || 0;
        const cw = u.cache_creation_input_tokens || 0;
        const cw1h = u.cache_creation?.ephemeral_1h_input_tokens ?? cw;
        const cw5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
        const inp = u.input_tokens || 0;
        const out = u.output_tokens || 0;
        const th = u.output_tokens_details?.thinking_tokens || 0;
        const pr = price(m.model);
        const cost = (inp * pr.in + out * pr.out + cr * pr.cr + cw1h * pr.cw1h + cw5m * pr.cw5m) / 1e6;
        const ctx = inp + cr + cw;
        model = m.model;
        segment.crPrice = pr.cr;

        agg.calls++; agg.cost += cost; agg.in += inp; agg.out += out; agg.cr += cr; agg.cw += cw;
        agg.thinking += th;
        const origin = isSub ? `sub:${agentType}` : 'main';
        bump(agg.byOrigin, origin, (o) => { o.calls++; o.cr += cr; o.cw += cw; o.out += out; o.cost += cost; });
        bump(agg.byProject, project, (o) => { o.calls++; o.cr += cr; o.cw += cw; o.out += out; o.cost += cost; });
        bump(agg.byModel, m.model, (o) => { o.calls++; o.cr += cr; o.cw += cw; o.out += out; o.cost += cost; });
        const bucket = ctx < 50e3 ? 'a <50k' : ctx < 100e3 ? 'b 50-100k' : ctx < 200e3 ? 'c 100-200k' : ctx < 300e3 ? 'd 200-300k' : ctx < 500e3 ? 'e 300-500k' : 'f 500k+';
        bump(agg.byBucket, bucket, (o) => { o.calls++; o.cr += cr; o.cw += cw; o.cost += cost; });

        // Cache rebuild: most of an already-large context re-written, not appended
        if (prevCtx != null && ctx > 30e3 && cw > 0.5 * ctx) {
          rebuilds++;
          agg.cwRebuild += cw; agg.cwRebuildCalls++;
          const gap = prevTs && ts ? (ts - prevTs) / 60e3 : null;
          const rebuildCost = ((cw - Math.max(0, ctx - prevCtx)) * (pr.cw1h - pr.cr)) / 1e6;
          agg.cwRebuildCost += rebuildCost;
          const reason = gap == null ? '?' : gap > 60 ? 'idle >1h (TTL expired)' : gap > 5 ? 'idle 5-60m' : 'no idle (prefix changed)';
          bump(agg, 'rebuild:' + reason, (o) => { o.calls++; o.cw += cw; o.cost += rebuildCost; });
        }

        if (prevCtx == null || ctx < prevCtx * 0.7) {
          // start of a segment (session start, compaction, or context reset)
          if (prevCtx != null) flushSegment();
          segBaseline = ctx;
          if (prevCtx == null && segBaselineCat === 'startup overhead') {
            if (isSub) (agg.agentBaselines[agentType] ??= []).push(ctx);
            else agg.baselines.push(ctx);
          }
        } else {
          // Previous call's output (thinking included - measured: it stays in context)
          // enters with exact token counts; the rest of the growth is split by characters.
          const delta = Math.max(0, ctx - prevCtx);
          const asstTotal = asstVis + asstTh;
          const scale = asstTotal > 0 ? Math.min(1, delta / asstTotal) : 0;
          const rem = Math.max(0, delta - asstTotal);
          const visChars = asstPending.reduce((s, c) => s + c.chars, 0);
          if (asstVis > 0) {
            if (visChars > 0) for (const c of asstPending) segment.push({ ...c, tokens: (asstVis * scale * c.chars) / visChars, atCall: segCalls });
            else segment.push({ cat: 'assistant:text', tokens: asstVis * scale, atCall: segCalls });
          }
          if (asstTh > 0) segment.push({ cat: 'assistant:thinking', tokens: asstTh * scale, atCall: segCalls });
          const oChars = pending.reduce((s, c) => s + c.chars, 0);
          if (rem > 0) {
            if (oChars > 0) for (const c of pending) segment.push({ ...c, tokens: (rem * c.chars) / oChars, atCall: segCalls });
            else segment.push({ cat: 'unattributed (reminders w/o transcript line)', tokens: rem, atCall: segCalls });
          }
        }
        pending = [];
        asstPending = [];
        asstVis = out - th;
        asstTh = th;
        segCalls++;
        prevCtx = ctx;
        prevTs = ts;
        sessionCalls++; sessionCost += cost; peak = Math.max(peak, ctx); ctxSum += ctx;
        sessCr += cr; sessCw += cw; sessOut += out;
        firstTs ??= ts; lastTs = ts;
      }
      for (const b of m.content || []) {
        if (b.type === 'tool_use') {
          const key = toolKey(b.name);
          let sub = '';
          if (b.name === 'Bash') sub = bashKey(b.input?.command);
          else if (b.name === 'Read') sub = readKey(b.input?.file_path, cwd);
          else if (b.name === 'Agent' || b.name === 'Task') sub = b.input?.subagent_type || 'general';
          toolNames.set(b.id, { key, sub });
          asstPending.push({ cat: `assistant:tool_use input`, sub: b.name, chars: len(b.input) });
        } else if (b.type === 'text') asstPending.push({ cat: 'assistant:text', chars: len(b.text) });
      }
      continue;
    }

    if (j.type === 'user' && j.message) {
      const c = j.message.content;
      if (typeof c === 'string') {
        const cat = j.isCompactSummary ? 'compact summary' : j.isMeta ? 'user:meta (skill body, command)' : 'user:prompt';
        pending.push({ cat, chars: c.length });
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'tool_result') {
            const t = toolNames.get(b.tool_use_id) || { key: 'tool:?', sub: '' };
            let chars = 0;
            if (typeof b.content === 'string') chars = b.content.length;
            else for (const x of b.content || []) chars += x.type === 'image' ? 6000 : len(x.text);
            pending.push({ cat: t.key === 'tool:Agent' || t.key === 'tool:Task' ? 'tool:Agent (report)' : t.key, sub: t.sub, chars });
          } else if (b.type === 'text') {
            const cat = j.isCompactSummary ? 'compact summary' : j.isMeta ? 'user:meta (skill body, command)' : 'user:prompt';
            pending.push({ cat, chars: len(b.text) });
          } else if (b.type === 'image') pending.push({ cat: 'user:image', chars: 6000 });
        }
      }
      continue;
    }

    if (j.type === 'attachment' && j.attachment) {
      const a = j.attachment;
      if (a.type === 'hook_success' || a.type === 'hook_additional_context' || a.type === 'hook_blocking_error' || a.type === 'hook_error_during_execution') {
        const text = a.type === 'hook_additional_context' ? len(a.content) : len(a.content);
        if (text > 0) pending.push({ cat: 'hook output', sub: `${a.hookName || a.hookEvent}`, chars: text });
      } else if (a.type === 'hook_cancelled' || a.type === 'prompt_snapshot' || a.type === 'deferred_tools_record') {
        // bookkeeping, not sent to the model
      } else {
        const text = len(a.content) || len(a.prompt) || len(a.text) || Math.max(0, len(a) - 200);
        pending.push({ cat: `attach:${a.type}`, chars: text });
      }
    }
  }
  flushSegment();

  if (sessionCalls > 0) {
    agg.sessions.push({
      file: path.basename(p).replace('.jsonl', ''), title, agentType, isJob, model, size,
      calls: sessionCalls, cost: sessionCost, peak, avgCtx: ctxSum / sessionCalls,
      cr: sessCr, cw: sessCw, out: sessOut, rebuilds,
      hours: firstTs && lastTs ? (lastTs - firstTs) / 3600e3 : 0,
    });
  }
}

const files = listFiles();
const totalMb = files.reduce((s, f) => s + f.size, 0) / 1e6;
process.stderr.write(`${files.length} files, ${totalMb.toFixed(0)} MB\n`);
let done = 0;
for (const f of files) {
  await processFile(f);
  if (++done % 100 === 0) process.stderr.write(`  ${done}/${files.length}\n`);
}

// ---------- report ----------
const M = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(Math.round(n)));
const $ = (n) => '$' + n.toFixed(0);
const pct = (a, b) => ((100 * a) / b).toFixed(1) + '%';
const table = (title, obj, cols, sortBy = 'cost', limit = TOP) => {
  console.log(`\n## ${title}`);
  const rows = Object.entries(obj).sort((a, b) => b[1][sortBy] - a[1][sortBy]).slice(0, limit);
  for (const [k, v] of rows) console.log('  ' + k.padEnd(44) + cols.map((c) => c(v)).join('  '));
};

const pr = price('opus');
console.log(`# Tokens ${args.since || ''}..${args.until || 'now'}  (${files.length} transcripts, ${totalMb.toFixed(0)} MB)`);
console.log(`calls ${agg.calls}  cost≈${$(agg.cost)}  cacheRead ${M(agg.cr)} (${$(agg.cr * pr.cr / 1e6)} opus-eq)  cacheWrite ${M(agg.cw)}  out ${M(agg.out)} (thinking ${M(agg.thinking)})  in ${M(agg.in)}`);
console.log(`cache rebuilds: ${agg.cwRebuildCalls} calls, ${M(agg.cwRebuild)} tokens, ≈${$(agg.cwRebuildCost)}`);
for (const k of Object.keys(agg).filter((k) => k.startsWith('rebuild:'))) {
  console.log(`  ${k.padEnd(40)} calls ${agg[k].calls}  cw ${M(agg[k].cw)}  ≈${$(agg[k].cost)}`);
}

const cCost = (v) => `≈${$(v.cost).padStart(7)} ${pct(v.cost, agg.cost).padStart(6)}`;
table('By origin (main session vs subagent type)', agg.byOrigin, [(v) => `calls ${String(v.calls).padStart(6)}`, cCost, (v) => `cr ${M(v.cr).padStart(6)}`, (v) => `out ${M(v.out).padStart(6)}`], 'cost', 30);
table('By project', agg.byProject, [(v) => `calls ${String(v.calls).padStart(6)}`, cCost, (v) => `cr ${M(v.cr).padStart(6)}`]);
table('By model', agg.byModel, [(v) => `calls ${String(v.calls).padStart(6)}`, cCost]);
table('By context size at the call', agg.byBucket, [(v) => `calls ${String(v.calls).padStart(6)}`, cCost, (v) => `cr ${M(v.cr).padStart(6)}`], 'cr');
Object.entries(agg.byBucket).sort();

const attribTotal = Object.values(agg.byCat).reduce((s, v) => s + v.cost, 0);
const attrCols = [(v) => `re-read ${M(v.cr).padStart(7)}`, (v) => `≈${$(v.cost).padStart(6)} ${pct(v.cost, attribTotal).padStart(6)}`, (v) => `added ${M(v.tokens).padStart(6)} in ${String(v.n).padStart(5)} chunks`];
table('What the re-read context consists of (cache-read cost by content class)', agg.byCat, attrCols, 'cost', 30);
table('  Bash results by command', agg.byBash, attrCols);
table('  Read results by location', agg.byRead, attrCols);
table('  Hook output by hook', agg.byHook, attrCols);

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 0; };
console.log(`\n## Startup overhead (context on the first call)`);
console.log(`  main sessions: median ${M(med(agg.baselines))}, n=${agg.baselines.length}`);
for (const [k, v] of Object.entries(agg.agentBaselines).sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
  console.log(`  sub:${k.padEnd(30)} median ${M(med(v))}, n=${v.length}`);
}

console.log(`\n## Top sessions by cost`);
for (const s of agg.sessions.filter((s) => s.agentType === 'main').sort((a, b) => b.cost - a.cost).slice(0, TOP)) {
  console.log(`  ${s.file.slice(0, 8)} ${(s.title || '').slice(0, 26).padEnd(26)} ${$(s.cost).padStart(6)}  calls ${String(s.calls).padStart(5)}  avgCtx ${M(s.avgCtx).padStart(5)}  peak ${M(s.peak).padStart(5)}  rebuilds ${s.rebuilds}  ${s.hours.toFixed(1)}h  ${s.model}`);
}
console.log(`\n## Top subagent runs by cost`);
for (const s of agg.sessions.filter((s) => s.agentType !== 'main').sort((a, b) => b.cost - a.cost).slice(0, TOP)) {
  console.log(`  ${s.agentType.padEnd(24)} ${$(s.cost).padStart(5)}  calls ${String(s.calls).padStart(4)}  avgCtx ${M(s.avgCtx).padStart(5)}  peak ${M(s.peak).padStart(5)}  ${s.model}`);
}
const main = agg.sessions.filter((s) => s.agentType === 'main');
const ctxHist = [0, 100e3, 200e3, 300e3, 500e3, 1e9];
console.log(`\n## Main-session distribution: ${main.length} sessions`);
for (let i = 0; i < ctxHist.length - 1; i++) {
  const g = main.filter((s) => s.avgCtx >= ctxHist[i] && s.avgCtx < ctxHist[i + 1]);
  console.log(`  avgCtx ${M(ctxHist[i])}-${M(ctxHist[i + 1])}: ${g.length} sessions, ≈${$(g.reduce((a, s) => a + s.cost, 0))}`);
}
if (args.json) fs.writeFileSync(args.json, JSON.stringify(agg, null, 1));
