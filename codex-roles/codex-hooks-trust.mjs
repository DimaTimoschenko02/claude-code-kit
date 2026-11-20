#!/usr/bin/env node
// Trusts the owner's own Codex hooks, so a changed hooks.json does not wait for a click in `/hooks` in every folder
// on every machine. Codex keeps the trust as `hooks.state.<key>.trusted_hash` in config.toml; the hash is computed by
// Codex itself: this script asks a `codex app-server` for `hooks/list` and writes back `currentHash` through
// `config/batchWrite`, the same two calls the TUI's `/hooks` makes.
//
// A hook is trusted only when the owner wrote it:
//   - the user hooks file, $CODEX_HOME/hooks.json;
//   - a project `.codex/hooks.json` that git tracks, has no uncommitted change, and whose last commit was made with
//     this machine's `git config user.email`;
//   - a project `.codex/hooks.json` outside any git repo, in a folder the owner marked `trust_level = "trusted"` in
//     Codex.
// A cloned foreign repo's hooks stay untrusted. Plugin and managed hooks are never touched.
//
// Projects come from Codex's `[projects.*]` and Claude's ~/.claude.json, plus every --cwd. A stamp of the hooks
// files' sizes and mtimes skips the app-server (≈1.5 s) when nothing changed in the last day.
//
//   codex-hooks-trust.mjs [--cwd <dir>]... [--dry-run] [--force]
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const extra = [];
let dryRun = false;
let force = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cwd' && args[i + 1]) extra.push(args[++i]);
  else if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--force') force = true;
  else {
    console.error('Usage: codex-hooks-trust.mjs [--cwd <dir>]... [--dry-run] [--force]');
    process.exit(2);
  }
}

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const USER_HOOKS = join(CODEX_HOME, 'hooks.json');
const STAMP = join(CODEX_HOME, 'hooks-trust.stamp.json');
const DAY = 24 * 60 * 60 * 1000;
const win = process.platform === 'win32';
const key = (path) => (win ? path.replaceAll('\\', '/').toLowerCase() : path);
const read = (file) => { try { return readFileSync(file, 'utf8'); } catch { return null; } };

// Codex project tables: `[projects.'C:\x']` (literal) or `[projects."/x"]` (basic string), each with its trust level.
function codexProjects() {
  const text = read(join(CODEX_HOME, 'config.toml')) ?? '';
  const out = [];
  const header = /^\[projects\.(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\][ \t]*$/gm;
  let m;
  while ((m = header.exec(text))) {
    const path = m[1] ?? JSON.parse(`"${m[2]}"`);
    const body = text.slice(header.lastIndex).split(/^\[/m)[0];
    out.push({ path, trusted: /^\s*trust_level\s*=\s*"trusted"\s*$/m.test(body) });
  }
  return out;
}

function claudeProjects() {
  try { return Object.keys(JSON.parse(read(join(homedir(), '.claude.json')) ?? '{}').projects ?? {}); } catch { return []; }
}

const codex = codexProjects();
const trustedFolders = new Set(codex.filter((p) => p.trusted).map((p) => key(resolve(p.path))));
const real = (file) => { try { return realpathSync(file); } catch { return null; } };
const userHooks = key(real(USER_HOOKS) ?? USER_HOOKS);
const projects = new Map();
for (const dir of [...codex.map((p) => p.path), ...claudeProjects(), ...extra]) {
  const file = real(join(resolve(dir), '.codex', 'hooks.json'));
  if (!file || key(file) === userHooks) continue;
  // Codex keys trust by the folder's spelling (`C:\Users` from a terminal, `c:\users` from an editor), so every
  // spelling seen gets listed and trusted.
  const entry = projects.get(key(file)) ?? { file, dirs: new Set([dirname(dirname(file))]) };
  entry.dirs.add(resolve(dir));
  projects.set(key(file), entry);
}

const files = [USER_HOOKS, ...[...projects.values()].map((p) => p.file)].filter(existsSync);
const stampOf = (list) => Object.fromEntries(list.map((f) => {
  const s = statSync(f);
  return [key(f), `${s.size}:${Math.round(s.mtimeMs)}`];
}));
const current = stampOf(files);
const previous = JSON.parse(read(STAMP) ?? '{}');
const fresh = Date.now() - (previous.at ?? 0) < DAY;
if (!force && !dryRun && fresh && JSON.stringify(previous.files) === JSON.stringify(current)) process.exit(0);

const git = (cwd, ...a) => {
  try { return execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); } catch { return null; }
};

// Why a hooks file may be trusted; `transient` marks a skip that a later commit resolves.
function verdict(file) {
  if (key(real(file) ?? file) === userHooks) return { ok: true, why: 'user hooks file' };
  const dir = dirname(dirname(file));
  const top = git(dir, 'rev-parse', '--show-toplevel');
  if (top === null) {
    return trustedFolders.has(key(dir))
      ? { ok: true, why: 'no git; folder trusted in Codex' }
      : { ok: false, why: 'no git and folder not trusted in Codex' };
  }
  if (!git(dir, 'ls-files', '--', '.codex/hooks.json')) return { ok: false, transient: true, why: 'not committed yet' };
  if (git(dir, 'status', '--porcelain', '--', '.codex/hooks.json')) return { ok: false, transient: true, why: 'uncommitted change' };
  const author = git(dir, 'log', '-1', '--format=%ae', '--', '.codex/hooks.json');
  const me = git(dir, 'config', 'user.email');
  return author && me && author.toLowerCase() === me.toLowerCase()
    ? { ok: true, why: 'last commit is yours' }
    : { ok: false, why: `last commit by someone else (${author ?? '?'})` };
}

function server() {
  const bin = process.env.CODEX_BIN || 'codex';
  const [cmd, argv] = /\.m?js$/.test(bin) ? [process.execPath, [bin, 'app-server']] : [bin, ['app-server']];
  const child = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'ignore'], shell: win && cmd === bin, windowsHide: true });
  const waits = new Map();
  let buf = '';
  let id = 0;
  child.stdin.on('error', () => { /* the exit handler reports it */ });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && waits.has(msg.id)) { waits.get(msg.id)(msg); waits.delete(msg.id); }
    }
  });
  const failAll = (why) => { for (const done of waits.values()) done({ error: { message: why } }); waits.clear(); };
  child.on('error', (e) => failAll(e.message));
  child.on('exit', () => failAll('app-server exited'));
  const timer = setTimeout(() => { child.kill(); failAll('timeout'); }, 30000);
  return {
    call(method, params) {
      return new Promise((done) => { const n = ++id; waits.set(n, done); child.stdin.write(`${JSON.stringify({ id: n, method, params })}\n`); });
    },
    notify(method) { child.stdin.write(`${JSON.stringify({ method })}\n`); },
    close() { clearTimeout(timer); child.stdin.end(); child.kill(); },
  };
}

