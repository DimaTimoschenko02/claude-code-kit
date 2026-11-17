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
//   ... [--pairs 1200]   attach the agent's reply that preceded each user turn
//   node extract.mjs --facts --sessions <f.jsonl> [--after-uuid U] [--result-cap 4096] [--max-kb 160] [--out f]
//         harvest slice (facts.mjs): full assistant text, user turns, successful Bash/Read/Grep output,
//         subagent transcripts + Agent reports. The audit modes above are unchanged.
//
// --pairs: a user turn is a reaction to something. Without the reply it answers,
// a lens like "the answer was better but still not what I wanted" or "I write X
// and the user never reacts to it" has nothing to read. Kept off by default —
// it roughly triples the slice — and stores head + tail of the reply, since the
// first line is the verdict and the tail is what the user actually reacts to.
import fs from 'node:fs';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { scrub, scrubHead, scrubTail } from './scrub.mjs';
import { codexTitles, listSessions } from './discover.mjs';
import { claudeFactsCollector, claudeLaunch, codexLaunch } from './origin.mjs';
import { extractFacts } from './facts.mjs';

// A user turn that LOOKS like the user pushing back on what the agent just did.
// These are the highest-signal lines in any transcript — but this regex is a HINT, not a
// count: measured recall 36 of 83 hand-labelled correctionHints (43%, 2026-09-06). Hence the
// field is `correctionHints`; the real count comes from an agent reading `--pairs`.
// JS `\b` is ASCII-only: `опять\b` never matched «опять» (2026-10-02) — a Cyrillic word ends with END.
const END = '(?![\\p{L}\\p{N}])';
const CORRECTION = new RegExp(
  [
    'я (?:же )?(?:говорил|сказал|просил)', 'не (?:то|так|это)' + END, 'имел ввиду', 'мав на увазі',
    'опять' + END, 'знову' + END, 'снова то же', 'зачем ты', 'нахуя', 'какого хуя', 'че за',
    'стоп' + END, 'стій' + END, 'погоди', 'подожди', 'отставить', 'не нужно было', 'не надо было',
    'ты (?:не|же не)\\s', 'ошиб(?:ка|ся|аешься)', 'неверно', 'неправильно', 'невірно',
    'перечитай', 'ещё раз', 'еще раз', 'я тебя перебью',
    "that's not", 'not what i', 'i said', 'wrong\\b', 'no,? i meant', 'stop\\b', 'undo\\b',
  ].join('|'),
  'iu',
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
  const { maxTurnChars = 1200, pairChars = 0 } = opts;
  const raw = fs.readFileSync(file, 'utf8');
  const session = path.basename(file, '.jsonl');

  const out = {
    session, file,
    title: null, branch: null, cwd: null, version: null, models: new Set(),
    started: null, ended: null,
    userTurns: [], correctionHints: [], interruptions: 0, compactions: 0,
    toolCounts: new Map(), bashShapes: new Map(), bashHeads: new Map(),
    errors: [], skills: new Map(), skillCalls: [], agents: [], agentTypes: new Map(),
    hooks: new Map(), hookErrors: [], filesTouched: new Map(),
    longTurns: [], turnCount: 0, sidechainTurns: 0, agentPrompts: [],
  };
  // An agent-launched session opens with the agent's brief in the user role; a headless run is all the agent's.
  // Those prompts go to agentPrompts, never to userTurns or correctionHints (lib/origin.mjs).
  const launchFacts = claudeFactsCollector();
  let opened = false;

  const toolUseById = new Map(); // tool_use_id -> {name, brief}
  // Text the agent wrote since the last real user turn (main thread only).
  let replyBuf = [];
  let replyTs = null;
  const takeReply = () => {
    if (!pairChars || !replyBuf.length) return null;
    const full = replyBuf.join('\n').trim();
    replyBuf = [];
    if (!full) return null;
    const half = Math.floor(pairChars / 2);
    // Scrubbed before the split: a token across the middle would leave half of itself in each part.
    const whole = full.length > pairChars ? null : scrub(full);
    const head = whole === null ? scrubHead(full, half) : whole.slice(0, half);
    const tail = whole === null ? scrubTail(full, half) : whole.slice(half);
    return { ts: replyTs, chars: full.length, head, tail,
             truncated: full.length > pairChars };
  };

  for (const line of raw.split('\n')) {
    if (!line || line.length < 20) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    launchFacts.take(o);

    if (o.timestamp) { if (!out.started) out.started = o.timestamp; out.ended = o.timestamp; }
    if (o.cwd && !out.cwd) out.cwd = o.cwd;
    if (o.gitBranch && !out.branch) out.branch = o.gitBranch;
    if (o.version && !out.version) out.version = o.version;
    if (o.type === 'ai-title' && o.aiTitle) out.title = o.aiTitle;
    if (o.attributionSkill) bump(out.skills, o.attributionSkill);

    if (o.type === 'system') {
      if (o.subtype === 'stop_hook_summary') {
        for (const h of o.hookInfos || []) bump(out.hooks, (h.command || '').split('/').pop());
        for (const e of o.hookErrors || []) out.hookErrors.push(scrubHead(String(e), 300));
      }
      if (o.subtype === 'turn_duration' && o.durationMs > 180000) {
        out.longTurns.push({ ts: o.timestamp, durationMs: o.durationMs, messages: o.messageCount });
      }
      continue;
    }

    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      if (o.message.model) out.models.add(o.message.model);
      if (pairChars && !o.isSidechain) {
        const txt = textOf(o.message);
        if (txt) { replyBuf.push(txt); replyTs = o.timestamp; }
      }
      for (const b of o.message.content) {
        if (b.type !== 'tool_use') continue;
        bump(out.toolCounts, b.name);
        const inp = b.input || {};
        let brief = '';
        if (b.name === 'Bash' && typeof inp.command === 'string') {
          const cmd = inp.command;
          bump(out.bashShapes, normalizeCmd(cmd));
          bump(out.bashHeads, cmd.trim().split(/\s+/)[0].replace(/^.*\//, ''));
          brief = scrubHead(cmd, 200);
        } else if (['Write', 'Edit', 'NotebookEdit'].includes(b.name) && inp.file_path) {
          bump(out.filesTouched, String(inp.file_path));
          brief = String(inp.file_path);
        } else if (b.name === 'Agent' || b.name === 'Task') {
          bump(out.agentTypes, inp.subagent_type || 'default');
          out.agents.push({ ts: o.timestamp, type: inp.subagent_type || 'default',
                            description: scrubHead(String(inp.description || ''), 160),
                            sidechain: !!o.isSidechain });
          brief = String(inp.description || '');
        } else if (b.name === 'Skill') {
          out.skillCalls.push({ ts: o.timestamp, skill: inp.skill, args: scrubHead(String(inp.args || ''), 120) });
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
                        error: scrubHead(tur.stderr.trim(), 300) });
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
                          error: scrubHead(body.trim(), 300) });
      }
    }

    const t = textOf(o.message);
    if (!t) continue;
    if (t.startsWith('[Request interrupted')) { out.interruptions++; continue; }
    if (/^This session is being continued/.test(t)) { out.compactions++; continue; }
    if (NOISE_PREFIX.test(t)) continue;
    if (t.includes('<system-reminder>') && t.length > 4000) continue;

    const entry = { ts: o.timestamp, uuid: o.uuid, text: scrubHead(t, maxTurnChars),
                    truncated: t.length > maxTurnChars, chars: t.length };
    const prev = takeReply();
    if (prev) entry.prevReply = prev;
    const launch = claudeLaunch(launchFacts.facts);
    const speaker = launch.by === 'user' ? 'user' : launch.how === 'headless' ? 'agent' : opened ? 'user' : 'brief';
    opened = true;
    if (speaker !== 'user') { out.agentPrompts.push({ ...entry, speaker }); continue; }
    out.turnCount++;
    out.userTurns.push(entry);
    if (CORRECTION.test(t.slice(0, 800))) out.correctionHints.push(entry);
  }

  const top = opts.top || 40;
  const launch = claudeLaunch(launchFacts.facts);
  return {
    session: out.session, file: out.file, source: 'claude', launchedBy: launch.by, launch: launch.how,
    title: out.title, branch: out.branch,
    cwd: out.cwd, cliVersion: out.version, models: [...out.models],
    started: out.started, ended: out.ended,
    metrics: {
      userTurns: out.turnCount, agentPrompts: out.agentPrompts.length, sidechainTurns: out.sidechainTurns,
      correctionHints: out.correctionHints.length, interruptions: out.interruptions,
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
    correctionHints: out.correctionHints,
    userTurns: out.userTurns,
    agentPrompts: out.agentPrompts,
  };
}

