#!/usr/bin/env node
// chat-audit :: forks (precedent audit, step 1 — no LLM)
//
// Cuts transcripts into pairs "agent's last reply before the user's turn -> the user's turn" and marks, deterministically,
// which pairs are fork candidates:
//   explicit forks  — the agent offered options / a recommendation / asked via AskUserQuestion / wrote a `**Развилка:**` block
//   implicit forks  — the agent just did it and the user's turn is a correction ("нет", "не так", "верни", swearing at the result)
// Spec: 99 meta/specs/precedent-audit.md. The labelling (what the user chose, did it match the recommendation) is a later,
// model-driven step; this file only finds and anchors the pairs.
//
// Cost design (the tool runs in waves on a laptop with other sessions alive):
//   scope   — folders by project cwd (discover.projectFolders), top-level transcripts only (no subagents, no temp
//             scratchpads), sessions started on/after --since; Codex sessions by cwd. Nothing else is opened.
//   engine  — line stream, a regex gate on the first bytes of a line, JSON.parse only for main-thread user/assistant lines.
//   memory  — one session at a time; pairs are appended to the output per session; the corpus is never held whole.
//
// Scopes are workspace data, so they live in the workspace, not here: a JSON file at --config, or $CHAT_AUDIT_SCOPES,
// or <cwd>/.claude/chat-audit/scopes.json. Shape: { "<name>": { "dir": "~/code/proj", "codexCwd": "code[\\\\/]proj",
// "repos": ["owner/repo"], "cards": "~/notes/proj/tasks" } } — repos/cards are read by statements.mjs only.
//
// Usage:
//   node forks.mjs --scope <name> [--config scopes.json] [--since 2026-10-30] [--out forks.jsonl] [--json-summary]
//        [--examples N]       print N sample fork candidates per class (anchors + short quotes)
//   node forks.mjs --files a.jsonl,b.jsonl [--out ...]     (Claude transcripts, for tests)
//   node forks.mjs --git          git history of the repos under the scope (reverts = outcomes)
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { scrub } from './scrub.mjs';
import { projectFolders } from './discover.mjs';

const HOME = os.homedir();
const expandHome = (p) => (p && p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);

