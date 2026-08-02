#!/usr/bin/env node
// chat-audit :: discovery
//
// Finds, without guessing: where transcripts live, which sessions belong to this
// project, and what agent infrastructure the project already has.
//
// Nothing here is hardcoded to one machine. Config dirs, memory location and
// project->folder mapping are all detected, because every install differs:
// CLAUDE_CONFIG_DIR may point elsewhere, `projects/` may be a symlink to another
// account's dir, and memory lives in .claude/memory, a symlink into a vault, or
// inside the transcript dir — all of which occur in the wild.
//
// Usage:
//   node discover.mjs config   [--project <dir>]   # config dirs + memory + infra
//   node discover.mjs sessions [--project <dir>] [--scope exact|subtree|all]
//                              [--days N] [--limit N] [--grep <regex>]
//                              [--exclude <sessionId,...>] [--json]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();

// ---------------------------------------------------------------- config dirs

/** Every plausible Claude Code config dir on this machine, deduped by realpath. */
export function configDirs() {
  const cands = [];
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env) for (const p of env.split(/[:,]/)) if (p.trim()) cands.push(p.trim());
  cands.push(path.join(HOME, '.claude'));
  // Sibling configs (dual-account setups: ~/.claude-work, ~/.claude-personal, ...).
  try {
    for (const e of fs.readdirSync(HOME)) {
      if (/^\.claude[-_].+/.test(e)) cands.push(path.join(HOME, e));
    }
  } catch {}

  const seen = new Set();
  const out = [];
  for (const c of cands) {
    const projects = path.join(c, 'projects');
    if (!fs.existsSync(projects)) continue;
    let real;
    try { real = fs.realpathSync(projects); } catch { continue; }
    if (seen.has(real)) continue;   // ~/.claude-work/projects -> ~/.claude/projects
    seen.add(real);
    out.push({ configDir: c, projectsDir: projects, realProjectsDir: real });
  }
  return out;
}

// ------------------------------------------------------- project <-> folder

/** Claude Code's folder encoding: every non [A-Za-z0-9_-] char becomes '-'. */
export function encodeProjectPath(dir) {
  return dir.replace(/[^A-Za-z0-9_-]/g, '-');
}

/** Read the `cwd` a transcript folder actually belongs to (authoritative). */
function folderCwd(folder) {
  let files;
  try { files = fs.readdirSync(folder).filter((f) => f.endsWith('.jsonl')); } catch { return null; }
  for (const f of files.slice(0, 3)) {
    try {
      const fd = fs.openSync(path.join(folder, f), 'r');
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, 65536, 0);
      fs.closeSync(fd);
      for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
        if (!line.includes('"cwd"')) continue;
        try {
          const o = JSON.parse(line);
          if (o.cwd) return o.cwd;
        } catch {}
      }
    } catch {}
  }
  return null;
}

/**
 * Transcript folders belonging to a project.
 * scope: 'exact'   — only this dir
 *        'subtree' — this dir and anything under it (worktrees, sub-repos)
 *        'all'     — every folder on the machine
 */
export function projectFolders(projectDir, scope = 'subtree') {
  const target = path.resolve(projectDir);
  const out = [];
  for (const { projectsDir } of configDirs()) {
    let entries;
    try { entries = fs.readdirSync(projectsDir); } catch { continue; }
    for (const e of entries) {
      const folder = path.join(projectsDir, e);
      let st;
      try { st = fs.statSync(folder); } catch { continue; }
      if (!st.isDirectory()) continue;
      const cwd = folderCwd(folder);
      if (scope === 'all') { out.push({ folder, cwd }); continue; }
      if (!cwd) {
        // No readable cwd (empty folder) -> fall back to name encoding.
        if (e === encodeProjectPath(target)) out.push({ folder, cwd: target });
        continue;
      }
      const rel = path.relative(target, cwd);
      const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      if (scope === 'exact' ? cwd === target : inside) out.push({ folder, cwd });
    }
  }
  return out;
}

// ------------------------------------------------------------------ sessions

const META_MARKERS = ['"ai-title"', '"type":"user"', '"gitBranch"', '"agent-name"'];

/** Cheap per-session metadata: title, span, size, turn count, branch. */
export function sessionMeta(file) {
  const st = fs.statSync(file);
  let title = null, agentName = null, branch = null, cwd = null, version = null;
  let first = null, last = null, userTurns = 0, sidechains = 0;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line || line.length < 20) continue;
    if (!META_MARKERS.some((m) => line.includes(m))) {
      // still need timestamps for span; they appear on nearly every record
      if (!line.includes('"timestamp"')) continue;
    }
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.timestamp) { if (!first) first = o.timestamp; last = o.timestamp; }
    if (o.type === 'ai-title' && o.aiTitle) title = o.aiTitle;
    if (o.type === 'agent-name' && o.agentName) agentName = o.agentName;
    if (o.gitBranch && !branch) branch = o.gitBranch;
    if (o.cwd && !cwd) cwd = o.cwd;
    if (o.version && !version) version = o.version;
    if (o.type === 'user' && !o.isMeta) { if (o.isSidechain) sidechains++; else userTurns++; }
  }
  return {
    session: path.basename(file, '.jsonl'),
    file,
    title, agentName, branch, cwd, version,
    started: first, ended: last,
    bytes: st.size, mtime: st.mtime.toISOString(),
    userTurns, sidechainTurns: sidechains,
  };
}

