#!/usr/bin/env node
// chat-audit :: subagent transcripts
//
// extract.mjs and analyze.mjs only see the main thread. A `Task`/`Agent` tool
// call there shows a description and a duration — everything the agent
// actually did (tool calls, tool errors, stalls, being interrupted) lives in
// `<session-dir>/subagents/**/*.jsonl` plus the sibling `*.meta.json`, and
// nothing read those before this (2026-09-23 audit: 142 subagent transcripts,
// 140 MB, 17 agent-hours, never looked at — "агенты долго работали, зависали,
// команды ломались" and nobody had checked).
//
// Ported from a throwaway audit script (agents.py) that first proved this
// material was worth reading, and generalized the way the rest of this kit
// is: no path hardcoded, sessions come from discover.mjs.
//
// Usage:
//   node agents.mjs --project <dir> [--days N] [--scope exact|subtree|all] [--json]
//   node agents.mjs --sessions <f1.jsonl,f2.jsonl,...> [--json]
import fs from 'node:fs';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { scrub } from './scrub.mjs';
import { listSessions } from './discover.mjs';

function ts(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t / 1000;
}

function textOf(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

// A failed command's body is "Exit code N" plus whatever it printed — a cat of a note that says "not found" or a hook
// file that says "deny" is not that error. So a command is classed by its exit code and the shell's own error lines,
// and any other tool by the head of its message, where the tool states the error.
export function classifyError(text) {
  const exit = /^Exit code (\d+)/.exec(text);
  if (exit) {
    if (exit[1] === '127' || /command not found/.test(text)) return { cls: 'command not found' };
    if (/^[\w./-]+: .*(?:No such file or directory|cannot access)/m.test(text)) return { cls: 'not found' };
    if (/^(?:\(eval\):\d+: )?no matches found/m.test(text)) return { cls: 'glob no match' };
    return { cls: 'command failed (exit code)' };
  }
  const head = text.slice(0, 400);
  const low = head.toLowerCase();
  if (/^\w+(?::\w+)? hook error/.test(head) || (low.includes('hook') && (low.includes('block') || low.includes('denied') || low.includes('deny')))) {
    const m = /([\w-]+\.(?:sh|py|mjs|js))/.exec(text);
    return { cls: 'hook block', hook: m ? m[1] : 'hook?' };
  }
  if (low.includes('string to replace not found')) return { cls: 'edit mismatch' };
  if (low.includes('unknown skill')) return { cls: 'unknown skill' };
  if (low.includes('classifier gave no verdict')) return { cls: 'auto-mode classifier down' };
  if (low.includes('exceeds maximum allowed tokens')) return { cls: 'read too large' };
  if (low.includes('permission') || low.includes('denied') || low.includes('not allowed')) return { cls: 'permission denied' };
  if (low.includes('timed out') || low.includes('timeout')) return { cls: 'timeout' };
  if (low.includes('no such file') || low.includes('does not exist') || low.includes('not found')) return { cls: 'not found' };
  if (low.includes('must read') || low.includes('has not been read') || low.includes('modified since')) return { cls: 'read-before-edit' };
  return { cls: 'other' };
}

const ownModel = new Map();   // "<dir>|<type>" -> whether that agent definition names its own model

/** Whether the agent type's definition names a model of its own: project .claude/agents from the agent's cwd up, then
 *  ~/.claude/agents. Such an agent runs on that model with nothing passed, so it inherited nothing. */
function typeHasOwnModel(type, cwd) {
  if (!type) return false;
  const name = type.includes(':') ? type.split(':').pop() : type;
  const dirs = [];
  for (let d = cwd ? path.resolve(cwd) : null; d; d = path.dirname(d) === d ? null : path.dirname(d)) dirs.push(path.join(d, '.claude', 'agents'));
  dirs.push(path.join(os.homedir(), '.claude', 'agents'));
  for (const dir of dirs) {
    const key = `${dir}|${name}`;
    if (!ownModel.has(key)) {
      let text = null;
      try { text = fs.readFileSync(path.join(dir, `${name}.md`), 'utf8'); } catch {}
      const front = text && /^---\n([\s\S]*?)\n---/.exec(text);
      const model = front && /^model:\s*["']?([\w.-]+)/m.exec(front[1]);
      ownModel.set(key, text === null ? null : Boolean(model && model[1] !== 'inherit'));
    }
    const v = ownModel.get(key);
    if (v !== null) return v;
  }
  return false;
}

/** The main session's model: the first assistant line that names one (read from the head of the file only). */
function sessionModel(sessionFile) {
  let fd;
  try {
    fd = fs.openSync(sessionFile, 'r');
    const buf = Buffer.alloc(8 * 1024 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line.includes('"assistant"')) continue;
      try { const o = JSON.parse(line); if (o.type === 'assistant' && o.message?.model) return o.message.model; } catch {}
    }
  } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);

/** Recursively collect .jsonl files under a dir (subagent trees can nest — workflows put
 *  their agents one level deeper: `subagents/workflows/<wf-id>/agent-*.jsonl`). */
function walkJsonl(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** One subagent transcript -> its stats. Mirrors agents.py's per-file pass. */
export function extractAgent(file, parentSession, mainModel = null) {
  let meta = {};
  const metaFile = file.replace(/\.jsonl$/, '.meta.json');
  if (fs.existsSync(metaFile)) {
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch {}
  }

  const pend = new Map();          // tool_use_id -> {name, desc, t}
  const errClasses = new Map();    // class -> count (this agent)
  const hookBlocks = new Map();    // hook file -> count (this agent)
  const errExamples = new Map();   // "tool::class" -> example
  const slow = [];                 // {sec, tool, desc}
  const events = [];               // {ts, kind}
  const T = [];
  let calls = 0, errors = 0, maxGap = 0, gapAt = null, prev = null;
  let model = null;
  let cwd = null;

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }

  for (const line of raw.split('\n')) {
    if (!line || line.length < 5) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const t = o.timestamp ? ts(o.timestamp) : null;
    if (t !== null) {
      if (prev !== null && t - prev > maxGap) { maxGap = t - prev; gapAt = o.timestamp; }
      prev = t;
      T.push(t);
    }
    if (!cwd && o.cwd) cwd = o.cwd;
    const m = (o.message && typeof o.message === 'object') ? o.message : {};

    if (o.type === 'assistant') {
      if (!model && m.model) model = m.model;
      for (const x of m.content || []) {
        if (x?.type !== 'tool_use') continue;
        calls++;
        const inp = x.input || {};
        const desc = inp.command || inp.file_path || inp.pattern || '';
        pend.set(x.id, { name: x.name, desc: String(desc).slice(0, 120), t });
      }
    } else if (o.type === 'user') {
      const text = textOf(m);
      if (text.startsWith('[Request interrupted')) events.push({ ts: o.timestamp, kind: 'interrupted' });
      if (/stalled \(watchdog\)/i.test(text)) events.push({ ts: o.timestamp, kind: 'stalled (watchdog)' });

      const c = m.content;
      if (Array.isArray(c)) {
        for (const x of c) {
          if (x?.type !== 'tool_result') continue;
          const src = pend.get(x.tool_use_id) || {};
          if (t !== null && src.t !== null && src.t !== undefined && t - src.t > 120) {
            slow.push({ sec: Math.round(t - src.t), tool: src.name || '?', desc: (src.desc || '').slice(0, 90) });
          }
          if (!x.is_error) continue;
          errors++;
          const bodyRaw = x.content;
          const txt = typeof bodyRaw === 'string' ? bodyRaw : JSON.stringify(bodyRaw ?? '');
          const { cls, hook } = classifyError(txt);
          bump(errClasses, cls);
          if (cls === 'hook block') bump(hookBlocks, hook);
          const key = `${src.name || '?'}::${cls}`;
          if (!errExamples.has(key)) {
            errExamples.set(key, {
              tool: src.name || '?', class: cls, desc: (src.desc || '').slice(0, 100),
              text: scrub(txt.slice(0, 160).replace(/\n/g, ' ')),
            });
          }
        }
      }
    }
  }

  const dur = T.length > 1 ? Math.max(...T) - Math.min(...T) : 0;
  let bytes = 0;
  try { bytes = fs.statSync(file).size; } catch {}

  return {
    parent: parentSession,
    agentId: path.basename(file, '.jsonl'),
    agentType: meta.agentType || meta.subagent_type || null,
    description: scrub(String(meta.description || '').slice(0, 160)),
    // Inherited = nothing chose the model: none passed, none in the type's definition, and it ran on the main one.
    model,
    inherited: !meta.model && !typeHasOwnModel(meta.agentType || meta.subagent_type, cwd) &&
      (mainModel === null || model === null || model === mainModel),
    durationSec: Math.round(dur), calls, errors,
    maxGapSec: Math.round(maxGap), gapAt,
    errClasses: Object.fromEntries(errClasses),
    hookBlocks: Object.fromEntries(hookBlocks),
    errExamples: Object.fromEntries(errExamples),
    slow, events, bytes,
  };
}

/** Every subagent transcript under one main session's directory. */
function agentsUnderSession(sessionFile) {
  const dir = sessionFile.replace(/\.jsonl$/, '');
  const subagentsDir = path.join(dir, 'subagents');
  if (!fs.existsSync(subagentsDir)) return [];
  const parent = path.basename(sessionFile, '.jsonl').slice(0, 8);
  const mainModel = sessionModel(sessionFile);
  return walkJsonl(subagentsDir).map((f) => extractAgent(f, parent, mainModel)).filter(Boolean);
}

export function collectAgents({ project, days = null, scope = 'subtree', sessionFiles = null } = {}) {
  const files = sessionFiles && sessionFiles.length
    ? sessionFiles
    : listSessions(project, { scope, days }).map((m) => m.file);

  const rows = [];
  for (const f of files) rows.push(...agentsUnderSession(f));

  const totals = {
    agents: rows.length,
    agentHours: rows.reduce((a, r) => a + r.durationSec, 0) / 3600,
    toolCalls: rows.reduce((a, r) => a + r.calls, 0),
    toolErrors: rows.reduce((a, r) => a + r.errors, 0),
    errClasses: new Map(),
    hookBlocks: new Map(),
    inheritedModel: rows.filter((r) => r.inherited).length,
    slowCalls: rows.reduce((a, r) => a + r.slow.length, 0),
    stalls: rows.reduce((a, r) => a + r.events.filter((e) => e.kind === 'stalled (watchdog)').length, 0),
    interruptions: rows.reduce((a, r) => a + r.events.filter((e) => e.kind === 'interrupted').length, 0),
  };
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.errClasses)) bump(totals.errClasses, k, v);
    for (const [k, v] of Object.entries(r.hookBlocks)) bump(totals.hookBlocks, k, v);
  }
  totals.errorRate = totals.toolCalls ? totals.toolErrors / totals.toolCalls : 0;

  return {
    sessionsScanned: files.length,
    agents: rows,
    totals: {
      ...totals,
      errClasses: Object.fromEntries([...totals.errClasses].sort((a, b) => b[1] - a[1])),
      hookBlocks: Object.fromEntries([...totals.hookBlocks].sort((a, b) => b[1] - a[1])),
    },
  };
}