/** One named scope from the workspace config, with `~` expanded and codexCwd compiled. Throws when it is missing. */
export function loadScope(name, configPath = null) {
  const file = configPath || process.env.CHAT_AUDIT_SCOPES || path.join(process.cwd(), '.claude', 'chat-audit', 'scopes.json');
  let all;
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`scopes config not readable: ${file} (${e.code || e.message})`); }
  const s = all[name];
  if (!s || !s.dir) throw new Error(`scope "${name}" not in ${file}; known: ${Object.keys(all).join(', ')}`);
  return { ...s, name, dir: expandHome(s.dir), cards: expandHome(s.cards || null), repos: s.repos || [],
    codexCwd: new RegExp(s.codexCwd || s.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') };
}
let currentConfig = null;   // set by the CLI's --config, read by the scope helpers below
const scopeOf = (name) => (typeof name === 'object' ? name : loadScope(name, currentConfig));
const TEXT_CAP = 1500;            // chars kept per side; head + tail, the tail is where the question is
const CHARS_PER_TOKEN = 3.5;      // mixed RU/EN estimate, not a tokenizer

// ------------------------------------------------------------------ text helpers

const SYS_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const NOISE_PREFIX = /^(?:This session is being continued|Caveat: The messages below|<local-command|<command-name|<task-notification>|\[Request interrupted|Another Claude session sent)/;

function cut(text, cap = TEXT_CAP) {
  const s = scrub(text.trim());
  if (s.length <= cap) return s;
  const head = Math.floor(cap * 0.35);
  return `${s.slice(0, head)}\n[… ${s.length - cap} chars …]\n${s.slice(-(cap - head))}`;
}

function textBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

// ------------------------------------------------------------------ deterministic marks

// Numbered / lettered option lists. A plain numbered list is weak on its own (steps look the same) — the class
// is decided in classify() together with the other marks.
const NUMBERED = /^\s*(?:[-*]\s*)?\**(\d{1,2})[.)]\**\s+\S/;
const LETTERED = /^\s*(?:[-*]\s*)?\**\(?([A-DА-Г])[.)]\**\s+\S/;
const VARIANT_WORD = /(?:вариант|опция|вариантом|option|alternative|подход)[а-яa-z]*\s*(?:№\s*)?[«"(]?([0-9A-Za-zА-Яа-я])\b/gi;
const RECOMMEND = /рекоменду|\(Recommended\)|\bя бы\b|предлагаю|советую|мой выбор|стоит выбрать|I(?:'d| would) (?:go|pick|choose|suggest)|I recommend|I suggest|my pick|my recommendation/i;
const FORK_BLOCK = /\*\*Развилка:?\*\*:?/;
const FORK_REC = /\*\*Рекомендую:?\s*([^*\n]*)\*\*/;

function hasOptions(text) {
  const lines = text.split('\n');
  const nums = [], letters = new Set();
  for (const l of lines) {
    const n = NUMBERED.exec(l); if (n) nums.push(Number(n[1]));
    const a = LETTERED.exec(l); if (a) letters.add(a[1]);
  }
  const numbered = nums.includes(1) && nums.includes(2);
  const lettered = letters.size >= 2 && (letters.has('A') || letters.has('А'));
  const variants = new Set([...text.matchAll(VARIANT_WORD)].map((m) => m[1].toLowerCase()));
  return { numbered, lettered, variantWord: variants.size >= 2 };
}

// The user's turn as a correction. Superset of extract.mjs CORRECTION (whose measured recall was 43%): adds the
// revert/undo family and the bare "нет" opener. A HINT — the model-driven step confirms it.
const END = '(?![\\p{L}\\p{N}])';
const NONWORD = '[^\\p{L}\\p{N}]*';   // \W is ASCII-only: under /u it swallows Cyrillic letters, so "^\W*нет" matched mid-text
const CORRECTION = new RegExp([
  '^' + NONWORD + '(?:нет|ни в коем)' + END, '^' + NONWORD + '(?:не так|не то|не это|не надо|не нужно|не делай|не пиши|не трогай)' + END,
  '^' + NONWORD + '(?:no|nope)' + END,
  'я (?:же )?(?:говорил|сказал|просил)', 'имел ввиду', 'мав на увазі',
  'опять' + END, 'снова то же', 'зачем ты', 'нахуя', 'нахера', 'какого хуя', 'какого хера', 'че за',
  '^' + NONWORD + '(?:стоп|погоди|подожди|отставить)' + END, 'не нужно было', 'не надо было',
  'ты (?:не|же не)\\s', 'ошиб(?:ка|ся|аешься)', 'неверно', 'неправильно', 'перечитай',
  'верни' + END, 'вернуть' + END, 'откат', 'отмени', 'откати', 'удали это', 'убери это', 'сломал',
  'revert' + END, 'undo' + END, 'rollback', "that's not", 'not what i', 'i said', 'wrong' + END, '^' + NONWORD + 'stop' + END,
].join('|'), 'iu');
const CORRECTION_WINDOW = 300;   // the opening of the turn; swearing deep inside a long answer is not a correction
// A Bash call that changes something (the agent "did it itself"); reading commands do not count.
const MUTATING_BASH = /\bgit (?:commit|push|merge|reset|checkout|rebase|apply|add|stash|cherry-pick|revert)\b|\b(?:rm|mv|cp|mkdir|tee) |sed -i|\b(?:npm|pnpm|yarn) (?:i|add|install|run build|publish)\b|\bdocker (?:compose )?(?:up|build|run|rm|stop)\b|\bkubectl (?:apply|delete|rollout|patch)\b|curl[^|]*-X (?:POST|PUT|DELETE|PATCH)|>>?\s*[\w./~"'-]/;

/** Marks of one pair. `acted` = the agent made tool changes in this turn (needed for an implicit fork). */
export function markPair({ agentText, userText, ask, acted }) {
  const tags = [];
  if (ask) tags.push('ask_tool');
  if (agentText) {
    const tail = agentText.slice(-500);
    const o = hasOptions(agentText);
    if (FORK_BLOCK.test(agentText)) tags.push('fork_block');
    if (o.numbered) tags.push('opt_numbered');
    if (o.lettered) tags.push('opt_lettered');
    if (o.variantWord) tags.push('opt_variant_word');
    if (RECOMMEND.test(agentText)) tags.push('rec');
    if (/\?/.test(tail)) tags.push('q_tail');
    if (ask && ask.hasRecommended) tags.push('ask_rec');
  }
  if (userText && CORRECTION.test(userText.slice(0, CORRECTION_WINDOW))) tags.push(acted ? 'correction_after_action' : 'correction');
  return tags;
}

/** explicit forks first (ask_tool > fork_block > explicit > weak), then implicit, else none. */
export function classify(tags) {
  const has = (t) => tags.includes(t);
  const opts = has('opt_numbered') || has('opt_lettered') || has('opt_variant_word');
  if (has('ask_tool')) return 'ask_tool';
  if (has('fork_block')) return 'fork_block';
  if (opts && (has('rec') || has('q_tail') || has('opt_variant_word'))) return 'explicit';
  if (has('rec') && has('q_tail')) return 'explicit';
  if (opts || has('rec')) return 'weak';
  if (has('correction_after_action')) return 'implicit';
  if (has('correction')) return 'correction_no_action';
  return 'none';
}

// ------------------------------------------------------------------ Claude Code

const SKIP_HEAD = /^\{"(?:type":"(?!user"|assistant")|parentUuid":"[^"]*","isSidechain":(?:true|false),"attachment")/;

function formatAsk(input) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  let hasRecommended = false;
  const lines = qs.map((q) => {
    const opts = (q.options || []).map((o, i) => {
      if (/\(Recommended\)/i.test(o.label || '')) hasRecommended = true;
      return `  ${i + 1}. ${o.label}${o.description ? ' — ' + o.description : ''}`;
    });
    return `${q.question}\n${opts.join('\n')}`;
  });
  return { text: lines.join('\n\n'), hasRecommended, questions: qs };
}

function askAnswerText(o, block) {
  const ans = o.toolUseResult && typeof o.toolUseResult === 'object' ? o.toolUseResult.answers : null;
  if (ans && typeof ans === 'object') return Object.entries(ans).map(([q, a]) => `${q} = ${a}`).join('\n');
  const c = block.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text || '').join('\n') : '';
}

function pickedRecommended(ask, answer) {
  if (!ask.hasRecommended) return null;
  const rec = ask.questions.flatMap((q) => q.options || []).filter((o) => /\(Recommended\)/i.test(o.label || ''))
    .map((o) => o.label.replace(/\s*\(Recommended\)/i, '').trim());
  return rec.some((r) => r && answer.includes(r));
}

/** Streams one Claude transcript; returns {pairs, stats}. `seen` dedups resumed-session copies by the user's turn uuid. */
export async function pairsFromClaude(file, { seen = new Set(), project = null, keepOrphans = false } = {}) {
  const session = path.basename(file, '.jsonl');
  const stats = { session, file, bytes: fs.statSync(file).size, started: null, cwd: null,
    humanTurns: 0, queuedTurns: 0, pairsNoAgent: 0, dupTurns: 0, convChars: 0, asks: 0 };
  const pairs = [];
  let segTexts = [];            // text blocks of the agent's current uninterrupted run
  let prevSeg = '';             // last non-empty finished run in this turn
  let lastAgentTs = null;
  let toolCalls = 0, edits = 0;
  const pendingAsk = new Map();

  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length < 40) continue;
    const head = line.slice(0, 400);
    if (SKIP_HEAD.test(head) || head.includes('"isSidechain":true')) continue;
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    if (o.timestamp && !stats.started) stats.started = o.timestamp;
    if (o.cwd && !stats.cwd) stats.cwd = o.cwd;

    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      const t = textBlocks(o.message.content);
      if (t.trim()) { segTexts.push(t); lastAgentTs = o.timestamp; stats.convChars += t.length; }
      for (const b of o.message.content) {
        if (b?.type !== 'tool_use') continue;
        toolCalls++;
        if (b.name === 'Edit' || b.name === 'Write' || b.name === 'NotebookEdit') edits++;
        else if (b.name === 'Bash' && MUTATING_BASH.test(String(b.input?.command || ''))) edits++;
        if (b.name === 'AskUserQuestion') {
          stats.asks++;
          pendingAsk.set(b.id, { ...formatAsk(b.input), ts: o.timestamp, lead: segTexts.join('\n') });
        }
      }
      continue;
    }
    if (o.type !== 'user' || o.isMeta) continue;

    const c = o.message?.content;
    const results = Array.isArray(c) ? c.filter((b) => b?.type === 'tool_result') : [];
    if (results.length) {
      for (const r of results) {
        const ask = pendingAsk.get(r.tool_use_id);
        if (!ask) continue;
        pendingAsk.delete(r.tool_use_id);
        const answer = askAnswerText(o, r);
        const rejected = r.is_error === true;
        const agentText = [ask.lead, ask.text].filter(Boolean).join('\n\n');
        const tags = markPair({ agentText, userText: answer, ask });
        if (rejected) tags.push('ask_rejected');
        else { const rec = pickedRecommended(ask, answer); if (rec === true) tags.push('ask_picked_rec'); else if (rec === false) tags.push('ask_picked_other'); }
        pairs.push(buildPair({ stats, project, o, kind: 'ask', agentText, agentTs: ask.ts, userText: answer, tags, acted: false, toolCalls, edits, uuid: o.uuid }));
      }
      if (segTexts.length) prevSeg = segTexts.join('\n');
      segTexts = [];
      continue;
    }

    // a user record that is not a tool result: the human, or something the harness injected in their name
    const isHuman = o.origin?.kind === 'human';
    const rawText = textBlocks(c);
    const userText = rawText.replace(SYS_REMINDER, '').trim();
    if (segTexts.length) prevSeg = segTexts.join('\n');
    const agentLast = segTexts.length ? segTexts.join('\n') : '';
    segTexts = [];
    if (!isHuman || !userText || NOISE_PREFIX.test(userText)) continue;

    stats.humanTurns++;
    stats.convChars += userText.length;
    const queued = o.promptSource === 'queued';
    if (queued) stats.queuedTurns++;
    if (o.uuid && seen.has(o.uuid)) { stats.dupTurns++; toolCalls = 0; edits = 0; prevSeg = ''; continue; }
    if (o.uuid) seen.add(o.uuid);

    // a fork question may sit in the run before a tool call and the final run be a short "готово" —
    // glue the previous run on when the last one is short
    let agentText = agentLast || prevSeg;
    if (agentLast && agentLast.length < 200 && prevSeg && prevSeg !== agentLast) agentText = `${prevSeg}\n\n${agentLast}`;
    const acted = edits > 0;   // edits = file writes + state-changing Bash; a turn of pure reading is not "did it himself"
    if (!agentText) stats.pairsNoAgent++;
    const tags = markPair({ agentText, userText, acted });
    if (queued) tags.push('queued');
    // keepOrphans: a turn with no agent text before it (session opener, after an interrupt) is often where the user states
    // the task and how it should be done — not a fork, but a statement the knowledge corpus wants
    if (agentText || keepOrphans) {
      pairs.push(buildPair({ stats, project, o, kind: agentText ? 'turn' : 'opener', agentText, agentTs: lastAgentTs, userText, tags, acted, toolCalls, edits, uuid: o.uuid }));
    }
    toolCalls = 0; edits = 0; prevSeg = ''; lastAgentTs = null;
  }
  return { pairs, stats };
}

