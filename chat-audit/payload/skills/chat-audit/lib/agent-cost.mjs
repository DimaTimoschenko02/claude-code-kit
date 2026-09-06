#!/usr/bin/env node
// chat-audit :: agent cost
//
// What each subagent type actually costs, in tokens, across sessions. The main
// transcript only records that an agent was spawned; the spend lives in
// <session-dir>/subagents/agent-<id>.jsonl (one message per line, with
// message.usage) and agent-<id>.meta.json (agentType, description). This joins
// them and aggregates by type, with the main thread as the baseline.
//
// Why (2026-09-06): the user started watching token use per task and suspects
// review agents dominate — "two reviewers on a one-line change". Counting is the
// only honest answer; the transcript slice cannot see it.
//
// Usage:
//   node agent-cost.mjs --sessions <f1.jsonl,f2.jsonl> [--json] [--per-session]
import fs from 'node:fs';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ZERO = () => ({ calls: 0, msgs: 0, out: 0, in: 0, cacheCreate: 0, cacheRead: 0, perCall: [] });

function usageOf(file) {
  const u = { msgs: 0, out: 0, in: 0, cacheCreate: 0, cacheRead: 0, models: new Set() };
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { return u; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'assistant' || !o.message?.usage) continue;
    const g = o.message.usage;
    u.msgs++; u.out += g.output_tokens || 0; u.in += g.input_tokens || 0;
    u.cacheCreate += g.cache_creation_input_tokens || 0; u.cacheRead += g.cache_read_input_tokens || 0;
    if (o.message.model) u.models.add(o.message.model);
  }
  return u;
}

export function agentCost(sessionFiles) {
  const byType = new Map();
  const perSession = [];
  for (const f of sessionFiles) {
    const dir = f.replace(/\.jsonl$/, '');
    const main = usageOf(f);
    const s = { session: path.basename(dir).slice(0, 8), main, agents: ZERO(), types: {} };
    const sub = path.join(dir, 'subagents');
    let metas = [];
    try { metas = fs.readdirSync(sub).filter((n) => n.endsWith('.meta.json')); } catch { /* no agents */ }
    for (const m of metas) {
      let meta; try { meta = JSON.parse(fs.readFileSync(path.join(sub, m), 'utf8')); } catch { continue; }
      const type = meta.agentType || 'unknown';
      const u = usageOf(path.join(sub, m.replace('.meta.json', '.jsonl')));
      for (const bucket of [byType.get(type) || byType.set(type, ZERO()).get(type), s.agents]) {
        bucket.calls++; bucket.msgs += u.msgs; bucket.out += u.out; bucket.in += u.in;
        bucket.cacheCreate += u.cacheCreate; bucket.cacheRead += u.cacheRead; bucket.perCall.push(u.out);
      }
      s.types[type] = (s.types[type] || 0) + 1;
    }
    perSession.push(s);
  }
  const median = (a) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const types = [...byType.entries()].map(([type, b]) => ({
    type, calls: b.calls, msgs: b.msgs, out: b.out, cacheCreate: b.cacheCreate, cacheRead: b.cacheRead,
    medianOutPerCall: median(b.perCall), maxOutPerCall: Math.max(0, ...b.perCall),
  })).sort((a, b) => b.out - a.out);
  const tot = (k) => perSession.reduce((a, s) => a + s.agents[k], 0);
  const totMain = (k) => perSession.reduce((a, s) => a + s.main[k], 0);
  return { sessions: perSession.length, types,
           totals: { agents: { calls: tot('calls'), out: tot('out'), cacheCreate: tot('cacheCreate'), cacheRead: tot('cacheRead') },
                     main: { out: totMain('out'), cacheCreate: totMain('cacheCreate'), cacheRead: totMain('cacheRead') } },
           perSession: perSession.map((s) => ({ session: s.session, mainOut: s.main.out, agentCalls: s.agents.calls,
                                                agentOut: s.agents.out, agentCacheRead: s.agents.cacheRead, types: s.types })) };
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n));

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const list = arg('sessions');
  if (!list) { console.error('usage: agent-cost.mjs --sessions a.jsonl,b.jsonl [--json] [--per-session]'); process.exit(1); }
  const r = agentCost(list.split(',').map((x) => x.trim()).filter(Boolean));
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  console.log(`sessions=${r.sessions}  agent calls=${r.totals.agents.calls}`);
  console.log(`output tokens: main=${k(r.totals.main.out)}  agents=${k(r.totals.agents.out)}  (agents ${(100 * r.totals.agents.out / (r.totals.main.out + r.totals.agents.out)).toFixed(0)}%)`);
  console.log(`cache read:    main=${k(r.totals.main.cacheRead)}  agents=${k(r.totals.agents.cacheRead)}`);
  console.log('\ntype                          calls   msgs     out   med/call  max/call  cache_create  cache_read');
  for (const t of r.types) {
    console.log(`${t.type.padEnd(30)}${String(t.calls).padStart(5)}${String(t.msgs).padStart(7)}${k(t.out).padStart(8)}${k(t.medianOutPerCall).padStart(10)}${k(t.maxOutPerCall).padStart(10)}${k(t.cacheCreate).padStart(14)}${k(t.cacheRead).padStart(12)}`);
  }
  if (process.argv.includes('--per-session')) {
    console.log('\nsession   main_out  agents  agent_out  agent_cache_read  types');
    for (const s of r.perSession.sort((a, b) => b.agentOut - a.agentOut)) {
      console.log(`${s.session}  ${k(s.mainOut).padStart(8)}  ${String(s.agentCalls).padStart(6)}  ${k(s.agentOut).padStart(9)}  ${k(s.agentCacheRead).padStart(16)}  ${Object.entries(s.types).map(([t, n]) => `${t}×${n}`).join(' ')}`);
    }
  }
}
