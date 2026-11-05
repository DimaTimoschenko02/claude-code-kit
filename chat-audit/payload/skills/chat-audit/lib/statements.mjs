#!/usr/bin/env node
// chat-audit :: statements (starter corpus for a knowledge base of the user's own statements — no LLM)
//
// Collects everything the user tried to get across, not only forks: every chat turn (with the agent reply it answers, or
// none for a session opener), their review comments on PRs, and the answers/decisions in task cards. One jsonl line =
// one statement with an anchor a later LLM pass can cite (session+ts, PR comment URL, card path+line).
//
// Cost: chats stream one file at a time (forks.mjs); PR comments come as one paginated `gh api` call per endpoint,
// streamed as jq lines; cards are read one file at a time. Nothing holds the corpus whole.
//
// Usage:
//   node statements.mjs --scope <name> [--config scopes.json] [--since 2026-10-30] [--pr-since 2026-09-01] --out statements.jsonl
//        [--repo owner/repo] [--cards <dir of task cards>]     (defaults: the scope's "repos" and "cards", see forks.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { scrub } from './scrub.mjs';
import { pairsFromClaude, pairsFromCodex, claudeFiles, codexFiles, loadScope } from './forks.mjs';

const CAP = 2000;
const cut = (s, cap = CAP) => { const t = scrub(String(s || '').trim()); return t.length > cap ? t.slice(0, cap) + ` […+${t.length - cap}]` : t; };

// ------------------------------------------------------------------ chats

async function chatStatements(scopeDef, sinceMs, emit) {
  const scope = scopeDef.name;
  const seen = new Set();
  let n = 0;
  for (const file of claudeFiles(scopeDef, sinceMs).sort()) {
    const { pairs } = await pairsFromClaude(file, { seen, project: scope, keepOrphans: true });
    for (const p of pairs) { emit(fromPair(p)); n++; }
  }
  for (const { file, meta } of codexFiles(scopeDef, sinceMs)) {
    if (meta.originator === 'codex_exec') continue;   // a prompt delegated by another session, not the user
    const { pairs } = await pairsFromCodex(file, { project: scope, keepOrphans: true });
    for (const p of pairs) { emit(fromPair(p)); n++; }
  }
  return n;
}

// A slash command arrives as <command-message>/<command-name> tags around the user's args — keep the args, name the command.
const unwrapCommand = (t) => t.replace(/<command-message>[\s\S]*?<\/command-message>\s*/g, '')
  .replace(/<command-name>([\s\S]*?)<\/command-name>\s*/g, '$1 ').replace(/<\/?command-args>/g, '').trim();

const fromPair = (p) => ({
  source: p.source === 'codex' ? 'codex-chat' : 'chat', project: p.project,
  anchor: { session: p.session, ts: p.ts, uuid: p.uuid }, ts: p.ts, kind: p.kind,
  text: unwrapCommand(p.user), context: p.agent || null, tags: p.tags, cls: p.cls,
});

// ------------------------------------------------------------------ PR review comments

// Agents often post through the user's own GitHub account, so the login says nothing. The user opens review threads; the agent
// answers them (in_reply_to_id) in long, bolded, hash-citing prose. A reply still counts as the user's when it reads like them.
const AGENT_STYLE = /\*\*|`[0-9a-f]{7,40}`|\b[0-9a-f]{8}\b|^(?:Заменён|Пересобрано|Добавлен|Already in main|Closing|Ты прав, исправлено|Исправлено|Fixed in|Done in)/m;
// PR-level (issue) comments have no threads: there the agent writes status notes ("Конфликтует с dev…"), so they get
// the same style test as replies.
export function isUserComment(c, { threaded = true } = {}) {
  const body = String(c.body || '');
  if (!body.trim() || body.length > 900 || AGENT_STYLE.test(body)) return false;
  if (threaded && !c.in_reply_to_id) return true;
  return body.length < 400 && /^[a-zа-яё]|\)\)|бля|хуй|хуя|\?\s*$/m.test(body.trim());
}