const rpc = server();
const fail = (what, msg) => { rpc.close(); console.error(`codex-hooks-trust: ${what}: ${msg?.error?.message ?? 'no answer'}`); process.exit(1); };
const init = await rpc.call('initialize', { clientInfo: { name: 'codex-hooks-trust', version: '1.0.0' } });
if (init.error) fail('initialize', init);
rpc.notify('initialized');
const cwds = [homedir(), ...[...projects.values()].flatMap((p) => [...p.dirs])];
const listed = await rpc.call('hooks/list', { cwds });
if (listed.error) fail('hooks/list', listed);

const verdicts = new Map();
const updates = {};
const report = [];
for (const entry of listed.result?.data ?? []) {
  for (const hook of entry.hooks ?? []) {
    if (!['untrusted', 'modified'].includes(hook.trustStatus) || hook.isManaged || hook.pluginId) continue;
    if (!['user', 'project'].includes(hook.source) || updates[hook.key]) continue;
    const file = hook.sourcePath;
    if (!verdicts.has(key(file))) verdicts.set(key(file), verdict(file));
    const v = verdicts.get(key(file));
    report.push(`${v.ok ? (dryRun ? 'would trust' : 'trusted') : 'skipped'}: ${hook.key.replaceAll('\\', '/')} — ${v.why}`);
    if (v.ok) updates[hook.key] = { trusted_hash: hook.currentHash };
  }
}

if (Object.keys(updates).length && !dryRun) {
  const written = await rpc.call('config/batchWrite', {
    edits: [{ keyPath: 'hooks.state', value: updates, mergeStrategy: 'upsert' }],
    reloadUserConfig: true,
  });
  if (written.error) fail('config/batchWrite', written);
}
rpc.close();
for (const line of report) console.log(line);

if (!dryRun) {
  const transient = [...verdicts.entries()].filter(([, v]) => v.transient).map(([f]) => f);
  const settled = Object.fromEntries(Object.entries(current).filter(([f]) => !transient.includes(f)));
  try {
    mkdirSync(dirname(STAMP), { recursive: true });
    writeFileSync(STAMP, `${JSON.stringify({ at: transient.length ? 0 : Date.now(), files: settled })}\n`);
  } catch { /* the next run just repeats the check */ }
}
process.exit(0);
