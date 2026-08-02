#!/usr/bin/env node
// chat-audit :: memory rot
//
// Durable memory anchors itself to code — `file.ts:123`, symbol names, commit
// hashes. Code moves; memory does not. A dead anchor next to a claim is a strong
// signal the claim went stale, and it is the only part a machine can check.
//
// Only machine-checkable things are verified: does the file exist, is the line
// in range, does the symbol still appear, is the commit still reachable. Prose
// claims are out of scope by design.
//
// Ported from memory-drift.py and generalized: memory location and repos are
// discovered, not hardcoded.
//
// Usage:
//   node memory-drift.mjs [--project <dir>] [--memory <dir>] [--file X.md] [--quiet] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { findMemory } from './discover.mjs';

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|py|go|rs|java|kt|rb|php|sql|sh)$/;
// Symbols also live in config, schema and migration files — index those too, or
// every table/event name reads as "missing".
const INDEX_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|sql|sh|ya?ml|json|toml|proto|graphql|prisma)$/;
const INDEX_SKIP = /(^|\/)(node_modules|dist|build|coverage)\/|\.(min|bundle)\.|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
// `path/file.ts:123` or file.ts#123
const ANCHOR_LINE = /`?([\w./-]+\.(?:ts|tsx|js|jsx|mjs|py|go|rs|java|kt|rb|php|sql|sh))[:#](\d{1,5})`?/g;
// A commit hash must actually look like one: hex WITH letters. Bare digit runs
// are IDs (user, bonus, order) and reporting them as dead commits is noise.
const ANCHOR_COMMIT = /`([0-9a-f]{7,40})`/g;
const ANCHOR_SYMBOL = /`([A-Za-z_][A-Za-z0-9_]{5,60})\(?\)?`/g;
// Documentation placeholders, not real anchors.
const PLACEHOLDER = /^(file|path|foo|bar|example|some)[\w.]*\.(ts|js|py|sql|sh)$/i;

const SYMBOL_STOP = new Set(['undefined', 'boolean', 'console', 'process', 'require', 'default',
  'function', 'string', 'number', 'object', 'return', 'export', 'import', 'public', 'private',
  'package', 'message', 'content', 'session', 'request', 'response', 'provider', 'example',
  'interface', 'component', 'container', 'database', 'variable', 'parameter', 'property']);

function run(args, cwd) {
  try {
    return { code: 0, out: execFileSync(args[0], args.slice(1), { cwd, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: e.stdout || '' };
  }
}

/** Git repos at or under the project dir (depth<=2) — the code memory points at. */
export function findRepos(projectDir) {
  const repos = [];
  if (fs.existsSync(path.join(projectDir, '.git'))) repos.push(projectDir);
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (fs.existsSync(path.join(p, '.git'))) repos.push(p);
      else walk(p, depth + 1);
    }
  };
  walk(projectDir, 1);
  return repos;
}

/** basename -> [full paths] across all repos. One pass, then pure lookups. */
function buildFileIndex(repos) {
  const idx = new Map();
  for (const repo of repos) {
    const r = run(['git', 'ls-files'], repo);
    if (r.code !== 0) continue;
    for (const rel of r.out.split('\n')) {
      if (!rel || !CODE_EXT.test(rel)) continue;
      const base = path.basename(rel);
      if (!idx.has(base)) idx.set(base, []);
      idx.get(base).push(path.join(repo, rel));
    }
  }
  return idx;
}

function countLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').length; } catch { return 0; }
}

const IDENT_IN_CODE = /[A-Za-z_][A-Za-z0-9_]{5,60}/g;
const MAX_INDEX_BYTES = 400 * 1024 * 1024;

/**
 * Resolve every symbol against one identifier index built from the code.
 * Per-symbol `git grep` means thousands of process spawns, and `git grep -f`
 * with thousands of patterns degrades badly — both take minutes on a real repo
 * set. Reading the tracked source once and hashing its identifiers is linear.
 * Returns null when the index would be too large to build (caller skips symbols
 * rather than reporting false staleness).
 */
