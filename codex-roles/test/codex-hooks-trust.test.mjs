import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'codex-hooks-trust.mjs');

// A stand-in `codex app-server`: answers initialize, hooks/list from FAKE_HOOKS, and logs every request to FAKE_LOG.
const FAKE = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const hooks = JSON.parse(process.env.FAKE_HOOKS);
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  appendFileSync(process.env.FAKE_LOG, line + '\\n');
  if (msg.id == null) return;
  const result = msg.method === 'hooks/list'
    ? { data: msg.params.cwds.map((cwd) => ({ cwd, hooks: hooks.filter((h) => h.cwd === undefined || h.cwd === cwd), errors: [], warnings: [] })) }
    : {};
  process.stdout.write(JSON.stringify({ id: msg.id, result }) + '\\n');
});
`;

const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

function world(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-hooks-trust-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const codexHome = join(home, '.codex');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'hooks.json'), '{"hooks":{}}\n');
  const fake = join(root, 'fake-app-server.mjs');
  writeFileSync(fake, FAKE);
  const project = (name, { email, dirty, git: inGit = true } = {}) => {
    const dir = join(root, name);
    mkdirSync(join(dir, '.codex'), { recursive: true });
    writeFileSync(join(dir, '.codex', 'hooks.json'), '{"hooks":{}}\n');
    if (inGit) {
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.email', 'owner@example.com');
      git(dir, 'config', 'user.name', 'owner');
      git(dir, 'add', '.');
      git(dir, '-c', `user.email=${email ?? 'owner@example.com'}`, 'commit', '-q', '-m', 'hooks');
      if (dirty) writeFileSync(join(dir, '.codex', 'hooks.json'), '{"hooks":{"Stop":[]}}\n');
    }
    return dir;
  };
  const configure = ({ codexProjects = [], claudeProjects = [] }) => {
    writeFileSync(join(codexHome, 'config.toml'), codexProjects
      .map(([dir, trust]) => `[projects.'${dir}']\ntrust_level = "${trust}"\n`).join('\n'));
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: Object.fromEntries(claudeProjects.map((d) => [d, {}])) }));
  };
  const hook = (file, event, status = 'untrusted', extra = {}) => ({
    key: `${file}:${event}:0:0`, sourcePath: file, source: 'project', trustStatus: status,
    currentHash: `sha256:${event}`, isManaged: false, ...extra,
  });
  const log = join(root, 'requests.jsonl');
  const run = (hooks, ...args) => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, CODEX_BIN: fake, FAKE_HOOKS: JSON.stringify(hooks), FAKE_LOG: log },
    });
    let requests = [];
    try { requests = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { /* none */ }
    rmSync(log, { force: true });
    return { ...result, requests, written: requests.find((r) => r.method === 'config/batchWrite')?.params };
  };
  return { root, home, codexHome, project, configure, hook, run };
}

await test('trusts the user hooks file and hooks the owner committed, never a foreign or uncommitted one', (t) => {
  const w = world(t);
  const own = w.project('own');
  const foreign = w.project('foreign', { email: 'stranger@example.com' });
  const dirty = w.project('dirty', { dirty: true });
  w.configure({ claudeProjects: [own, foreign, dirty] });
  const userHook = { ...w.hook(join(w.codexHome, 'hooks.json'), 'session_start', 'modified'), source: 'user' };
  const hooks = [
    userHook,
    w.hook(join(own, '.codex', 'hooks.json'), 'pre_tool_use'),
    w.hook(join(own, '.codex', 'hooks.json'), 'stop', 'trusted'),
    w.hook(join(foreign, '.codex', 'hooks.json'), 'pre_tool_use'),
    w.hook(join(dirty, '.codex', 'hooks.json'), 'pre_tool_use'),
    w.hook(join(own, '.codex', 'hooks.json'), 'post_tool_use', 'untrusted', { pluginId: 'some-plugin' }),
    w.hook(join(own, '.codex', 'hooks.json'), 'session_end', 'untrusted', { isManaged: true }),
  ];
  const result = w.run(hooks);
  assert.equal(result.status, 0, result.stderr);
  const list = result.requests.find((r) => r.method === 'hooks/list');
  assert.ok(list.params.cwds.includes(own) && list.params.cwds.includes(foreign));
  assert.deepEqual(result.written.edits[0].keyPath, 'hooks.state');
  assert.deepEqual(result.written.edits[0].value, {
    [userHook.key]: { trusted_hash: 'sha256:session_start' },
    [hooks[1].key]: { trusted_hash: 'sha256:pre_tool_use' },
  });
  assert.match(result.stdout, /skipped: .*foreign.* — last commit by someone else/);
  assert.match(result.stdout, /skipped: .*dirty.* — uncommitted change/);
});

await test('a folder outside git is trusted only when Codex marks it trusted', (t) => {
  const w = world(t);
  const trusted = w.project('plain-trusted', { git: false });
  const untrusted = w.project('plain-untrusted', { git: false });
  w.configure({ codexProjects: [[trusted, 'trusted'], [untrusted, 'untrusted']] });
  const hooks = [w.hook(join(trusted, '.codex', 'hooks.json'), 'pre_tool_use'), w.hook(join(untrusted, '.codex', 'hooks.json'), 'pre_tool_use')];
  const result = w.run(hooks);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(result.written.edits[0].value), [hooks[0].key]);
  assert.match(result.stdout, /skipped: .*plain-untrusted.* — no git and folder not trusted in Codex/);
});

await test('a project reached by two paths gets a trust key under each, as Codex looks them up by spelling', (t) => {
  const w = world(t);
  const own = w.project('own');
  const link = join(w.root, 'own-link');
  symlinkSync(own, link, 'junction');
  w.configure({ claudeProjects: [own, link] });
  const hooks = [w.hook(join(own, '.codex', 'hooks.json'), 'pre_tool_use'), w.hook(join(link, '.codex', 'hooks.json'), 'pre_tool_use')];
  hooks[0].cwd = own;
  hooks[1].cwd = link;
  const result = w.run(hooks);
  const cwds = result.requests.find((r) => r.method === 'hooks/list').params.cwds;
  assert.deepEqual(cwds.filter((c) => c === own || c === link).sort(), [link, own].sort());
  assert.deepEqual(Object.keys(result.written.edits[0].value).sort(), hooks.map((h) => h.key).sort());
});

await test('an unchanged set of hooks files skips the app-server; --dry-run writes nothing', (t) => {
  const w = world(t);
  const own = w.project('own');
  w.configure({ claudeProjects: [own] });
  const hooks = [w.hook(join(own, '.codex', 'hooks.json'), 'pre_tool_use')];
  const dry = w.run(hooks, '--dry-run');
  assert.equal(dry.written, undefined);
  assert.match(dry.stdout, /would trust: .*own/);
  assert.equal(w.run(hooks).requests.length > 0, true, 'first real run asks the app-server');
  assert.equal(w.run(hooks).requests.length, 0, 'second run is stamped');
  appendFileSync(join(own, '.codex', 'hooks.json'), ' ');
  git(own, 'commit', '-q', '-am', 'change hooks');
  assert.ok(w.run(hooks).requests.length > 0, 'a changed hooks file asks again');
  assert.ok(w.run(hooks, '--force').requests.length > 0);
});

await test('an uncommitted hooks file keeps the stamp open until it is committed', (t) => {
  const w = world(t);
  const dirty = w.project('dirty', { dirty: true });
  w.configure({ claudeProjects: [dirty] });
  const hooks = [w.hook(join(dirty, '.codex', 'hooks.json'), 'pre_tool_use')];
  assert.equal(w.run(hooks).written, undefined);
  git(dirty, 'commit', '-q', '-am', 'commit hooks');
  const after = w.run(hooks);
  assert.deepEqual(Object.keys(after.written.edits[0].value), [hooks[0].key]);
});

await test('a missing or failing app-server never fails the caller badly', (t) => {
  const w = world(t);
  const own = w.project('own');
  w.configure({ claudeProjects: [own] });
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, HOME: w.home, USERPROFILE: w.home, CODEX_HOME: w.codexHome, CODEX_BIN: join(w.root, 'nope.mjs') },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /codex-hooks-trust: initialize/);
});
