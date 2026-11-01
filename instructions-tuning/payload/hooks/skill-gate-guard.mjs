#!/usr/bin/env node
// PreToolUse(Write|Edit|Bash) — skill-gate, the same gate as skill-gate-guard.sh, in one node process.
//
// Why a second implementation: on Windows (Git Bash) every fork costs ≈0.5 s under load, and the bash gate forks jq a
// dozen times per call, so every Write/Edit/Bash waited 1.5–10 s. This file is a line-for-line port: same config, same
// boundary (later of session start and the last /compact), same compaction re-attachment and subagent rules, same deny
// text and exit 2. Bash targets still come from _lib/bash-write-targets.py (one python start, Bash calls only).
// The transcript is read line by line in 1 MB chunks and only marker lines are parsed: a late session's transcript is
// 10–50 MB, and reading it whole cost about three times its size in memory on every governed write.
// skill-gate-guard.sh stays the reference: a rule change lands in both. Tests run both:
//   python3 -B -m unittest discover -s instructions-tuning/test   (SKILL_GATE_IMPL=node runs this file)
//
// Use: the install.sh --link shim runs this file whenever node is on PATH (measured 01.11 on Windows under load: 0.4–0.7 s
// a call against 14–31 s for the bash gate), else the bash gate; or import { skillGate } from a project's own dispatcher.
// SKILL_GATE_LOG (the project's hook-log.sh) -> its twin hook-log.mjs beside it writes the decision line.
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '_lib');

/** One spelling for `C:\x`, `C:/x` and `/c/x` (what cygpath -m gives); other paths unchanged. */
export function winPath(p) {
  if (!p || process.platform !== 'win32') return p ?? '';
  let s = String(p).replace(/\\/g, '/');
  const m = /^\/([a-zA-Z])(\/|$)/.exec(s);
  if (m) s = `${m[1].toUpperCase()}:/${s.slice(3)}`;
  return s.replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);
}

const lines = (text) => String(text ?? '').split('\n');
const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};
const readText = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** A real python: the Microsoft Store stub in WindowsApps prints an install hint instead of running. */
function pythonExe(env) {
  if (env.CODEX_COMPAT_PYTHON) return env.CODEX_COMPAT_PYTHON;
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const name of ['python3', 'python']) {
    for (const dir of String(env.PATH ?? '').split(delimiter)) {
      if (!dir || /[\\/]WindowsApps([\\/]|$)/i.test(dir)) continue;
      for (const ext of exts) {
        const p = join(dir, name + ext);
        try {
          if (statSync(p).isFile()) return p;
        } catch {
          // next
        }
      }
    }
  }
  return null;
}

