// chat-audit :: facts slice — input for a memory harvester
//
// The audit slice keeps 1200 chars of a user turn and no tool output — enough to count friction, useless
// for recovering knowledge. The harvester needs the opposite: what the agent said in full, what the user said,
// and the SUCCESSFUL outputs that carry facts (a DESCRIBE dump, a working command with its output), plus
// the same from the session's subagents (DESCRIBE/SHOW COLUMNS live there 32:9). Everything is scrubbed.
//
//   extractFacts(file, { afterUuid, resultCap, maxKb })
//   lastAssistantReply(file) — assistant text after the user's last real prompt
import fs from 'node:fs';
import path from 'node:path';
import { scrub, scrubHead } from './scrub.mjs';

// Not the user speaking: harness notices, compaction summaries, slash-command echoes, interrupts.
const NOISE = /^(?:This session is being continued|Caveat: The messages below|<local-command|<command-name|<command-message|<system-reminder>|<task-notification>|<cross-session-message|<agent-message|\[SYSTEM NOTIFICATION|Another Claude session sent a message|Stop hook feedback|\[Request interrupted)/;
const TOOL_FAIL = /^(?:<tool_use_error>|Error:|Exit code [1-9]|Command failed|BLOCKED|PreToolUse:[^\n]*denied|Permission to use)/;
const FACT_TOOLS = new Set(['Bash', 'Read', 'Grep']);
// Commands whose output is bookkeeping, never a reusable fact (git has the history; tests say pass/fail).
// Judged on the first real command after `cd … &&` / env assignments.
const NOISE_CMD = /^(?:git\s+(?:add|commit|push|pull|fetch|status|diff|log|show|restore|reset|stash|checkout|switch|branch|rm|mv|merge|rebase|cherry-pick|worktree|rev-parse|ls-files)|ls|mkdir|rm|mv|cp|chmod|touch|echo|printf|sleep|true|wc|pnpm\s+(?:check|test|vitest|lint|build|typecheck|names|deps|format|install|openapi)|npx\s+vitest|node\s+--test|gh\s+(?:run|pr)\s+(?:watch|view|list|create|merge))\b/;
function isNoiseCmd(cmd) {
  const first = String(cmd).split(/&&|;|\|\|/).map((c) => c.trim().replace(/^(?:[A-Z_]+=\S*\s+)+/, ''))
    .find((c) => c && !/^cd\s/.test(c)) || '';
  return NOISE_CMD.test(first);
}
const AGENT_TOOLS = new Set(['Agent', 'Task']);

function readLines(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.length < 20) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn tail line */ }
  }
  return out;
}

function textOf(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

function resultBody(b) {
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) return b.content.map((x) => (x?.type === 'text' ? x.text : '')).join('\n');
  return '';
}

/** A human prompt from the user (not a tool result, not a notice). */
export function isRealPrompt(o) {
  if (o.type !== 'user' || o.isMeta || o.isSidechain) return false;
  const c = o.message?.content;
  if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) return false;
  const t = textOf(o.message).trim();
  return !!t && !NOISE.test(t);
}