function buildPair({ stats, project, o, kind, agentText, agentTs, userText, tags, acted, toolCalls, edits, uuid }) {
  const ts = o.timestamp;
  const wait = agentTs && ts ? Math.max(0, Math.round((Date.parse(ts) - Date.parse(agentTs)) / 1000)) : null;
  return {
    source: 'claude', project, session: stats.session, ts, uuid: uuid || null, cwd: stats.cwd, kind,
    agentTs, waitSec: wait, toolCalls, edits, acted,
    agentChars: agentText.length, userChars: userText.length,
    agent: cut(agentText), user: cut(userText),
    tags, cls: classify(tags),
  };
}

// ------------------------------------------------------------------ Codex

/** Codex interactive sessions only: codex_exec sessions carry ONE prompt delegated by a Claude session, not the user. */
export async function pairsFromCodex(file, { project = null, keepOrphans = false } = {}) {
  const session = path.basename(file, '.jsonl');
  const stats = { session, file, bytes: fs.statSync(file).size, started: null, cwd: null, originator: null,
    humanTurns: 0, pairsNoAgent: 0, convChars: 0, asks: 0 };
  const pairs = [];
  let finals = [], comments = [], lastAgentTs = null, toolCalls = 0, edits = 0;
  const pendingAsk = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length < 40) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload;
    if (!p) continue;
    if (o.type === 'session_meta') { stats.started = p.timestamp || o.timestamp; stats.cwd = p.cwd; stats.originator = p.originator; continue; }
    if (o.type === 'response_item' && /^(function_call|custom_tool_call)$/.test(p.type) && /request_user_input/.test(p.name || '')) {
      stats.asks++; pendingAsk.set(p.call_id, { text: String(p.arguments || p.input || ''), ts: o.timestamp });
      continue;
    }
    if (o.type === 'response_item' && /_output$/.test(p.type || '') && pendingAsk.has(p.call_id)) {
      const ask = pendingAsk.get(p.call_id); pendingAsk.delete(p.call_id);
      const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
      const agentText = ask.text;
      const tags = markPair({ agentText, userText: out, ask: { hasRecommended: /recommend/i.test(agentText) } });
      pairs.push({ source: 'codex', project, session, ts: o.timestamp, uuid: p.call_id, cwd: stats.cwd, kind: 'ask',
        agentTs: ask.ts, waitSec: Math.max(0, Math.round((Date.parse(o.timestamp) - Date.parse(ask.ts)) / 1000)),
        toolCalls, edits, acted: false, agentChars: agentText.length, userChars: out.length,
        agent: cut(agentText), user: cut(out), tags, cls: classify(tags) });
      continue;
    }
    if (o.type !== 'event_msg' || p.type !== 'item_completed' || !p.item) continue;
    const it = p.item;
    if (it.type === 'CommandExecution') toolCalls++;
    else if (it.type === 'FileChange') { toolCalls++; edits++; }
    else if (it.type === 'AgentMessage') {
      const t = (it.content || []).filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('\n');
      if (!t.trim()) continue;
      stats.convChars += t.length; lastAgentTs = o.timestamp;
      (it.phase === 'final_answer' ? finals : comments).push(t);
    } else if (it.type === 'UserMessage') {
      const userText = (it.content || []).filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('\n').replace(SYS_REMINDER, '').trim();
      const agentText = finals.length ? finals.join('\n') : comments.join('\n');
      const acted = edits > 0;
      finals = []; comments = []; const tc = toolCalls, ed = edits; toolCalls = 0; edits = 0;
      if (!userText) continue;
      stats.humanTurns++; stats.convChars += userText.length;
      if (!agentText) { stats.pairsNoAgent++; if (!keepOrphans) continue; }
      const tags = markPair({ agentText, userText, acted });
      pairs.push({ source: 'codex', project, session, ts: o.timestamp, uuid: it.id || null, cwd: stats.cwd, kind: agentText ? 'turn' : 'opener',
        agentTs: lastAgentTs, waitSec: lastAgentTs ? Math.max(0, Math.round((Date.parse(o.timestamp) - Date.parse(lastAgentTs)) / 1000)) : null,
        toolCalls: tc, edits: ed, acted, agentChars: agentText.length, userChars: userText.length,
        agent: cut(agentText), user: cut(userText), tags, cls: classify(tags) });
    }
  }
  return { pairs, stats };
}