function buildIdentIndex(repos, extraDirs = []) {
  let bytes = 0;
  const idents = new Set();
  const eat = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return true; }
    bytes += st.size;
    if (bytes > MAX_INDEX_BYTES) return false;
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { return true; }
    for (const m of text.match(IDENT_IN_CODE) || []) idents.add(m);
    return true;
  };

  for (const repo of repos) {
    const r = run(['git', 'ls-files'], repo);
    if (r.code !== 0) continue;
    for (const rel of r.out.split('\n')) {
      if (!rel || !INDEX_EXT.test(rel) || INDEX_SKIP.test(rel)) continue;
      if (!eat(path.join(repo, rel))) return null;
    }
  }
  // Tooling outside any repo (hooks, scripts, skills) defines symbols memory
  // legitimately cites — index it too, or those all read as missing.
  for (const dir of extraDirs) {
    const walk = (d, depth = 0) => {
      if (depth > 5) return true;
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return true; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (!walk(p, depth + 1)) return false; }
        else if (INDEX_EXT.test(e.name) && !eat(p)) return false;
      }
      return true;
    };
    if (!walk(dir)) return null;
  }
  return idents;
}

/** Same idea for commits: one `cat-file --batch-check` per repo. */
function resolveCommits(shas, repos) {
  const alive = new Set();
  if (!shas.size) return alive;
  const input = [...shas].map((s) => `${s}^{commit}`).join('\n') + '\n';
  for (const repo of repos) {
    let out = '';
    try {
      out = execFileSync('git', ['cat-file', '--batch-check'], {
        cwd: repo, input, encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch { continue; }
    for (const line of out.split('\n')) {
      const m = /^([0-9a-f]{7,40})\^\{commit\} missing/.exec(line.trim());
      if (m) continue;                                    // explicitly missing
      const ok = /^[0-9a-f]{40} commit /.test(line.trim());
      if (!ok) continue;
      // batch-check echoes resolved objects; map back by prefix
      const sha = line.trim().split(' ')[0];
      for (const s of shas) if (sha.startsWith(s)) alive.add(s);
    }
  }
  return alive;
}

export function checkMemory({ projectDir, memoryDir = null, onlyFile = null,
                              includeEphemeral = false } = {}) {
  const repos = findRepos(projectDir);
  // Day-logs (.remember and friends) are scratch, not durable memory: their
  // anchors are expected to rot, so scanning them buries the real findings.
  const memDirs = memoryDir
    ? [{ realPath: memoryDir, kind: 'explicit' }]
    : findMemory(projectDir).filter((m) => includeEphemeral || m.kind !== 'remember-plugin');
  const fileIdx = buildFileIndex(repos);
  const findings = [];
  let filesChecked = 0, anchors = 0;

  const mdFiles = [];
  for (const m of memDirs) {
    const walk = (d, depth = 0) => {
      if (depth > 6) return;
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name.endsWith('.md')) mdFiles.push(p);
      }
    };
    walk(m.realPath);
  }

  // Pass 1 — collect every anchor, resolve nothing yet.
  const pending = [];
  const symbols = new Set(), commits = new Set();
  for (const md of mdFiles) {
    if (onlyFile && !md.endsWith(onlyFile)) continue;
    let text;
    try { text = fs.readFileSync(md, 'utf8'); } catch { continue; }
    filesChecked++;
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(ANCHOR_LINE)) {
        if (PLACEHOLDER.test(path.basename(m[1]))) continue;
        anchors++;
        pending.push({ type: 'line', file: md, line: i + 1, ref: m[1], lno: Number(m[2]) });
      }
      for (const m of line.matchAll(ANCHOR_COMMIT)) {
        const sha = m[1];
        if (!/^[0-9a-f]{7,40}$/.test(sha)) continue;
        if (!/[a-f]/.test(sha)) continue;   // all digits -> an ID, not a hash
        anchors++;
        commits.add(sha);
        pending.push({ type: 'commit', file: md, line: i + 1, sha });
      }
      for (const m of line.matchAll(ANCHOR_SYMBOL)) {
        const sym = m[1];
        if (SYMBOL_STOP.has(sym.toLowerCase())) continue;
        if (!/[A-Z_]/.test(sym.slice(1))) continue;   // camelCase / SNAKE_CASE only
        anchors++;
        symbols.add(sym);
        pending.push({ type: 'symbol', file: md, line: i + 1, sym });
      }
    });
  }

  // Pass 2 — resolve in batches, then report.
  const identIndex = symbols.size
    ? buildIdentIndex(repos, [path.join(projectDir, '.claude')])
    : new Set();
  const aliveCommits = resolveCommits(commits, repos);
  const lineCache = new Map();
  const skippedSymbols = identIndex === null;

  for (const p of pending) {
    if (p.type === 'line') {
      const base = path.basename(p.ref);
      const cands = (fileIdx.get(base) || []).filter((q) => q.endsWith(p.ref) || path.basename(q) === base);
      if (!cands.length) {
        findings.push({ severity: 'high', file: p.file, line: p.line, kind: 'missing-file', anchor: `${p.ref}:${p.lno}`, note: 'file not found in any repo' });
      } else {
        if (!lineCache.has(cands[0])) lineCache.set(cands[0], countLines(cands[0]));
        const n = lineCache.get(cands[0]);
        if (n && p.lno > n) {
          findings.push({ severity: 'high', file: p.file, line: p.line, kind: 'line-out-of-range', anchor: `${p.ref}:${p.lno}`, note: `file now has ${n} lines` });
        }
      }
    } else if (p.type === 'commit' && !aliveCommits.has(p.sha)) {
      findings.push({ severity: 'medium', file: p.file, line: p.line, kind: 'missing-commit', anchor: p.sha, note: 'commit not reachable' });
    } else if (p.type === 'symbol' && !skippedSymbols && !identIndex.has(p.sym)) {
      findings.push({ severity: 'low', file: p.file, line: p.line, kind: 'missing-symbol', anchor: p.sym, note: 'symbol not found in indexed code — may be external API, DB object or prose' });
    }
  }

  return { repos, memoryDirs: memDirs.map((m) => m.realPath), filesChecked, anchors, findings,
           skippedSymbols };
}