export function listSessions(projectDir, opts = {}) {
  const { scope = 'subtree', days = null, limit = null, grep = null, exclude = [] } = opts;
  const excluded = new Set(exclude.filter(Boolean));
  const cutoff = days ? Date.now() - days * 86400000 : null;
  const rows = [];
  for (const { folder } of projectFolders(projectDir, scope)) {
    let files;
    try { files = fs.readdirSync(folder).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(folder, f);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (cutoff && st.mtime.getTime() < cutoff) continue;
      if (st.size < 2048) continue; // empty / aborted session
      if (excluded.has(path.basename(f, '.jsonl'))) continue;
      rows.push(file);
    }
  }
  let metas = rows.map((f) => { try { return sessionMeta(f); } catch { return null; } }).filter(Boolean);
  if (grep) {
    const re = new RegExp(grep, 'i');
    metas = metas.filter((m) => re.test(`${m.title || ''} ${m.branch || ''} ${m.agentName || ''}`));
  }
  metas.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return limit ? metas.slice(0, limit) : metas;
}

// --------------------------------------------------------- memory + infra

function countFiles(dir, ext = '.md') {
  let n = 0;
  const walk = (d, depth = 0) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(ext)) n++;
    }
  };
  walk(dir);
  return n;
}

/** Where this project keeps durable memory. Returns every candidate found. */
export function findMemory(projectDir) {
  const target = path.resolve(projectDir);
  const found = [];
  const consider = (p, kind) => {
    if (!p || !fs.existsSync(p)) return;
    let real = p, isLink = false;
    try {
      isLink = fs.lstatSync(p).isSymbolicLink();
      real = fs.realpathSync(p);
    } catch {}
    const files = countFiles(real);
    if (files === 0 && !fs.existsSync(path.join(real, 'MEMORY.md'))) return;
    found.push({ kind, path: p, realPath: real, symlink: isLink, mdFiles: files,
                 index: fs.existsSync(path.join(real, 'MEMORY.md')) ? path.join(real, 'MEMORY.md') : null });
  };

  consider(path.join(target, '.claude', 'memory'), 'project');
  consider(path.join(target, '.remember'), 'remember-plugin');
  for (const { projectsDir } of configDirs()) {
    consider(path.join(projectsDir, encodeProjectPath(target), 'memory'), 'transcript-dir');
  }
  consider(path.join(HOME, '.claude', 'memory'), 'global');
  return found;
}

/** Inventory of the agent-facing infrastructure already present. */
export function findInfra(projectDir) {
  const target = path.resolve(projectDir);
  const cdir = path.join(target, '.claude');
  const ls = (p, filter = () => true) => {
    try {
      return fs.readdirSync(p).filter((f) => !f.startsWith('.') && filter(f)).sort();
    } catch { return []; }
  };
  const instructionFiles = [];
  for (const p of [path.join(target, 'CLAUDE.md'), path.join(target, 'AGENTS.md'),
                   path.join(HOME, '.claude', 'CLAUDE.md')]) {
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      instructionFiles.push({
        path: p, lines: lines.length,
        headings: lines.filter((l) => /^#{1,3} /.test(l)).map((l) => l.replace(/^#+\s*/, '')),
      });
    }
  }
  let settingsHooks = {};
  const sPath = path.join(cdir, 'settings.json');
  if (fs.existsSync(sPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(sPath, 'utf8'));
      for (const [ev, arr] of Object.entries(s.hooks || {})) {
        settingsHooks[ev] = (arr || []).flatMap((g) =>
          (g.hooks || []).map((h) => `${g.matcher || '*'} :: ${(h.command || '').split('/').pop()}`));
      }
    } catch {}
  }
  return {
    projectDir: target,
    skills: ls(path.join(cdir, 'skills')),
    hooks: ls(path.join(cdir, 'hooks'), (f) => /\.(sh|py|mjs|js)$/.test(f)),
    agents: ls(path.join(cdir, 'agents')),
    rules: ls(path.join(cdir, 'rules')),
    commands: ls(path.join(cdir, 'commands')),
    globalSkills: ls(path.join(HOME, '.claude', 'skills')),
    instructionFiles,
    settingsHooks,
    memory: findMemory(target),
  };
}

// ---------------------------------------------------------------------- CLI

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  const project = path.resolve(arg('project', process.cwd()));
  if (cmd === 'config') {
    const out = { configDirs: configDirs(), infra: findInfra(project) };
    console.log(JSON.stringify(out, null, 2));
  } else if (cmd === 'sessions') {
    const metas = listSessions(project, {
      scope: arg('scope', 'subtree'),
      days: arg('days') ? Number(arg('days')) : null,
      limit: arg('limit') ? Number(arg('limit')) : null,
      grep: arg('grep'),
      // The session running the audit is still being written and contains the
      // skill's own instructions — auditing it finds "problems" in the audit.
      exclude: (arg('exclude', '') || '').split(',').map((s) => s.trim()),
    });
    if (process.argv.includes('--json')) { console.log(JSON.stringify(metas, null, 2)); }
    else {
      const mb = (b) => (b / 1048576).toFixed(1) + 'M';
      console.log(`sessions: ${metas.length}  total: ${mb(metas.reduce((a, m) => a + m.bytes, 0))}\n`);
      for (const m of metas) {
        console.log(`${(m.started || '').slice(0, 16).replace('T', ' ')}  ${mb(m.bytes).padStart(6)}  ` +
          `turns=${String(m.userTurns).padStart(3)}  ${m.session.slice(0, 8)}  ${m.title || '(no title)'}` +
          `${m.branch && m.branch !== 'main' ? '  [' + m.branch + ']' : ''}`);
      }
    }
  } else {
    console.error('sessions [--exclude <sessionId>] · usage: discover.mjs config|sessions [--project dir] [--scope exact|subtree|all] [--days N] [--limit N] [--grep re] [--json]');
    process.exit(1);
  }
}