/** First line of a Codex rollout = session_meta; read only that much. */
function codexMeta(file) {
  const fd = fs.openSync(file, 'r');
  try {
    let buf = Buffer.alloc(0), pos = 0;
    const chunk = Buffer.alloc(65536);
    while (pos < 4 * 1048576) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (!n) break;
      buf = Buffer.concat([buf, chunk.subarray(0, n)]); pos += n;
      const nl = buf.indexOf(10);
      if (nl >= 0) return JSON.parse(buf.subarray(0, nl).toString('utf8')).payload || null;
    }
  } catch { /* fallthrough */ } finally { fs.closeSync(fd); }
  return null;
}

function* walkJsonl(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

// ------------------------------------------------------------------ scope resolution + run

/** Claude top-level transcripts of the scope, started on/after `since` (first timestamp read from the head of the file). */
export function claudeFiles(scopeName, sinceMs) {
  const files = [];
  for (const { folder } of projectFolders(scopeOf(scopeName).dir, 'subtree')) {
    for (const f of fs.readdirSync(folder)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(folder, f);
      if (fs.statSync(file).size < 2048) continue;
      if (firstTimestamp(file) < sinceMs) continue;
      files.push(file);
    }
  }
  return files;
}

function firstTimestamp(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(262144);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const m = /"timestamp":"([^"]+)"/.exec(buf.subarray(0, n).toString('utf8'));
    return m ? Date.parse(m[1]) : Date.now();
  } finally { fs.closeSync(fd); }
}