const cap = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…[+${s.length - n} chars]` : s);
// Raw text is cut only after scrubbing: a cut first can halve a token so that no shape matches its head.
const capScrub = (s, n) => (s.length > n ? `${scrubHead(s, n)}\n…[+${s.length - n} chars]` : scrub(s));

// A result too large for the transcript is persisted beside it; the body only says where.
function persistedOutput(body, n) {
  const m = body.match(/Full output saved to: (\S+)/);
  if (!m || !fs.existsSync(m[1])) return null;
  const fd = fs.openSync(m[1], 'r');
  const buf = Buffer.alloc(n);
  const got = fs.readSync(fd, buf, 0, n, 0);
  fs.closeSync(fd);
  return buf.subarray(0, got).toString('utf8');
}

function briefInput(name, inp = {}) {
  if (name === 'Bash') return String(inp.command || '');
  if (name === 'Read') return `${inp.file_path || ''}${inp.offset ? ` @${inp.offset}` : ''}${inp.limit ? `+${inp.limit}` : ''}`;
  if (name === 'Grep') return `${inp.pattern || ''} ${inp.path || ''} ${inp.glob || ''}`.trim();
  return String(inp.description || '');
}

/** Walk one transcript (main or subagent) into chronological items. */
function walk(records, { resultCap, afterUuid, sidechainOk }) {
  const items = [];
  const uses = new Map();
  let started = !afterUuid;
  let lastUuid = null;
  let lastTs = null;
  for (const o of records) {
    if (o.uuid) lastUuid = o.uuid;
    if (o.timestamp) lastTs = o.timestamp;
    if (!started) { if (o.uuid === afterUuid) started = true; continue; }
    if (o.isSidechain && !sidechainOk) continue;
    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      const t = textOf(o.message).trim();
      if (t) items.push({ k: 'assistant', ts: o.timestamp, text: scrub(t) });
      for (const b of o.message.content) {
        if (b?.type !== 'tool_use') continue;
        uses.set(b.id, { name: b.name, input: b.input || {} });
        // A subagent hands its final report back through a tool call, not as text.
        if (b.name === 'SubagentHandback' && typeof b.input?.message === 'string') {
          items.push({ k: 'handback', ts: o.timestamp, text: capScrub(b.input.message, resultCap * 3) });
        }
      }
      continue;
    }
    if (o.type !== 'user' || o.isMeta) continue;
    const c = o.message?.content;
    if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) {
      for (const b of c) {
        if (b?.type !== 'tool_result') continue;
        const u = uses.get(b.tool_use_id);
        if (!u) continue;
        let body = resultBody(b);
        if (b.is_error === true || TOOL_FAIL.test(body.trimStart())) continue;
        if (o.toolUseResult?.interrupted) continue;
        if (AGENT_TOOLS.has(u.name)) {
          if (/^Async agent launched/.test(body)) continue; // the report comes from the subagent transcript
          items.push({ k: 'agent-report', ts: o.timestamp, task: scrub(briefInput(u.name, u.input)),
                       text: capScrub(body.trim(), resultCap * 2) });
          continue;
        }
        if (!FACT_TOOLS.has(u.name)) continue;
        if (u.name === 'Bash' && isNoiseCmd(u.input.command)) continue;
        if (body.includes('<persisted-output>')) body = persistedOutput(body, resultCap) ?? body;
        if (!body.trim()) continue;
        items.push({ k: u.name.toLowerCase(), ts: o.timestamp, input: capScrub(briefInput(u.name, u.input), 2000),
                     output: capScrub(body.trim(), resultCap) });
      }
      continue;
    }
    if (o.isSidechain && !sidechainOk) continue;
    const t = textOf(o.message).trim();
    if (!t || NOISE.test(t)) continue;
    items.push({ k: 'user', ts: o.timestamp, uuid: o.uuid, text: capScrub(t, 8000) });
  }
  return { items, lastUuid, lastTs, started };
}

function meta(records, file) {
  let title = null; let customTitle = null; let cwd = null; let entrypoint = null;
  let first = null; let last = null;
  for (const o of records) {
    if (o.type === 'custom-title' && o.customTitle) customTitle = o.customTitle;
    if (o.type === 'ai-title' && o.aiTitle) title = o.aiTitle;
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!entrypoint && o.entrypoint) entrypoint = o.entrypoint;
    if (o.timestamp) { first ??= o.timestamp; last = o.timestamp; }
  }
  const dir = path.join(path.dirname(file), path.basename(file, '.jsonl'));
  try {
    const ct = JSON.parse(fs.readFileSync(path.join(dir, 'custom-title.json'), 'utf8'));
    if (ct?.customTitle) customTitle = ct.customTitle;
  } catch { /* none */ }
  // The title is model/user text that ends up in section headers — scrubbed like everything else.
  return { session: path.basename(file, '.jsonl'), file, title: scrub(customTitle || title), cwd, entrypoint,
           started: first, ended: last };
}

/** Subagent transcripts of a session: <project-dir>/<sid>/subagents/**\/agent-*.jsonl */
export function subagentFiles(file) {
  const root = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  const out = [];
  const rec = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (/^agent-.*\.jsonl$/.test(e.name)) out.push(p);
    }
  };
  rec(root);
  return out;
}

// Keep the slice inside a budget: shrink Read outputs first (the file is still on disk), then Bash, then prose.
function fit(slice, maxBytes) {
  const size = () => Buffer.byteLength(JSON.stringify(slice));
  // Subagent task/report are fields, not items — expose them as pseudo-items so the same steps shrink them.
  const all = () => [
    ...slice.items, ...slice.subagents.flatMap((s) => s.items),
    ...slice.subagents.map((s) => ({ k: 'sub-report', get text() { return s.report || ''; }, set text(v) { s.report = v; } })),
    ...slice.subagents.map((s) => ({ k: 'sub-task', get text() { return s.task || ''; }, set text(v) { s.task = v; } })),
  ];
  const steps = [
    ['read', 'output', 600], ['grep', 'output', 800], ['sub-task', 'text', 800], ['bash', 'output', 1500],
    ['assistant', 'text', 3000], ['agent-report', 'text', 3000], ['sub-report', 'text', 4000], ['handback', 'text', 3000],
    ['bash', 'input', 600], ['bash', 'output', 600], ['user', 'text', 3000], ['assistant', 'text', 1200],
    ['sub-report', 'text', 2000], ['bash', 'input', 250], ['bash', 'output', 300], ['read', 'output', 200],
    ['user', 'text', 1500], ['assistant', 'text', 600],
  ];
  for (const [k, field, n] of steps) {
    if (size() <= maxBytes) break;
    for (const it of all()) if (it.k === k && it[field]?.length > n) it[field] = cap(it[field], n);
  }
  // Last resort: drop the oldest tool outputs (subagents first, then main), keep all prose.
  const isTool = (i) => ['bash', 'read', 'grep'].includes(i.k);
  for (const arr of [...slice.subagents.map((s) => s.items), slice.items]) {
    while (size() > maxBytes) {
      const i = arr.findIndex(isTool);
      if (i < 0) break;
      arr.splice(i, 1);
      slice.droppedToolItems = (slice.droppedToolItems || 0) + 1;
    }
  }
  // Hard cap: the steps above never touch prose count, so a long session can still come out far over maxKb. Oldest first: subagents' inner items, then main prose except the last KEEP items (the session's final
  // replies), then whole subagents oldest first; whatever is left is capped per field.
  const KEEP = 6;
  let droppedProse = 0;
  let droppedSubagents = 0;
  slice.subagents.sort((a, b) => String(a.started || '').localeCompare(String(b.started || '')));
  for (const s of slice.subagents) while (size() > maxBytes && s.items.length) { s.items.shift(); droppedProse++; }
  while (size() > maxBytes && slice.items.length > KEEP) { slice.items.shift(); droppedProse++; }
  while (size() > maxBytes && slice.subagents.length) { slice.subagents.shift(); droppedSubagents++; }
  for (const n of [2000, 500]) {
    if (size() <= maxBytes) break;
    for (const it of slice.items) for (const f of ['text', 'output', 'input', 'task']) if (it[f]?.length > n) it[f] = cap(it[f], n);
  }
  slice.truncatedToBudget = droppedProse > 0 || droppedSubagents > 0;
  if (droppedProse) slice.droppedProseItems = droppedProse;
  if (droppedSubagents) slice.droppedSubagents = droppedSubagents;
  slice.overBudget = size() > maxBytes;
  return slice;
}

const TASK_ID = /\b(?:PH|KN)-\d+\b/g;

export function extractFacts(file, opts = {}) {
  const { afterUuid = null, resultCap = 4096, maxKb = 160, afterTs = null } = opts;
  const records = readLines(file);
  const m = meta(records, file);
  const main = walk(records, { resultCap, afterUuid, sidechainOk: false });
  // afterUuid not found (compacted away / wrong file) → the whole session, flagged.
  const fromStart = afterUuid && !main.started;
  const w = fromStart ? walk(records, { resultCap, afterUuid: null, sidechainOk: false }) : main;
  const since = afterTs && !fromStart ? afterTs : null;

  const subagents = [];
  for (const f of subagentFiles(file)) {
    const recs = readLines(f);
    const firstTs = recs.find((o) => o.timestamp)?.timestamp;
    if (since && firstTs && firstTs <= since) continue;
    let metaJson = {};
    try { metaJson = JSON.parse(fs.readFileSync(f.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { /* none */ }
    const sw = walk(recs, { resultCap, afterUuid: null, sidechainOk: true });
    const prompt = sw.items.find((i) => i.k === 'user');
    // The final report is the last substantial text; a trailing «Done.» after it is not the report.
    const texts = sw.items.filter((i) => i.k === 'assistant');
    const handback = [...sw.items].reverse().find((i) => i.k === 'handback');
    const report = handback || [...texts].reverse().find((i) => i.text.length >= 200) || texts[texts.length - 1];
    subagents.push({
      agentType: metaJson.agentType || null, description: scrub(String(metaJson.description || '')),
      model: metaJson.model || null, started: firstTs,
      task: prompt ? cap(prompt.text, 2000) : null,
      report: report ? report.text : null,
      items: sw.items.filter((i) => i.k !== 'user' && i !== report),
    });
  }

  const tasks = new Map();
  for (const it of w.items) for (const id of `${it.text || ''} ${it.input || ''}`.match(TASK_ID) || []) {
    tasks.set(id, (tasks.get(id) || 0) + 1);
  }
  const slice = {
    ...m, afterUuid: fromStart ? null : afterUuid, afterUuidMissing: !!fromStart,
    lastUuid: w.lastUuid, lastTs: w.lastTs,
    taskIds: [...tasks.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 12),
    counts: {
      user: w.items.filter((i) => i.k === 'user').length,
      assistant: w.items.filter((i) => i.k === 'assistant').length,
      toolResults: w.items.filter((i) => FACT_TOOLS.has(i.k[0].toUpperCase() + i.k.slice(1))).length,
      subagents: subagents.length,
    },
    items: w.items,
    subagents,
  };
  return fit(slice, maxKb * 1024);
}

/** The assistant text written after the user's last real prompt (main thread). */
export function lastAssistantReply(file) {
  const records = readLines(file);
  let buf = [];
  let ts = null;
  let uuid = null;
  for (const o of records) {
    if (isRealPrompt(o)) { buf = []; ts = null; uuid = null; continue; }
    if (o.type === 'assistant' && !o.isSidechain && Array.isArray(o.message?.content)) {
      const t = textOf(o.message).trim();
      if (t) { buf.push(t); ts = o.timestamp; uuid = o.uuid; }
    }
  }
  return { text: buf.join('\n\n'), ts, uuid, meta: meta(records, file) };
}

export function sessionMeta(file) { return meta(readLines(file), file); }