// What Codex writes in the user role itself: project instructions, environment, skills.
const CODEX_SYSTEMISH = /^\s*(# AGENTS\.md instructions|<(environment_context|user_instructions|INSTRUCTIONS|skill|turn_aborted)\b)/;

/** The same slice from a Codex rollout (~/.codex/sessions/**\/rollout-*.jsonl): finished items, not raw responses. */
export function extractCodexSession(file, opts = {}) {
  const { maxTurnChars = 1200, pairChars = 0 } = opts;
  let meta = {};
  const out = { started: null, ended: null, models: new Set(), userTurns: [], agentPrompts: [], correctionHints: [],
    interruptions: 0, compactions: 0, toolCounts: new Map(), bashShapes: new Map(), bashHeads: new Map(),
    errors: [], filesTouched: new Map(), agents: [] };
  let reply = [], replyTs = null, opened = false;
  const takeReply = () => {
    if (!pairChars || !reply.length) { reply = []; return null; }
    const full = reply.join('\n').trim(); reply = [];
    const half = Math.floor(pairChars / 2);
    const whole = full.length > pairChars ? null : scrub(full);
    return { ts: replyTs, chars: full.length, head: whole === null ? scrubHead(full, half) : whole.slice(0, half),
             tail: whole === null ? scrubTail(full, half) : whole.slice(half), truncated: full.length > pairChars };
  };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.timestamp) { out.started ??= o.timestamp; out.ended = o.timestamp; }
    const p = o.payload || {};
    if (o.type === 'session_meta') { meta = p; continue; }
    if (o.type === 'turn_context' && p.model) out.models.add(p.model);
    if (o.type !== 'event_msg') continue;
    if (p.type === 'turn_aborted') { out.interruptions++; continue; }
    if (p.type === 'context_compacted') { out.compactions++; continue; }
    if (p.type !== 'item_completed' || !p.item) continue;
    const item = p.item;
    const text = (item.content || []).map((c) => c.text || '').join('\n').trim();
    if (item.type === 'UserMessage') {
      if (!text || CODEX_SYSTEMISH.test(text)) continue;
      const entry = { ts: o.timestamp, uuid: item.id, text: scrubHead(text, maxTurnChars), truncated: text.length > maxTurnChars, chars: text.length };
      const prev = takeReply();
      if (prev) entry.prevReply = prev;
      // a create_thread brief arrives as a tool result, so a spawned thread's first message is the user's
      const launch = codexLaunch(meta);
      const speaker = launch.by === 'user' || opened || launch.how === 'codex-thread' ? 'user' : 'brief';
      opened = true;
      if (speaker !== 'user') { out.agentPrompts.push({ ...entry, speaker }); continue; }
      out.userTurns.push(entry);
      if (CORRECTION.test(text.slice(0, 800))) out.correctionHints.push(entry);
    } else if (item.type === 'AgentMessage') {
      if (pairChars && text) { reply.push(text); replyTs = o.timestamp; }
    } else if (item.type === 'CommandExecution') {
      bump(out.toolCounts, 'Bash');
      const cmd = Array.isArray(item.command) ? item.command.at(-1) : String(item.command || '');
      bump(out.bashShapes, normalizeCmd(cmd));
      bump(out.bashHeads, cmd.trim().split(/\s+/)[0].replace(/^.*\//, ''));
      if (item.exit_code) out.errors.push({ ts: o.timestamp, tool: 'Bash', call: scrubHead(cmd, 200), error: scrubHead(String(item.aggregated_output || '').trim(), 300) });
    } else if (item.type === 'FileChange') {
      bump(out.toolCounts, 'Edit');
      for (const f of Object.keys(item.changes || {})) bump(out.filesTouched, f);
    } else if (item.type && item.type !== 'Reasoning' && item.type !== 'FunctionCallOutput') {
      bump(out.toolCounts, item.type === 'DynamicToolCall' ? (item.tool || item.name || 'DynamicToolCall') : item.type);
    }
  }
  const top = opts.top || 40;
  const launch = codexLaunch(meta);
  const session = meta.id || path.basename(file, '.jsonl');
  const title = codexTitles()[session];
  return {
    session, file, source: 'codex', launchedBy: launch.by, launch: launch.how,
    title: title ? scrub(title) : null, branch: meta.git?.branch || null,
    cwd: meta.cwd || null, cliVersion: meta.cli_version || null, models: [...out.models], started: out.started, ended: out.ended,
    metrics: {
      userTurns: out.userTurns.length, agentPrompts: out.agentPrompts.length, sidechainTurns: 0,
      correctionHints: out.correctionHints.length, interruptions: out.interruptions, compactions: out.compactions,
      errors: out.errors.length, toolCalls: [...out.toolCounts.values()].reduce((a, b) => a + b, 0),
      agentCalls: 0, skillCalls: 0, longTurns: 0, bytes: fs.statSync(file).size,
    },
    tools: topN(out.toolCounts, top), bashHeads: topN(out.bashHeads, top),
    bashRepeats: topN(out.bashShapes, top).filter((r) => r.count >= 3), filesTouched: topN(out.filesTouched, top),
    skillsActive: [], skillCalls: [], agentTypes: [], agents: [], hooks: [], hookErrors: [], longTurns: [],
    errors: out.errors.slice(0, 60), correctionHints: out.correctionHints, userTurns: out.userTurns, agentPrompts: out.agentPrompts,
  };
}

/** Claude transcript or Codex rollout, told apart by the first record. */
export function extractAny(file, opts = {}) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(512);
  const n = fs.readSync(fd, head, 0, 512, 0);
  fs.closeSync(fd);
  return /"type":"session_meta"/.test(head.subarray(0, n).toString('utf8')) ? extractCodexSession(file, opts) : extractSession(file, opts);
}