export function codexFiles(scopeName, sinceMs) {
  const out = [];
  const scope = scopeOf(scopeName);
  const root = path.join(HOME, '.codex', 'sessions');
  for (const file of walkJsonl(root)) {
    const m = codexMeta(file);
    if (!m || !scope.codexCwd.test(m.cwd || '')) continue;
    if (Date.parse(m.timestamp || 0) < sinceMs) continue;
    out.push({ file, meta: m });
  }
  return out;
}

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : null);
const bump = (m, k, by = 1) => { m[k] = (m[k] || 0) + by; };

export async function runScope({ scope, since, out = null, examples = 0 }) {
  const sinceMs = Date.parse(since);
  const sum = { scope, since, claude: { sessions: 0, bytes: 0, humanTurns: 0, queuedTurns: 0, dupTurns: 0, pairs: 0, pairsNoAgent: 0, convChars: 0 },
    codex: { interactiveSessions: 0, execSessions: 0, execBytes: 0, bytes: 0, humanTurns: 0, pairs: 0, convChars: 0 },
    byClass: {}, byTag: {}, wait: { all: [], fork: [] }, pairChars: 0, perSession: [], sampleByClass: {}, bySource: {} };
  if (out) fs.writeFileSync(out, '');
  const seen = new Set();

  const take = (pairs) => {
    for (const p of pairs) {
      bump(sum.byClass, p.cls); bump(sum.bySource, p.source + ':' + p.cls);
      for (const t of p.tags) bump(sum.byTag, t);
      if (p.waitSec != null && !p.tags.includes('queued')) {
        sum.wait.all.push(p.waitSec);
        if (['ask_tool', 'fork_block', 'explicit'].includes(p.cls)) sum.wait.fork.push(p.waitSec);
      }
      sum.pairChars += p.agent.length + p.user.length;
      if (examples && ['ask_tool', 'fork_block', 'explicit', 'implicit'].includes(p.cls)) {
        const s = (sum.sampleByClass[p.cls] ||= []);
        if (s.length < examples) s.push(p);
      }
      if (out) fs.appendFileSync(out, JSON.stringify(p) + '\n');
    }
  };

  const cf = claudeFiles(scope, sinceMs);
  cf.sort();
  for (const file of cf) {
    const { pairs, stats } = await pairsFromClaude(file, { seen, project: scope });
    const c = sum.claude;
    c.sessions++; c.bytes += stats.bytes; c.humanTurns += stats.humanTurns; c.queuedTurns += stats.queuedTurns;
    c.dupTurns += stats.dupTurns; c.pairs += pairs.length; c.pairsNoAgent += stats.pairsNoAgent; c.convChars += stats.convChars;
    sum.perSession.push({ id: stats.session.slice(0, 8), convTokens: Math.round(stats.convChars / CHARS_PER_TOKEN), humanTurns: stats.humanTurns, pairs: pairs.length });
    take(pairs);
  }
  for (const { file, meta } of codexFiles(scope, sinceMs)) {
    const bytes = fs.statSync(file).size;
    const c = sum.codex;
    if (meta.originator === 'codex_exec') { c.execSessions++; c.execBytes += bytes; continue; }   // delegated prompt, not the user
    const { pairs, stats } = await pairsFromCodex(file, { project: scope });
    c.interactiveSessions++; c.bytes += bytes; c.humanTurns += stats.humanTurns; c.pairs += pairs.length; c.convChars += stats.convChars;
    sum.perSession.push({ id: stats.session.slice(0, 8) + '(codex)', convTokens: Math.round(stats.convChars / CHARS_PER_TOKEN), humanTurns: stats.humanTurns, pairs: pairs.length });
    take(pairs);
  }
  return sum;
}

