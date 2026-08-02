#!/usr/bin/env node
// chat-audit :: frequency analysis
//
// Counts the patterns a learning log structurally cannot see: commands repeated
// by hand, code written from scratch inline, failures, retries, files re-read
// across sessions, skill/agent usage, and what the guardrails blocked.
//
// Ported from two battle-tested Python tools (transcript-stats.py,
// hook-friction.py) and generalized: no project, path or repo is hardcoded.
//
// Usage:
//   node analyze.mjs [--project <dir>] [--scope exact|subtree|all] [--days N]
//                    [--section tools,bash,inline,fails,retries,reads,skills,agents,friction]
//                    [--top 25] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scrub } from './scrub.mjs';
import { projectFolders } from './discover.mjs';

// ---------------------------------------------------------------- normalize

const NORM = [
  [/<<-?\s*'?[A-Z_]+'?[\s\S]*?^[A-Z_]+$/gm, '<<HEREDOC>'],
  [/'[^']{2,}'/g, "'S'"],
  [/"[^"]{2,}"/g, '"S"'],
  [/\b\d{2,}\b/g, 'N'],
  [/\/[\w./-]{6,}/g, '/PATH'],
  [/\s+/g, ' '],
];

function normalizeCmd(cmd) {
  let s = cmd;
  for (const [re, r] of NORM) s = s.replace(re, r);
  return s.trim().slice(0, 300);
}

const SPLIT = /\s*(?:&&|\|\||;|\|)\s*/;
const ENV_PREFIX = /^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/;
const SUBCOMMAND_BINS = new Set(['git', 'glab', 'gh', 'npm', 'npx', 'pnpm', 'yarn', 'docker',
  'kubectl', 'jq', 'python3', 'python', 'node', 'cargo', 'go', 'terraform', 'aws']);
// Shell plumbing inside a compound command is not a signal by itself.
const NOISE_BINS = new Set(['echo', 'head', 'tail', 'cut', 'sort', 'uniq', 'wc', 'cat', 'tr',
  'sed', 'awk', 'grep', 'egrep', 'rg', 'xargs', 'printf', 'tee', 'do', 'done', 'then', 'fi',
  'for', 'if', 'while', 'read', 'true', 'false', 'test', 'basename', 'dirname', 'mkdir', 'rm',
  'cp', 'mv', 'touch', 'chmod', 'export', 'source', 'eval', 'set', 'cd', 'ls', 'which', 'env']);

