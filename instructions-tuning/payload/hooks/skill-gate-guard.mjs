#!/usr/bin/env node
// PreToolUse(Write|Edit|Bash) — skill-gate, the same gate as skill-gate-guard.sh, in one node process.
//
// Why a second implementation: on Windows (Git Bash) every fork costs ≈0.5 s under load, and the bash gate forks jq a
// dozen times per call, so every Write/Edit/Bash waited 1.5–10 s. This file is a line-for-line port: same config, same
// boundary (later of session start and the last /compact), same compaction re-attachment and subagent rules, same deny
// text and exit 2. Bash targets still come from _lib/bash-write-targets.py (one python start, Bash calls only).
// skill-gate-guard.sh stays the reference: a rule change lands in both. Tests run both:
//   python3 -B -m unittest discover -s instructions-tuning/test   (SKILL_GATE_IMPL=node runs this file)
//
// Use: `node skill-gate-guard.mjs` as the hook command, or import { skillGate } from a project's own dispatcher.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Context-reset boundary: last /compact, else the first top-level timestamp. '' when unknown. */
function boundaryOf(text) {
  let boundary = '';
  for (const line of lines(text)) {
    if (!line.includes('isCompactSummary')) continue;
    const e = parse(line);
    if (e?.isCompactSummary === true && e.timestamp != null) boundary = String(e.timestamp);
  }
  if (boundary) return boundary;
  for (const line of lines(text).slice(0, 100)) {
    const e = parse(line);
    if (e && e.timestamp != null) return String(e.timestamp);
  }
  return '';
}

/** Skills Claude Code re-attached whole after the last compaction. */
function restoredSkills(text) {
  let compactLine = 0;
  let skillsLine = 0;
  let skillsText = '';
  lines(text).forEach((line, i) => {
    if (line.includes('"isCompactSummary":true')) compactLine = i + 1;
    if (line.includes('"type":"invoked_skills"')) {
      skillsLine = i + 1;
      skillsText = line;
    }
  });
  if (!compactLine || !skillsLine || skillsLine <= compactLine) return [];
  const skills = parse(skillsText)?.attachment?.skills;
  return Array.isArray(skills) ? skills.filter((s) => String(s?.content ?? '').length < 20000).map((s) => String(s.name)) : [];
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

  const text = transcript ? readText(transcript) : null;
  const boundary = text === null ? '' : boundaryOf(text);
  if (!boundary) return null; // can't locate boundary -> fail-open
  const restored = restoredSkills(text);

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

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  let verdict = null;
  try {
    verdict = skillGate(payload ?? {});
  } catch {
    verdict = null; // fail-open, as the bash gate
  }
  if (verdict?.deny) {
    process.stderr.write(verdict.deny);
    process.exit(2);
  }
}