// ------------------------------------------------------------------ git (outcomes)

export function gitOutcomes(scopeName, since) {
  const root = scopeOf(scopeName).dir;
  const repos = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory() && fs.existsSync(path.join(root, e.name, '.git'))) repos.push(path.join(root, e.name));
  }
  const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1048576, stdio: ['ignore', 'pipe', 'ignore'] });
  return repos.map((repo) => {
    const subjects = git(repo, ['log', '--all', `--since=${since}`, '--format=%h\t%s']).split('\n').filter(Boolean);
    const reverts = subjects.filter((s) => /\b(revert|rollback|откат|откатил|undo)\b/i.test(s.split('\t')[1] || ''));
    const bodyReverts = git(repo, ['log', '--all', `--since=${since}`, '--grep=This reverts commit', '--format=%h']).split('\n').filter(Boolean);
    return { repo: path.relative(HOME, repo), commits: subjects.length, revertSubjects: reverts.map((s) => s.slice(0, 120)), bodyReverts: bodyReverts.length };
  });
}

// ------------------------------------------------------------------ CLI

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

function printSummary(s) {
  const tok = (ch) => Math.round(ch / CHARS_PER_TOKEN);
  const c = s.claude, x = s.codex;
  const lines = [];
  lines.push(`scope=${s.scope} since=${s.since}`);
  lines.push(`Claude: sessions=${c.sessions} bytes=${(c.bytes / 1048576).toFixed(0)}MB humanTurns=${c.humanTurns} (queued ${c.queuedTurns}, dup ${c.dupTurns}) pairs=${c.pairs} noAgentText=${c.pairsNoAgent}`);
  lines.push(`Codex:  interactive=${x.interactiveSessions} humanTurns=${x.humanTurns} pairs=${x.pairs}; codex_exec delegated sessions skipped=${x.execSessions} (${(x.execBytes / 1048576).toFixed(0)}MB)`);
  lines.push(`byClass: ${JSON.stringify(s.byClass)}`);
  lines.push(`byTag:   ${JSON.stringify(s.byTag)}`);
  const m1 = median(s.wait.all), m2 = median(s.wait.fork);
  lines.push(`wait median: all=${m1 == null ? '-' : (m1 / 60).toFixed(1) + ' min'} (n=${s.wait.all.length}), fork-like=${m2 == null ? '-' : (m2 / 60).toFixed(1) + ' min'} (n=${s.wait.fork.length})`);
  const convTok = tok(c.convChars + x.convChars);
  lines.push(`volume (est. tokens, chars/${CHARS_PER_TOKEN}): conversation text only=${convTok}, pairs file=${tok(s.pairChars)}`);
  const big = s.perSession.filter((p) => p.convTokens > 100000).length;
  lines.push(`sessions by conversation-text tokens: >100k=${big}, 20-100k=${s.perSession.filter((p) => p.convTokens > 20000 && p.convTokens <= 100000).length}, <=20k=${s.perSession.filter((p) => p.convTokens <= 20000).length}; max=${Math.max(0, ...s.perSession.map((p) => p.convTokens))}`);
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const t0 = Date.now();
  const files = arg('files');
  currentConfig = arg('config');
  const usage = 'usage: forks.mjs --scope <name> [--config scopes.json] [--since 2026-10-30] [--out file] [--examples N] | --files a,b | --scope <name> --git';
  if (process.argv.includes('--git')) {
    if (!arg('scope')) { console.error(usage); process.exit(1); }
    console.log(JSON.stringify(gitOutcomes(arg('scope'), arg('since', '2026-10-30')), null, 2));
  } else if (files) {
    const out = arg('out');
    if (out) fs.writeFileSync(out, '');
    const seen = new Set();
    for (const f of files.split(',')) {
      const { pairs, stats } = await pairsFromClaude(f.trim(), { seen, project: 'test' });
      console.error(`${stats.session.slice(0, 8)} humanTurns=${stats.humanTurns} pairs=${pairs.length}`);
      for (const p of pairs) { if (out) fs.appendFileSync(out, JSON.stringify(p) + '\n'); else console.log(JSON.stringify(p)); }
    }
  } else {
    const scope = arg('scope');
    if (!scope) { console.error(usage); process.exit(1); }
    try { scopeOf(scope); } catch (e) { console.error(e.message); process.exit(1); }
    const s = await runScope({ scope, since: arg('since', '2026-10-30'), out: arg('out'), examples: Number(arg('examples', 0)) });
    if (process.argv.includes('--json-summary')) {
      const { wait, perSession, ...rest } = s;
      console.log(JSON.stringify({ ...rest, waitMedianSec: { all: median(wait.all), fork: median(wait.fork) }, perSessionTokens: perSession }, null, 1));
    } else console.log(printSummary(s));
    console.error(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s, peak rss=${(process.resourceUsage().maxRSS / 1024).toFixed(0)}MB`);
  }
}