function binaries(cmd) {
  const out = [];
  for (let seg of cmd.split(SPLIT)) {
    seg = seg.replace(ENV_PREFIX, '').trim();
    if (!seg) continue;
    const parts = seg.split(/\s+/);
    let b = (parts[0] || '').split('/').pop().replace(/^[()$`{}\\]+|[()$`{}\\]+$/g, '');
    if (!b || /^[-#"']/.test(b)) continue;
    if (SUBCOMMAND_BINS.has(b) && parts[1] && !parts[1].startsWith('-')) {
      b = `${b} ${parts[1].split('/').pop()}`;
    }
    out.push(b);
  }
  return out;
}

// -------------------------------------------------------------- inline code

const HEREDOC = /<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\s*\n([\s\S]*?)\n\s*\1\s*$/gm;
const DASH_C = /\b(python3?|node|perl|ruby|osascript|deno)\s+-(?:c|e)\s+(['"])([\s\S]*?)\2/g;
const JQ_PROG = /\bjq\s+(?:-[a-zA-Z]+\s+)*'([^']{40,})'/g;
const IDENT = /[A-Za-z_][A-Za-z0-9_]{3,}/g;
const STOP = new Set(['print', 'with', 'open', 'self', 'true', 'false', 'null', 'none', 'return',
  'import', 'from', 'this', 'const', 'then', 'else', 'elif', 'type', 'data', 'line', 'text',
  'value', 'result', 'json', 'file', 'path', 'name', 'item', 'list', 'dict', 'args', 'func',
  'lambda', 'async', 'await', 'catch', 'throw', 'class', 'super', 'break', 'continue']);

/** Stable signature of a snippet: the code's identifier fingerprint. */
function inlineSignature(code) {
  const ids = [...new Set((code.match(IDENT) || []).map((s) => s.toLowerCase()))]
    .filter((s) => !STOP.has(s)).sort().slice(0, 12);
  if (ids.length < 3) return null;
  return createHash('sha1').update(ids.join(',')).digest('hex').slice(0, 12);
}

// A heredoc is usually file content, not a program. Only count it as code when
// it actually looks like one — otherwise every note written to disk shows up as
// "code written from scratch".
const LOOKS_LIKE_CODE = /(\bdef |\bimport |\bfunction\b|\bconst |\blet |=>|\bif \(|\bfor \(|\bwhile \(|\becho \$|\bprint\(|\breturn\b|\bselect .+\bfrom\b)/i;

function extractInline(cmd) {
  const found = [];
  for (const m of cmd.matchAll(HEREDOC)) {
    const body = m[2];
    if (!LOOKS_LIKE_CODE.test(body)) continue;
    const lang = /\b(def |import |print\()/.test(body) ? 'python' : 'shell/heredoc';
    found.push([lang, body]);
  }
  for (const m of cmd.matchAll(DASH_C)) found.push([m[1], m[3]]);
  for (const m of cmd.matchAll(JQ_PROG)) found.push(['jq', m[1]]);
  return found.filter(([, c]) => c.trim().length >= 40);
}

// ------------------------------------------------------------------ failures

const FAIL = /(command not found|no such file|permission denied|syntax error|fatal:|error:|traceback \(most recent|cannot |could not |unable to |connection refused|timed out|exit code [1-9]|unauthorized|forbidden|authentication failed|access denied|not recognized)/i;
// The reason runs to end-of-line. Results arrive either as a decoded string
// (real newlines) or as the raw JSON line (escaped \n) — both stop here.
const BLOCKED = /BLOCKED by ([\w.\-]+\.(?:sh|py|mjs))\s*:?\s*([^\n"]{0,200})/;
const DENIED = /Permission for this action was denied by the Claude Code auto mode classifier/;
const OUTAGE = /is temporarily unavailable, so auto mode cannot determine the safety/;

// ---------------------------------------------------------------------- run

const bump = (m, k, by = 1) => m.set(k, (m.get(k) || 0) + by);
const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

export function analyze(projectDir, opts = {}) {
  const { scope = 'subtree', days = null } = opts;
  const cutoff = days ? Date.now() - days * 86400000 : null;

  const D = {
    tools: new Map(), bins: new Map(), cmdNorm: new Map(), cmdExample: new Map(),
    inline: new Map(), inlineTotal: 0,
    fails: new Map(), failExample: new Map(), retries: new Map(),
    reads: new Map(), readSessions: new Map(),
    writes: new Map(), skills: new Map(), agents: new Map(),
    blocks: new Map(), blockReason: new Map(), denials: 0, outages: 0,
    sessions: new Set(), days: new Set(), outTokens: 0, models: new Map(),
  };
  const lastSeen = new Map();     // `${sid} ${norm}` -> seq
  const seenResult = new Set();   // dedupe (session, tool_use_id): results appear twice
  let seq = 0, files = 0, lines = 0;

  for (const { folder } of projectFolders(projectDir, scope)) {
    let entries;
    try { entries = fs.readdirSync(folder).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const fname of entries) {
      const fpath = path.join(folder, fname);
      let raw;
      try { raw = fs.readFileSync(fpath, 'utf8'); } catch { continue; }
      files++;
      for (const line of raw.split('\n')) {
        if (!line || line.length < 20) continue;
        lines++;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }

        const ts = rec.timestamp;
        if (cutoff && ts && Date.parse(ts) < cutoff) continue;
        const sid = rec.sessionId || rec.session_id || '?';
        D.sessions.add(sid);
        if (ts) D.days.add(ts.slice(0, 10));

        // --- guardrail friction: lives in the tool RESULT record ---
        // The same block text is echoed by the assistant record and by an
        // attachment record; counting every occurrence inflates the number.
        // Count the result record only, deduped by tool_use_id.
        const isResult = rec.type === 'user' && rec.toolUseResult !== undefined;
        const blob = !isResult ? ''
          : typeof rec.toolUseResult === 'string' ? rec.toolUseResult
          : JSON.stringify(rec.toolUseResult);
        if (blob) {
          const tuid = rec.toolUseID
            || (Array.isArray(rec.message?.content)
                ? rec.message.content.find((c) => c?.tool_use_id)?.tool_use_id : null)
            || rec.uuid || '';
          const key = `${sid} ${tuid}`;
          if (!seenResult.has(key)) {
            seenResult.add(key);
            const b = BLOCKED.exec(blob);
            if (b) {
              bump(D.blocks, b[1]);
              // The blob is JSON-escaped: unescape so the reason is readable prose.
              const reason = b[2].replace(/\\[nrt]/g, ' ').replace(/\\"/g, '"')
                .replace(/\s+/g, ' ').trim();
              if (reason.length > 8 && !D.blockReason.has(b[1])) {
                D.blockReason.set(b[1], scrub(reason.slice(0, 160)));
              }
            }
            if (DENIED.test(blob)) D.denials++;
            if (OUTAGE.test(blob)) D.outages++;
          }
        }

        // --- failures: stderr of a tool result ---
        if (rec.toolUseResult && typeof rec.toolUseResult === 'object') {
          const err = String(rec.toolUseResult.stderr || '').slice(0, 400);
          if (err && FAIL.test(err)) {
            const head = scrub(err.trim().split('\n')[0].slice(0, 120));
            bump(D.fails, head);
          }
        }

        if (rec.type !== 'assistant') continue;
        const msg = rec.message || {};
        if (msg.model) bump(D.models, msg.model);
        D.outTokens += msg.usage?.output_tokens || 0;
        if (!Array.isArray(msg.content)) continue;

        for (const block of msg.content) {
          if (block?.type !== 'tool_use') continue;
          seq++;
          const name = block.name || '?';
          const inp = block.input || {};
          bump(D.tools, name);

          if (name === 'Agent' || name === 'Task') bump(D.agents, inp.subagent_type || 'default');
          else if (name === 'Skill') bump(D.skills, inp.skill || '?');
          else if (name === 'Read' && inp.file_path) {
            bump(D.reads, inp.file_path);
            if (!D.readSessions.has(inp.file_path)) D.readSessions.set(inp.file_path, new Set());
            D.readSessions.get(inp.file_path).add(sid);
          } else if (['Edit', 'Write', 'NotebookEdit'].includes(name) && inp.file_path) {
            bump(D.writes, inp.file_path);
          } else if (name === 'Bash' && inp.command) {
            const cmd = String(inp.command);
            // Strip embedded program bodies first — otherwise `node -e 'const x…'`
            // reports `const` as a binary the user runs.
            const shellOnly = cmd.replace(HEREDOC, ' <<HEREDOC ')
              .replace(DASH_C, (m, bin) => `${bin} -c <CODE>`)
              .replace(JQ_PROG, 'jq <PROG>');
            for (const b of binaries(shellOnly)) if (!NOISE_BINS.has(b)) bump(D.bins, b);

            const norm = normalizeCmd(cmd);
            bump(D.cmdNorm, norm);
            if (!D.cmdExample.has(norm)) D.cmdExample.set(norm, scrub(cmd.slice(0, 220)));

            const k = `${sid} ${norm}`;
            if (lastSeen.has(k) && seq - lastSeen.get(k) <= 3) bump(D.retries, norm);
            lastSeen.set(k, seq);

            for (const [lang, code] of extractInline(cmd)) {
              const sig = inlineSignature(code);
              if (!sig) continue;
              if (!D.inline.has(sig)) D.inline.set(sig, { n: 0, lang, sample: scrub(code.trim().slice(0, 300)), sessions: new Set() });
              const slot = D.inline.get(sig);
              slot.n++;
              slot.sessions.add(sid);
              D.inlineTotal++;
            }
          }
        }
      }
    }
  }

  const n = opts.top || 25;
  return {
    scanned: { files, lines, sessions: D.sessions.size, days: D.days.size, outputTokens: D.outTokens },
    models: top(D.models, 10).map(([key, count]) => ({ key, count })),
    tools: top(D.tools, n).map(([key, count]) => ({ key, count })),
    bash: top(D.bins, n).map(([key, count]) => ({ key, count })),
    repeatedCommands: top(D.cmdNorm, n * 2).filter(([, c]) => c >= 3)
      .slice(0, n).map(([key, count]) => ({ count, shape: key, example: D.cmdExample.get(key) })),
    retries: top(D.retries, n).map(([key, count]) => ({ count, shape: key, example: D.cmdExample.get(key) })),
    // Repeats (count>=2 or seen in 2+ sessions) are tool candidates; one-offs
    // still matter as volume, so they are kept and flagged, not dropped.
    inlineCode: [...D.inline.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, n)
      .map(([sig, v]) => ({ sig, count: v.n, lang: v.lang, sessions: v.sessions.size,
                            candidate: v.n >= 2 || v.sessions.size >= 2, sample: v.sample })),
    inlineTotal: D.inlineTotal,
    failures: top(D.fails, n).map(([key, count]) => ({ count, error: key })),
    rereadFiles: [...D.reads.entries()]
      .map(([f, c]) => ({ file: f, reads: c, sessions: (D.readSessions.get(f) || new Set()).size }))
      .filter((r) => r.sessions >= 2).sort((a, b) => b.reads - a.reads).slice(0, n),
    editedFiles: top(D.writes, n).map(([key, count]) => ({ key, count })),
    skills: top(D.skills, n).map(([key, count]) => ({ key, count })),
    agents: top(D.agents, n).map(([key, count]) => ({ key, count })),
    friction: {
      blocks: top(D.blocks, n).map(([key, count]) => ({ hook: key, count, reason: D.blockReason.get(key) })),
      classifierDenials: D.denials,
      classifierOutages: D.outages,
    },
  };
}

// ---------------------------------------------------------------------- CLI

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function printReport(r, sections) {
  const has = (s) => sections.includes('all') || sections.includes(s);
  const s = r.scanned;
  console.log(`scanned: ${s.files} files · ${s.sessions} sessions · ${s.days} days · ${(s.outputTokens / 1000).toFixed(0)}k output tokens\n`);
  const table = (title, rows, fmt) => {
    if (!rows.length) return;
    console.log(`─── ${title}`);
    for (const row of rows) console.log('  ' + fmt(row));
    console.log();
  };
  if (has('tools')) table('tools', r.tools, (x) => `${String(x.count).padStart(5)}  ${x.key}`);
  if (has('bash')) table('bash binaries', r.bash, (x) => `${String(x.count).padStart(5)}  ${x.key}`);
  if (has('bash')) table('repeated commands (>=3× — script candidates)', r.repeatedCommands,
    (x) => `${String(x.count).padStart(5)}  ${x.example}`);
  if (has('retries')) table('retries (same command within 3 steps)', r.retries,
    (x) => `${String(x.count).padStart(5)}  ${x.example}`);
  if (has('inline')) table(`inline code written from scratch (${r.inlineTotal} total — tool candidates)`, r.inlineCode,
    (x) => `${String(x.count).padStart(5)}  [${x.lang}, ${x.sessions} sess] ${x.sample.split('\n')[0].slice(0, 90)}`);
  if (has('fails')) table('failures', r.failures, (x) => `${String(x.count).padStart(5)}  ${x.error}`);
  if (has('reads')) table('files re-read across sessions (memory candidates)', r.rereadFiles,
    (x) => `${String(x.reads).padStart(5)}  [${x.sessions} sess] ${x.file}`);
  if (has('skills')) table('skills invoked', r.skills, (x) => `${String(x.count).padStart(5)}  ${x.key}`);
  if (has('agents')) table('agents spawned', r.agents, (x) => `${String(x.count).padStart(5)}  ${x.key}`);
  if (has('friction')) {
    table('hook blocks', r.friction.blocks, (x) => `${String(x.count).padStart(5)}  ${x.hook} — ${x.reason || ''}`);
    if (r.friction.classifierDenials || r.friction.classifierOutages) {
      console.log(`─── classifier\n  denials: ${r.friction.classifierDenials}  outages: ${r.friction.classifierOutages}\n`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const project = path.resolve(arg('project', process.cwd()));
  const r = analyze(project, {
    scope: arg('scope', 'subtree'),
    days: arg('days') ? Number(arg('days')) : null,
    top: Number(arg('top', 25)),
  });
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else printReport(r, (arg('section', 'all')).split(','));
}
