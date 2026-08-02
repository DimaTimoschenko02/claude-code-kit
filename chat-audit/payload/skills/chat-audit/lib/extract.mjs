#!/usr/bin/env node
// chat-audit :: extraction
//
// Turns raw transcripts into a small, structured slice. Deterministic on
// purpose: reading gigabytes of JSONL with a model is the expensive, lossy way
// to learn things a parser can count exactly. Agents read this output, never
// the raw files.
//
// Everything emitted passes through scrub.mjs — reports get committed.
//
// Usage:
//   node extract.mjs --sessions <f1.jsonl,f2.jsonl>   [--out slice.json]
//   node extract.mjs --project <dir> [--days N] [--limit N]
//   ... [--max-turn-chars 1200] [--top 40] [--summary]
import fs from 'node:fs';
import path from 'node:path';
import { scrub } from './scrub.mjs';
import { listSessions } from './discover.mjs';

// A user turn that looks like the user pushing back on what the agent just did.
// These are the highest-signal lines in any transcript: each one marks a place
// the agent's default behaviour was wrong.
const CORRECTION = new RegExp(
  [
    'я (?:же )?(?:говорил|сказал|просил)', 'не (?:то|так|это)\\b', 'имел ввиду', 'мав на увазі',
    'опять\\b', 'знову\\b', 'снова то же', 'зачем ты', 'нахуя', 'какого хуя', 'че за',
    'стоп\\b', 'стій\\b', 'погоди', 'подожди', 'отставить', 'не нужно было', 'не надо было',
    'ты (?:не|же не)\\s', 'ошиб(?:ка|ся|аешься)', 'неверно', 'неправильно', 'невірно',
    'перечитай', 'ещё раз', 'еще раз', 'я тебя перебью',
    "that's not", 'not what i', 'i said', 'wrong\\b', 'no,? i meant', 'stop\\b', 'undo\\b',
  ].join('|'),
  'i',
);