function ghLines(endpoint, jq) {
  const out = execFileSync('gh', ['api', '--paginate', endpoint, '--jq', jq], { encoding: 'utf8', maxBuffer: 256 * 1048576, stdio: ['ignore', 'pipe', 'pipe'] });
  return out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function prStatements(repo, sinceIso, project, emit) {
  const pick = '.[] | {id, body, created_at, html_url, path, line, diff_hunk, in_reply_to_id, pr: (.pull_request_url // .issue_url)}';
  const review = ghLines(`repos/${repo}/pulls/comments?per_page=100&since=${sinceIso}`, pick);
  const issue = ghLines(`repos/${repo}/issues/comments?per_page=100&since=${sinceIso}`, pick);
  let kept = 0, total = 0;
  for (const [kind, list] of [['review', review], ['issue', issue]]) {
    for (const c of list) {
      total++;
      if (c.created_at < sinceIso || !isUserComment(c, { threaded: kind === 'review' })) continue;
      kept++;
      emit({ source: 'pr-' + kind, project, anchor: { url: c.html_url, path: c.path || null, line: c.line || null }, ts: c.created_at,
        kind: c.in_reply_to_id ? 'reply' : 'comment', text: cut(c.body), context: c.diff_hunk ? cut(c.diff_hunk, 800) : null, tags: [], cls: null });
    }
  }
  return { total, kept };
}

// ------------------------------------------------------------------ task cards

const ANSWER = /^\s*(?:[-*]\s*)?\*\*(?:Ответ|Відповідь)(?:\s*\(([^)]*)\))?\s*:?\s*(?:\*\*\s*:?\s*(.*)|([^*]+)\*\*.*)$/;
const QUESTION_ITEM = /^\s{0,3}\d+\.\s+\S/;
const DECISION_HEAD = /^#{2,4}\s*(?:Рішення|Решения|Решение)\s*$/;

function* walkMd(dir, skip = null) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkMd(p, skip);
    else if (e.name.endsWith('.md') && !skip?.test(e.name)) yield p;
  }
}

/** Answers (with the question they answer) and the «Рішення» section of every card. */
export function cardStatements(file, project) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const rel = path.basename(file);
  const out = [];
  let question = null, inDecision = false, decision = [], decisionLine = 0;
  const flushDecision = () => {
    const t = decision.join('\n').trim();
    if (t) out.push({ source: 'card-decision', project, anchor: { card: rel, line: decisionLine }, ts: null, kind: 'decision', text: cut(t), context: null, tags: [], cls: null });
    decision = []; inDecision = false;
  };
  lines.forEach((l, i) => {
    if (/^#{1,4}\s/.test(l)) { if (inDecision) flushDecision(); if (DECISION_HEAD.test(l)) { inDecision = true; decisionLine = i + 1; } question = null; return; }
    if (inDecision) decision.push(l);
    if (QUESTION_ITEM.test(l)) question = l.trim();
    const m = ANSWER.exec(l);
    if (!m) return;
    const text = (m[2] ?? m[3] ?? '').trim();
    if (!text) return;   // open question, no answer yet
    out.push({ source: 'card-answer', project, anchor: { card: rel, line: i + 1 }, ts: null, kind: 'answer', text: cut(text),
      context: question ? cut(question, 1200) : null, tags: m[1] ? [m[1]] : [], cls: null });
  });
  if (inDecision) flushDecision();
  return out;
}

// ------------------------------------------------------------------ run

export async function run({ scopeDef, since, prSince, out, repos, cards }) {
  const skip = scopeDef.cardsSkip ?? null;
  const scope = scopeDef.name;
  fs.writeFileSync(out, '');
  const counts = {};
  const emit = (s) => { counts[s.source] = (counts[s.source] || 0) + 1; fs.appendFileSync(out, JSON.stringify(s) + '\n'); };
  await chatStatements(scopeDef, Date.parse(since), emit);
  const pr = {};
  for (const repo of repos) {
    try { pr[repo] = prStatements(repo, new Date(prSince).toISOString(), scope, emit); }
    catch (e) { pr[repo] = { error: String(e.message).split('\n')[0] }; }
  }
  // the same decision is copied into the epic card and its child cards — keep the first copy, count the rest
  let cardFiles = 0, cardDupes = 0;
  const seenText = new Set();
  for (const f of cards ? walkMd(cards, skip) : []) {
    cardFiles++;
    for (const s of cardStatements(f, scope)) {
      const key = s.source + '|' + s.text.replace(/\s+/g, ' ');
      if (seenText.has(key)) { cardDupes++; continue; }
      seenText.add(key); emit(s);
    }
  }
  return { counts, pr, cardFiles, cardDupes };
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const t0 = Date.now();
  const out = arg('out');
  if (!arg('scope') || !out) { console.error('usage: statements.mjs --scope <name> --out file.jsonl [--config scopes.json] [--since D] [--pr-since D] [--repo o/r] [--cards dir]'); process.exit(1); }
  let scopeDef;
  try { scopeDef = loadScope(arg('scope'), arg('config')); } catch (e) { console.error(e.message); process.exit(1); }
  const res = await run({ scopeDef, since: arg('since', '2026-10-30'), prSince: arg('pr-since', '2026-09-01'), out,
    repos: arg('repo') ? [arg('repo')] : scopeDef.repos, cards: arg('cards', scopeDef.cards) });
  console.log(JSON.stringify(res, null, 1));
  console.error(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s, peak rss=${(process.resourceUsage().maxRSS / 1024).toFixed(0)}MB (node only; gh runs as a child)`);
}