function bashTargets(command, cwd, env) {
  const py = pythonExe(env);
  if (!py || !command) return '';
  try {
    return execFileSync(py, ['-B', join(LIB, 'bash-write-targets.py'), cwd], { input: command, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** Which skill owns a project-relative path: first matching gate wins. */
function owner(gates, rel) {
  for (const g of gates) {
    const p = g?.path_prefix ?? null;
    const e = g?.path_exact ?? null;
    if ((p !== null && rel.startsWith(p)) || (e !== null && rel === e)) return g.skill ?? '';
  }
  return '';
}

/** A subagent's own transcript (the payload's transcript_path is the parent's), or '' when not found. */
function subagentTranscript(payload, transcript, aid) {
  const own = payload.agent_transcript_path ? winPath(payload.agent_transcript_path) : '';
  if (own && existsSync(own)) return own;
  if (new RegExp(`/subagents/.*agent-${aid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.jsonl$`).test(transcript)) return existsSync(transcript) ? transcript : '';
  if (!transcript || !payload.session_id) return '';
  let projDir = dirname(transcript);
  if (transcript.includes('/subagents/')) projDir = dirname(transcript.slice(0, transcript.indexOf('/subagents/')));
  const sub = join(projDir, payload.session_id, 'subagents');
  const want = `agent-${aid}.jsonl`;
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return '';
    }
    for (const d of names) {
      const p = join(dir, d.name);
      if (d.isFile() && d.name === want) return p;
      if (d.isDirectory()) {
        const hit = walk(p);
        if (hit) return hit;
      }
    }
    return '';
  };
  return walk(sub);
}

const COMPACT_ANY = Buffer.from('isCompactSummary');
const COMPACT_TRUE = Buffer.from('"isCompactSummary":true');
const INVOKED_SKILLS = Buffer.from('"type":"invoked_skills"');
const TIMESTAMP = Buffer.from('"timestamp"');
const CHUNK = 1 << 20;

/** Calls `onLine(buffer, index)` for every line of the file, 1 MB at a time: memory is the chunk plus the longest line,
 * not the file — a late-session transcript is 10–50 MB and the gate reads it on every governed write. false = unreadable. */
function eachLine(path, onLine) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return false;
  }
  try {
    const chunk = Buffer.allocUnsafe(CHUNK);
    let carry = null;
    let index = 0;
    for (;;) {
      const n = readSync(fd, chunk, 0, CHUNK, null);
      if (n <= 0) break;
      const data = carry ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      let start = 0;
      for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
        onLine(data.subarray(start, nl), index++);
        start = nl + 1;
      }
      carry = start < data.length ? Buffer.from(data.subarray(start)) : null;
    }
    if (carry) onLine(carry, index);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * One pass over the transcript: the context-reset boundary (last /compact, else the first top-level timestamp in the
 * first 100 lines; '' when unknown) and the skills Claude Code re-attached whole after the last compaction. Only lines
 * holding a marker are decoded and parsed. null = transcript unreadable.
 */
function scanTranscript(path) {
  let compactTs = '';
  let firstTs = '';
  let compactLine = 0;
  let skillsLine = 0;
  let skillsText = '';
  const ok = eachLine(path, (line, i) => {
    if (!firstTs && i < 100 && line.includes(TIMESTAMP)) {
      const e = parse(line.toString('utf8'));
      if (e && e.timestamp != null) firstTs = String(e.timestamp);
    }
    if (line.includes(COMPACT_ANY)) {
      if (line.includes(COMPACT_TRUE)) compactLine = i + 1;
      const e = parse(line.toString('utf8'));
      if (e?.isCompactSummary === true && e.timestamp != null) compactTs = String(e.timestamp);
    }
    if (line.includes(INVOKED_SKILLS)) {
      skillsLine = i + 1;
      skillsText = line.toString('utf8');
    }
  });
  if (!ok) return null;
  let restored = [];
  if (compactLine && skillsLine && skillsLine > compactLine) {
    const skills = parse(skillsText)?.attachment?.skills;
    if (Array.isArray(skills)) restored = skills.filter((s) => String(s?.content ?? '').length < 20000).map((s) => String(s.name));
  }
  return { boundary: compactTs || firstTs, restored };
}

/** `skills:` of the subagent definition named `name` — project agents first, then the user's. */
function preloadedSkills(name, dirs) {
  for (const dir of dirs) {
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const text = (readText(join(dir, f)) ?? '').replace(/\r\n?/g, '\n'); // python reads with universal newlines
      const m = /^---\n([\s\S]*?)\n---/.exec(text);
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!m || !new RegExp(`^name:\\s*['"]?${esc}['"]?\\s*$`, 'm').test(m[1])) continue;
      const out = [];
      let inList = false;
      for (const line of m[1].split('\n')) {
        if (inList) {
          const item = /^\s+-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line);
          if (item) {
            out.push(item[1]);
            continue;
          }
          inList = false;
        }
        const head = /^skills:\s*(.*)$/.exec(line);
        if (head) {
          const rest = head[1].trim().replace(/^\[+|\]+$/g, '');
          if (rest) out.push(...rest.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^['"]+|['"]+$/g, '')));
          else inList = true;
        }
      }
      return out;
    }
  }
  return [];
}

const matchesSkill = (names, s) => names.some((n) => n === s || (n.endsWith(`:${s}`) && !n.slice(0, -s.length - 1).includes(':')));

/**
 * The gate's verdict on one PreToolUse payload: null = pass, { deny } = the stderr text to block with (exit 2).
 * `log(decision, reason)` receives what the bash gate's hook_log received.
 */