const NOISE_PREFIX = /^(?:This session is being continued|Caveat: The messages below|<local-command|<command-name|<system-reminder>|<task-notification>|Review this change for security|You analyze a conversation between|\[Request interrupted)/;

// Same failure vocabulary the frequency analyzer uses — keep them in step.
const FAIL = /(command not found|no such file|permission denied|syntax error|fatal:|error:|traceback \(most recent|cannot |could not |unable to |connection refused|timed out|exit code [1-9]|unauthorized|forbidden|authentication failed|access denied|not recognized|BLOCKED by)/i;

function textOf(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

/** Collapse a shell command to its shape, so repeats group together. */
function normalizeCmd(cmd) {
  return cmd
    .replace(/\s+/g, ' ')
    .replace(/(['"])(?:\\.|(?!\1)[^\\])*\1/g, '"…"')  // string literals
    .replace(/\/[\w./-]{4,}/g, '/PATH')               // paths
    .replace(/\b\d{2,}\b/g, 'N')                      // numbers
    .trim()
    .slice(0, 140);
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const topN = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([k, v]) => ({ key: k, count: v }));

export function extractSession(file, opts = {}) {
  const { maxTurnChars = 1200 } = opts;
  const raw = fs.readFileSync(file, 'utf8');
  const session = path.basename(file, '.jsonl');

  const out = {
    session, file,
    title: null, branch: null, cwd: null, version: null, models: new Set(),
    started: null, ended: null,
    userTurns: [], corrections: [], interruptions: 0, compactions: 0,
    toolCounts: new Map(), bashShapes: new Map(), bashHeads: new Map(),
    errors: [], skills: new Map(), skillCalls: [], agents: [], agentTypes: new Map(),
    hooks: new Map(), hookErrors: [], filesTouched: new Map(),
    longTurns: [], turnCount: 0, sidechainTurns: 0,
  };

  const toolUseById = new Map(); // tool_use_id -> {name, brief}

  for (const line of raw.split('\n')) {
    if (!line || line.length < 20) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }

    if (o.timestamp) { if (!out.started) out.started = o.timestamp; out.ended = o.timestamp; }
    if (o.cwd && !out.cwd) out.cwd = o.cwd;
    if (o.gitBranch && !out.branch) out.branch = o.gitBranch;
    if (o.version && !out.version) out.version = o.version;
    if (o.type === 'ai-title' && o.aiTitle) out.title = o.aiTitle;
    if (o.attributionSkill) bump(out.skills, o.attributionSkill);

    if (o.type === 'system') {
      if (o.subtype === 'stop_hook_summary') {
        for (const h of o.hookInfos || []) bump(out.hooks, (h.command || '').split('/').pop());
        for (const e of o.hookErrors || []) out.hookErrors.push(scrub(String(e).slice(0, 300)));
      }
      if (o.subtype === 'turn_duration' && o.durationMs > 180000) {
        out.longTurns.push({ ts: o.timestamp, durationMs: o.durationMs, messages: o.messageCount });
      }
      continue;
    }

    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      if (o.message.model) out.models.add(o.message.model);
      for (const b of o.message.content) {
        if (b.type !== 'tool_use') continue;
        bump(out.toolCounts, b.name);
        const inp = b.input || {};
        let brief = '';
        if (b.name === 'Bash' && typeof inp.command === 'string') {
          const cmd = inp.command;
          bump(out.bashShapes, normalizeCmd(cmd));
          bump(out.bashHeads, cmd.trim().split(/\s+/)[0].replace(/^.*\//, ''));
          brief = cmd.slice(0, 200);
        } else if (['Write', 'Edit', 'NotebookEdit'].includes(b.name) && inp.file_path) {
          bump(out.filesTouched, String(inp.file_path));
          brief = String(inp.file_path);
        } else if (b.name === 'Agent' || b.name === 'Task') {
          bump(out.agentTypes, inp.subagent_type || 'default');
          out.agents.push({ ts: o.timestamp, type: inp.subagent_type || 'default',
                            description: scrub(String(inp.description || '').slice(0, 160)),
                            sidechain: !!o.isSidechain });
          brief = String(inp.description || '');
        } else if (b.name === 'Skill') {
          out.skillCalls.push({ ts: o.timestamp, skill: inp.skill, args: scrub(String(inp.args || '').slice(0, 120)) });
          brief = String(inp.skill || '');
        }
        toolUseById.set(b.id, { name: b.name, brief: scrub(brief) });
      }
      continue;
    }

    if (o.type !== 'user' || o.isMeta) continue;
    if (o.isSidechain) { out.sidechainTurns++; continue; }

    // Tool failures. `is_error` is almost never set in practice — the real
    // signal is stderr on the top-level toolUseResult, plus error-shaped text
    // in the result body.
    const tur = o.toolUseResult;
    if (tur && typeof tur === 'object' && typeof tur.stderr === 'string' && FAIL.test(tur.stderr)) {
      out.errors.push({ ts: o.timestamp, tool: 'Bash', call: '',
                        error: scrub(tur.stderr.trim().slice(0, 300)) });
    }
    if (Array.isArray(o.message?.content)) {
      for (const b of o.message.content) {
        if (b?.type !== 'tool_result') continue;
        const body = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map((x) => x?.text || '').join(' ') : '';
        const isErr = b.is_error === true || FAIL.test(body.slice(0, 300));
        if (!isErr) continue;
        const src = toolUseById.get(b.tool_use_id) || {};
        out.errors.push({ ts: o.timestamp, tool: src.name || '?', call: src.brief || '',
                          error: scrub(body.trim().slice(0, 300)) });
      }
    }

    const t = textOf(o.message);
    if (!t) continue;
    if (t.startsWith('[Request interrupted')) { out.interruptions++; continue; }
    if (/^This session is being continued/.test(t)) { out.compactions++; continue; }
    if (NOISE_PREFIX.test(t)) continue;
    if (t.includes('<system-reminder>') && t.length > 4000) continue;

    out.turnCount++;
    const entry = { ts: o.timestamp, uuid: o.uuid, text: scrub(t.slice(0, maxTurnChars)),
                    truncated: t.length > maxTurnChars, chars: t.length };
    out.userTurns.push(entry);
    if (CORRECTION.test(t.slice(0, 800))) out.corrections.push(entry);
  }

  const top = opts.top || 40;
  return {
    session: out.session, file: out.file, title: out.title, branch: out.branch,
    cwd: out.cwd, cliVersion: out.version, models: [...out.models],
    started: out.started, ended: out.ended,
    metrics: {
      userTurns: out.turnCount, sidechainTurns: out.sidechainTurns,
      corrections: out.corrections.length, interruptions: out.interruptions,
      compactions: out.compactions, errors: out.errors.length,
      toolCalls: [...out.toolCounts.values()].reduce((a, b) => a + b, 0),
      agentCalls: out.agents.length, skillCalls: out.skillCalls.length,
      longTurns: out.longTurns.length, bytes: fs.statSync(file).size,
    },
    tools: topN(out.toolCounts, top),
    bashHeads: topN(out.bashHeads, top),
    bashRepeats: topN(out.bashShapes, top).filter((r) => r.count >= 3),
    filesTouched: topN(out.filesTouched, top),
    skillsActive: topN(out.skills, top),
    skillCalls: out.skillCalls,
    agentTypes: topN(out.agentTypes, top),
    agents: out.agents.slice(0, 60),
    hooks: topN(out.hooks, top),
    hookErrors: out.hookErrors.slice(0, 20),
    longTurns: out.longTurns.slice(0, 20),
    errors: out.errors.slice(0, 60),
    corrections: out.corrections,
    userTurns: out.userTurns,
  };
}

// ---------------------------------------------------------------------- CLI

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let files = [];
  const list = arg('sessions');
  if (list) {
    files = list.split(',').map((f) => f.trim()).filter(Boolean);
  } else {
    const project = path.resolve(arg('project', process.cwd()));
    files = listSessions(project, {
      scope: arg('scope', 'subtree'),
      days: arg('days') ? Number(arg('days')) : null,
      limit: arg('limit') ? Number(arg('limit')) : null,
    }).map((m) => m.file);
  }
  if (!files.length) { console.error('no sessions matched'); process.exit(1); }

  const opts = { maxTurnChars: Number(arg('max-turn-chars', 1200)), top: Number(arg('top', 40)) };
  const slices = [];
  for (const f of files) {
    try { slices.push(extractSession(f, opts)); }
    catch (e) { console.error(`skip ${f}: ${e.message}`); }
  }

  const out = arg('out');
  const payload = { generated: new Date().toISOString(), sessions: slices.length, slices };
  if (out) {
    fs.writeFileSync(out, JSON.stringify(payload, null, 2));
    const kb = (fs.statSync(out).size / 1024).toFixed(0);
    console.error(`wrote ${out} (${kb} KB, ${slices.length} sessions)`);
  }
  if (process.argv.includes('--summary') || !out) {
    for (const s of slices) {
      const m = s.metrics;
      console.log(`\n=== ${s.session.slice(0, 8)} ${s.title || '(no title)'}`);
      console.log(`    ${(s.started || '').slice(0, 16)} → ${(s.ended || '').slice(0, 16)}  ${(m.bytes / 1048576).toFixed(1)}M  ${s.branch || ''}`);
      console.log(`    turns=${m.userTurns} corrections=${m.corrections} interrupts=${m.interruptions} ` +
                  `errors=${m.errors} tools=${m.toolCalls} agents=${m.agentCalls} skills=${m.skillCalls} compacts=${m.compactions}`);
      if (s.bashRepeats.length) console.log(`    repeated bash: ${s.bashRepeats.slice(0, 5).map((r) => `${r.count}× ${r.key.slice(0, 60)}`).join(' | ')}`);
    }
  }
}