// ---------------------------------------------------------------------- CLI

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function printReport(res) {
  const t = res.totals;
  console.log(`agents ${t.agents} | sessions scanned ${res.sessionsScanned} | agent-hours ${t.agentHours.toFixed(1)} | ` +
    `tool calls ${t.toolCalls} | tool errors ${t.toolErrors} (${(t.errorRate * 100).toFixed(1)}%)`);
  console.log(`inherited main-session model (no explicit model): ${t.inheritedModel}/${t.agents} | ` +
    `slow tool calls >2min: ${t.slowCalls} | watchdog stalls: ${t.stalls} | interruptions: ${t.interruptions}`);

  console.log('\nTOP by duration:');
  for (const r of [...res.agents].sort((a, b) => b.durationSec - a.durationSec).slice(0, 10)) {
    console.log(`  ${Math.round(r.durationSec / 60)}m calls=${r.calls} err=${r.errors} maxgap=${(r.maxGapSec / 60).toFixed(1)}m ` +
      `${r.parent} ${r.agentType || '?'} ${r.description} [${r.model || '?'}${r.inherited ? ' inherited' : ''}]`);
  }

  console.log('\nerror classes:');
  for (const [k, v] of Object.entries(t.errClasses)) console.log(`  ${v}  ${k}`);

  if (Object.keys(t.hookBlocks).length) {
    console.log('\nhook blocks by hook:');
    for (const [k, v] of Object.entries(t.hookBlocks)) console.log(`  ${v}  ${k}`);
  }

  const gaps = res.agents.filter((r) => r.maxGapSec > 300);
  console.log(`\nagents with a >5min silent gap: ${gaps.length}`);
  for (const r of gaps.sort((a, b) => b.maxGapSec - a.maxGapSec).slice(0, 8)) {
    console.log(`  ${(r.maxGapSec / 60).toFixed(1)}min  ${r.parent}  ${r.description}  @ ${r.gapAt}`);
  }

  const slow = res.agents.flatMap((r) => r.slow.map((s) => ({ ...s, parent: r.parent })));
  console.log(`\nslow tool calls >2min: ${slow.length}`);
  for (const s of slow.sort((a, b) => b.sec - a.sec).slice(0, 12)) {
    console.log(`  ${s.sec}s  ${s.parent}  ${s.tool}  ${s.desc}`);
  }

  if (t.stalls) {
    console.log('\nwatchdog stalls:');
    for (const r of res.agents) for (const e of r.events) if (e.kind === 'stalled (watchdog)') console.log(`  ${r.parent}  ${r.description}  @ ${e.ts}`);
  }
  if (t.interruptions) {
    console.log('\ninterruptions:');
    for (const r of res.agents) for (const e of r.events) if (e.kind === 'interrupted') console.log(`  ${r.parent}  ${r.description}  @ ${e.ts}`);
  }
}

// argv[1] is the path as typed; import.meta.url is resolved through symlinks.
// The skill is installed as a symlink into the kit repo, so a raw string compare
// never matched and every CLI silently did nothing (exit 0, no output).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const sessionsArg = arg('sessions');
  const project = path.resolve(arg('project', process.cwd()));
  const res = collectAgents({
    project,
    days: arg('days') ? Number(arg('days')) : null,
    scope: arg('scope', 'subtree'),
    sessionFiles: sessionsArg ? sessionsArg.split(',').map((s) => s.trim()).filter(Boolean) : null,
  });
  if (process.argv.includes('--json')) console.log(JSON.stringify(res, null, 2));
  else printReport(res);
}