// ---------------------------------------------------------------------- CLI

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// argv[1] is the path as typed; import.meta.url is resolved through symlinks.
// The skill is installed as a symlink into the kit repo, so a raw string compare
// never matched and every CLI silently did nothing (exit 0, no output).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
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
      codex: !process.argv.includes('--no-codex'),
    }).map((m) => m.file);
  }
  if (!files.length) { console.error('no sessions matched'); process.exit(1); }

  if (process.argv.includes('--facts')) {
    const fopts = { afterUuid: arg('after-uuid'), resultCap: Number(arg('result-cap', 4096)),
                    maxKb: Number(arg('max-kb', 160)) };
    const slices = [];
    for (const f of files) {
      if (/[\\/]rollout-[^\\/]*\.jsonl$/.test(f)) { console.error(`skip ${f}: --facts reads Claude transcripts only`); continue; }
      try { slices.push(extractFacts(f, fopts)); } catch (e) { console.error(`skip ${f}: ${e.message}`); }
    }
    const payload = JSON.stringify({ generated: new Date().toISOString(), mode: 'facts', sessions: slices.length, slices }, null, 1);
    const fout = arg('out');
    if (fout) { fs.writeFileSync(fout, payload); console.error(`wrote ${fout} (${(payload.length / 1024).toFixed(0)} KB)`); }
    else process.stdout.write(payload + '\n');
    process.exit(0);
  }

  const opts = { maxTurnChars: Number(arg('max-turn-chars', 1200)), top: Number(arg('top', 40)),
                 pairChars: Number(arg('pairs', 0)) };
  const slices = [];
  for (const f of files) {
    try { slices.push(extractAny(f, opts)); }
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
      const who = s.launchedBy === 'agent' ? `  [agent·${s.launch}]` : '';
      console.log(`\n=== ${s.source === 'codex' ? 'codex ' : ''}${s.session.slice(0, 8)} ${s.title || '(no title)'}${who}`);
      console.log(`    ${(s.started || '').slice(0, 16)} → ${(s.ended || '').slice(0, 16)}  ${(m.bytes / 1048576).toFixed(1)}M  ${s.branch || ''}`);
      console.log(`    turns=${m.userTurns}${m.agentPrompts ? ` agent-prompts=${m.agentPrompts}` : ''} hints(regex)=${m.correctionHints} interrupts=${m.interruptions} ` +
                  `errors=${m.errors} tools=${m.toolCalls} agents=${m.agentCalls} skills=${m.skillCalls} compacts=${m.compactions}`);
      if (s.bashRepeats.length) console.log(`    repeated bash: ${s.bashRepeats.slice(0, 5).map((r) => `${r.count}× ${r.key.slice(0, 60)}`).join(' | ')}`);
    }
  }
}