export function skillGate(payload, { env = process.env, home = env.HOME || homedir(), log = () => {} } = {}) {
  if (env.CCLL_INACTIVE) return null;
  let transcript = winPath(payload.transcript_path ?? '');
  const cwd = winPath(payload.cwd ?? '');
  const tool = payload.tool_name ?? '';
  const root = winPath(env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd());

  const config = parse(readText(join(root, '.claude/skill-gate.config.json')) ?? '');
  if (!config) return null; // no gates configured (or unreadable) -> fail-open
  const gates = Array.isArray(config.gates) ? config.gates : [];

  if (tool === 'Bash' && !pythonExe(env)) log('skip', 'no python'); // Bash targets unknown: ungated, but on the record
  const targets = tool === 'Bash'
    ? bashTargets(payload.tool_input?.command ?? '', cwd || root, env)
    : String(payload.tool_input?.file_path ?? '');
  if (!targets) return null;

  const gated = [];
  for (const raw of lines(targets)) {
    if (!raw) continue;
    const fp = winPath(raw.replace(/\r$/, ''));
    let rel = fp.startsWith(`${root}/`) ? fp.slice(root.length + 1) : fp;
    // A worktree (`.claude/worktrees/<name>/`) is another checkout of the same repo: its files are governed alike.
    rel = rel.replace(/^.*?\.claude\/worktrees\/[^]*?\//, '');
    const s = owner(gates, rel);
    if (s) gated.push([s, rel]);
  }
  if (!gated.length) return null;
  log('pass');

  const invocationLog = readText(join(root, '.claude/state/skill-invocations.jsonl'));
  if (invocationLog === null) return null; // logger hasn't written yet -> fail-open

  const aid = String(payload.agent_id ?? '');
  if (aid) {
    const own = subagentTranscript(payload, transcript, aid);
    if (!own) {
      log('skip', 'no subagent transcript');
      return null;
    }
    transcript = own;
  }

  const scan = transcript ? scanTranscript(transcript) : null;
  const boundary = scan?.boundary ?? '';
  if (!boundary) return null; // can't locate boundary -> fail-open
  const { restored } = scan;

  const atype = String(payload.agent_type ?? '');
  const preloaded = env.CODEX_COMPAT !== '1' && aid && atype
    ? preloadedSkills(atype, [join(root, '.claude/agents'), join(home, '.claude/agents')])
    : [];

  const sid = String(payload.session_id ?? '');
  const records = lines(invocationLog).map(parse).filter(Boolean);
  for (const [s, rel] of gated) {
    if (matchesSkill(restored, s) || matchesSkill(preloaded, s)) continue;
    let invoked = '';
    for (const r of records) {
      const skill = String(r.skill ?? '');
      if (skill !== s && !skill.endsWith(`:${s}`)) continue;
      if (!(sid === '' || (r.session_id ?? '') === '' || r.session_id === sid)) continue;
      if ((r.agent_id ?? '') !== aid) continue;
      if (r.ts != null) invoked = String(r.ts);
    }
    if (invoked && invoked >= boundary) continue;
    log('deny', s);
    return {
      deny: `🚧 skill-gate: "${rel}" belongs to skill ${s}, not loaded since the last context reset (session start or /compact).\n`
        + `Next call: Skill with skill: "${s}" — exactly this bare name, no "<dir>:" prefix. Then repeat this same call unchanged.\n`,
    };
  }
  return null;
}

/**
 * The project's decision log, as the bash gate sources it: SKILL_GATE_LOG names the project's hook-log.sh, its JS twin
 * hook-log.mjs sits beside it. No log -> a no-op state.
 */
async function projectLog(env) {
  const state = { input: {}, decision: '', reason: '' };
  const sh = env.SKILL_GATE_LOG ?? '';
  const mjs = sh.replace(/\.sh$/, '.mjs');
  if (!sh || mjs === sh || !existsSync(mjs)) return state;
  try {
    return (await import(pathToFileURL(mjs).href)).hookLog(import.meta.url, state);
  } catch {
    return state;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const state = await projectLog(process.env);
  let payload = null;
  try {
    // jq in the bash gate skips a UTF-8 BOM; JSON.parse does not, so a BOM would fail open here.
    payload = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, ''));
  } catch {
    process.exit(0);
  }
  state.input = payload ?? {};
  const log = (decision, reason = '') => {
    state.decision = decision;
    state.reason = reason;
  };
  let verdict = null;
  try {
    verdict = skillGate(payload ?? {}, { log });
  } catch {
    verdict = null; // fail-open, as the bash gate
  }
  if (verdict?.deny) {
    process.stderr.write(verdict.deny);
    process.exit(2);
  }
}