// ---------------------------------------------------------------------- CLI

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = checkMemory({
    projectDir: path.resolve(arg('project', process.cwd())),
    memoryDir: arg('memory'),
    onlyFile: arg("file"),
    includeEphemeral: process.argv.includes("--include-ephemeral"),
  });
  if (process.argv.includes('--json')) { console.log(JSON.stringify(res, null, 2)); process.exit(0); }
  if (res.skippedSymbols) console.log('note: symbol check skipped — code index too large');
  console.log(`repos: ${res.repos.length} · memory dirs: ${res.memoryDirs.length} · files: ${res.filesChecked} · anchors: ${res.anchors}`);
  // Symbol misses are a weak heuristic (external APIs, DB objects, prose all
  // trip it). Show the precise classes by default; --all opens the firehose.
  const showAll = process.argv.includes('--all');
  const shown = res.findings.filter((f) => showAll || f.severity !== 'low');
  const counts = res.findings.reduce((a, f) => ({ ...a, [f.severity]: (a[f.severity] || 0) + 1 }), {});
  console.log(`findings: high=${counts.high || 0} medium=${counts.medium || 0} low=${counts.low || 0}` +
              (showAll ? '' : '   (low hidden — pass --all)'));
  if (!process.argv.includes('--quiet')) {
    const byFile = new Map();
    for (const f of shown) {
      if (!byFile.has(f.file)) byFile.set(f.file, []);
      byFile.get(f.file).push(f);
    }
    for (const [file, fs_] of byFile) {
      console.log(`\n${file}`);
      for (const f of fs_) console.log(`  L${f.line} [${f.severity}] ${f.kind}: ${f.anchor} — ${f.note}`);
    }
  }
  console.log(`\nstale anchors: ${shown.length} shown / ${res.findings.length} total`);
}
