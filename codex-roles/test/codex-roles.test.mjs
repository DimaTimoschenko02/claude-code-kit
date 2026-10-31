// Build real roles in disposable repositories, including a worktree that shares the main checkout's catalogs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../codex-roles', import.meta.url));
const ROLE = 'fixture-reader';
const forward = (path) => path.replaceAll('\\', '/');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const run = (root, ...args) => spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], {
  cwd: root, encoding: 'utf8',
});

function fixture(t) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'codex-roles-test-')));
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = join(temp, 'main');
  for (const dir of ['bin', '.codex/roles.d', '.claude/agents', '.claude/memory']) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(SCRIPT, join(root, 'bin/codex-roles'));
  writeFileSync(join(root, '.claude/agents', `${ROLE}.md`), [
    '---', `name: ${ROLE}`, 'description: Reads facts.', 'model: sonnet', 'effort: low', 'tools: Read, Grep',
    'skills:', '  - fixture-skill', 'memory: project', '---', '', 'You read.', '',
  ].join('\n'));
  writeFileSync(join(root, '.codex/roles.d', `${ROLE}.pre.md`), 'Checkout: {ROOT}\nShared: {MAIN}\n');
  writeFileSync(join(root, '.claude/memory/MEMORY.md'), '# Shared memory\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Codex Roles Test');
  git(root, 'config', 'user.email', 'codex-roles@example.test');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', 'bin', '.claude', '.codex');
  git(root, 'commit', '-q', '-m', 'Seed role fixture');
  return { root, temp };
}

function readRole(root) {
  const path = join(root, '.codex/agents', `${ROLE}.toml`);
  assert.equal(existsSync(path), true);
  return readFileSync(path, 'utf8');
}

function assertSharedPaths(text, main) {
  const shared = forward(main);
  for (const path of [
    '.claude/memory/MEMORY.md', '.claude/skills/fixture-skill/SKILL.md',
    `.claude/agent-memory/${ROLE}/MEMORY.md`,
  ]) assert.ok(text.includes(`\`${shared}/${path}\``), `Missing shared path: ${path}`);
  assert.ok(text.includes(`Shared: ${shared}\n`));
  assert.doesNotMatch(text, /\\/);
  assert.match(text, /^# Converted from \.claude\/agents\/fixture-reader\.md$/m);
}

await test('main checkout builds portable paths for memory, skills and the role catalog', (t) => {
  const { root } = fixture(t);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const text = readRole(root);
  assertSharedPaths(text, root);
  assert.ok(text.includes(`Checkout: ${forward(root)}\n`));
  assert.match(text, /# Role contract \(source body\)\n\nYou read\.\n'''\n$/);
  assert.doesNotMatch(text, /^Read-only role:/m);
  const check = run(root, '--check');
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout, '');
});

await test('--check lists a missing role without creating the output directory', (t) => {
  const { root } = fixture(t);
  const result = run(root, '--check');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout.trim(), `stale: ${ROLE} (new)`);
  assert.equal(existsSync(join(root, '.codex/agents')), false);
});

await test('worktree roles use main checkout catalogs and retain their own ROOT placeholder', (t) => {
  const { root, temp } = fixture(t);
  const worktree = join(temp, 'worktree');
  git(root, 'worktree', 'add', '-q', '-b', 'role-worktree', worktree);
  const result = run(worktree);
  assert.equal(result.status, 0, result.stderr);
  const text = readRole(worktree);
  assertSharedPaths(text, root);
  assert.ok(text.includes(`Checkout: ${forward(worktree)}\n`));
  assert.equal(text.replace(`Checkout: ${forward(worktree)}\n`, '').includes(forward(worktree)), false);
});

await test('--root builds the requested project from an unrelated cwd', (t) => {
  const { root, temp } = fixture(t);
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root], { cwd: temp, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assertSharedPaths(readRole(root), root);
  assert.equal(existsSync(join(temp, '.codex')), false);
});

await test('without --root the project is selected by cwd, not the script location', (t) => {
  const { root } = fixture(t);
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assertSharedPaths(readRole(root), root);
});

await test('a linked .claude resolves to the real repo and produces identical bytes', (t) => {
  const { root, temp } = fixture(t);
  assert.equal(run(root).status, 0);
  const before = readRole(root);
  const parent = join(temp, 'parent');
  mkdirSync(parent);
  symlinkSync(join(root, '.claude'), join(parent, '.claude'), 'junction');
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: parent, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(readRole(root), before);
  assert.equal(existsSync(join(parent, '.codex')), false);
});

await test('missing .claude or agents reports the project and exits 2', (t) => {
  const { temp } = fixture(t);
  for (const hasClaude of [false, true]) {
    if (hasClaude) mkdirSync(join(temp, '.claude'));
    const result = run(temp, '--check');
    assert.equal(result.status, 2);
    assert.equal(result.stderr.trim(), `codex-roles: no .claude/agents under ${forward(temp)}`);
    assert.equal(result.stdout, '');
  }
});

await test('CRLF and LF generate identical role text while hashing the original bytes', (t) => {
  const { root } = fixture(t);
  const source = join(root, '.claude/agents', `${ROLE}.md`);
  const lf = readFileSync(source, 'utf8');
  assert.equal(run(root).status, 0);
  const before = readRole(root);
  const crlf = lf.replaceAll('\n', '\r\n');
  writeFileSync(source, crlf);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const after = readRole(root);
  const withoutHash = (text) => text.replace(/^# Source SHA-256: .*\n/m, '');
  assert.equal(withoutHash(after), withoutHash(before));
  assert.ok(after.includes(`# Source SHA-256: ${createHash('sha256').update(crlf).digest('hex')}`));
  assert.notEqual(after, before);
});

await test('folded descriptions join three indented lines and literal blocks keep newlines', (t) => {
  const { root } = fixture(t);
  const source = join(root, '.claude/agents', `${ROLE}.md`);
  const original = readFileSync(source, 'utf8');
  for (const marker of ['>', '>-', '>+', '|', '|-', '|+']) {
    writeFileSync(source, original.replace('description: Reads facts.', `description: ${marker}\n  Reads facts.\n  Checks evidence.\n  Reports findings.`));
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    const expected = ['Reads facts.', 'Checks evidence.', 'Reports findings.'].join(marker[0] === '>' ? ' ' : '\n');
    assert.ok(readRole(root).includes(`description = ${JSON.stringify(expected)}\n`));
  }
});

await test('matching scalar and list-item quotes are removed once', (t) => {
  const { root } = fixture(t);
  const source = join(root, '.claude/agents', `${ROLE}.md`);
  const original = readFileSync(source, 'utf8');
  for (const quote of ['"', "'"]) {
    writeFileSync(source, original
      .replace(`name: ${ROLE}`, `name: ${quote}${ROLE}${quote}`)
      .replace('description: Reads facts.', `description: ${quote}Reads facts.${quote}`)
      .replace('  - fixture-skill', `  - ${quote}fixture-skill${quote}`));
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(readRole(root).includes('description = "Reads facts."\n'));
    assertSharedPaths(readRole(root), root);
  }
});

await test('the generic preamble only refers to a shared memory index when one exists', (t) => {
  const { root } = fixture(t);
  assert.equal(run(root).status, 0);
  const before = readRole(root);
  assert.match(before, /Preserve the same memory files; do not create a second Codex memory store\./);
  rmSync(join(root, '.claude/memory/MEMORY.md'));
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const after = readRole(root);
  assert.match(after, /Read its CLAUDE\.md and applicable \.claude\/rules before domain work\./);
  assert.doesNotMatch(after, /shared memory index|Preserve the same memory files/);
  assert.ok(after.includes(`(when Codex runs from a folder above the repo, the repo is \`${forward(root)}\`)`));
});

await test('disallowedTools adds the forbidden capability contract immediately after allowed capabilities', (t) => {
  const { root } = fixture(t);
  const source = join(root, '.claude/agents', `${ROLE}.md`);
  writeFileSync(source, readFileSync(source, 'utf8').replace('tools: Read, Grep', 'tools: Read, Grep\ndisallowedTools: "mcp__server, Write"'));
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readRole(root), /Source allowed capabilities: [^\n]+\n\nSource forbidden capabilities: `mcp__server, Write`\. Never use them or their native equivalents, even though Codex inherits them from the parent\./);
});

await test('invalid agents are both named and skipped while a good role is still written', (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, '.claude/agents/a-no-name.md'), '---\ndescription: Missing name.\n---\nBody.\n');
  writeFileSync(join(root, '.claude/agents/b-quotes.md'), "---\nname: quotes\n---\nBody holds '''.\n");
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skipped: a-no-name\.md — missing frontmatter name/);
  assert.match(result.stderr, /skipped: b-quotes\.md — the body holds three single quotes/);
  assert.equal(result.stdout.trim(), `written: ${ROLE} (new)`);
  assertSharedPaths(readRole(root), root);
  assert.equal(existsSync(join(root, '.codex/agents/quotes.toml')), false);
});

await test('read-only roles retain their restrictions when no memory is allowed', (t) => {
  const { root } = fixture(t);
  const source = join(root, '.claude/agents', `${ROLE}.md`);
  writeFileSync(source, readFileSync(source, 'utf8').replace('memory: project\n', ''));
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readRole(root), /^Read-only role:/m);
});

await test('doubled drives and backslash drive paths in extras fail before writing or comparing', (t) => {
  const { root } = fixture(t);
  for (const path of ['C:C:/x', 'C:\\x']) {
    writeFileSync(join(root, '.codex/roles.d', `${ROLE}.pre.md`), `Bad: \`${path}\`\n`);
    for (const args of [[], ['--check']]) {
      const result = run(root, ...args);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(`bad path: ${ROLE} — ${path.slice(0, path === 'C:C:/x' ? 4 : 3)}`));
      assert.equal(result.stdout, '');
      assert.equal(existsSync(join(root, '.codex/agents', `${ROLE}.toml`)), false);
    }
  }
});

await test('a backticked Unix home path fails only on Windows', (t) => {
  const { root } = fixture(t);
  for (const path of ['/home/x']) {
    writeFileSync(join(root, '.codex/roles.d', `${ROLE}.pre.md`), `Bad: \`${path}\`\n`);
    const result = run(root);
    assert.equal(result.status, process.platform === 'win32' ? 1 : 0, result.stderr);
    if (process.platform === 'win32') {
      assert.ok(result.stderr.includes(`bad path: ${ROLE} — \`${path}`));
      assert.equal(existsSync(join(root, '.codex/agents', `${ROLE}.toml`)), false);
    } else assert.ok(readRole(root).includes(path));
  }
});

await test('--check lints existing TOML even when no role builds that file', (t) => {
  const { root } = fixture(t);
  mkdirSync(join(root, '.codex/agents'));
  const path = join(root, '.codex/agents/foreign.toml');
  const text = '# Foreign role\nBad: `C:C:/legacy`\n';
  writeFileSync(path, text);
  const result = run(root, '--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /bad path: foreign\.toml — C:C:/);
  assert.equal(readFileSync(path, 'utf8'), text);
});

await test('orphans are reported by --check and removed on write while foreign TOML survives', (t) => {
  const { root } = fixture(t);
  assert.equal(run(root).status, 0);
  const orphan = join(root, '.codex/agents/removed.toml');
  const foreign = join(root, '.codex/agents/foreign.toml');
  writeFileSync(orphan, '# Converted from .claude/agents/removed.md\nname = "removed"\n');
  const text = '# Hand-written role\nname = "foreign"\n';
  writeFileSync(foreign, text);
  const check = run(root, '--check');
  assert.equal(check.status, 1, check.stderr);
  assert.equal(check.stdout.trim(), 'orphan: removed.toml');
  assert.equal(existsSync(orphan), true);
  const write = run(root);
  assert.equal(write.status, 0, write.stderr);
  assert.equal(write.stdout.trim(), 'orphan: removed.toml');
  assert.equal(existsSync(orphan), false);
  assert.equal(readFileSync(foreign, 'utf8'), text);
  const clean = run(root, '--check');
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout, '');
});

await test('a role from an older build with an absolute, broken header is rewritten, not kept as foreign', (t) => {
  // smash-karts-web 31.10: an older converter wrote `# Converted from C:C:/…/.claude/agents/<file>.md`.
  const { root } = fixture(t);
  mkdirSync(join(root, '.codex/agents'));
  const path = join(root, '.codex/agents', `${ROLE}.toml`);
  writeFileSync(path, `# Converted from C:C:/old/.claude/agents/${ROLE}.md\nname = "${ROLE}"\nBad: \`C:C:/old\`\n`);
  const check = run(root, '--check');
  assert.equal(check.status, 1);
  assert.equal(check.stdout.trim(), `stale: ${ROLE}`);
  assert.match(check.stderr, /bad path: fixture-reader\.toml — C:C:/);
  const write = run(root);
  assert.equal(write.status, 0, write.stderr);
  assertSharedPaths(readRole(root), root);
  assert.equal(run(root, '--check').status, 0);
});

await test('a foreign TOML with the same name as a source role is never overwritten', (t) => {
  const { root } = fixture(t);
  mkdirSync(join(root, '.codex/agents'));
  const path = join(root, '.codex/agents', `${ROLE}.toml`);
  const text = `# Hand-written role\nname = "${ROLE}"\n`;
  writeFileSync(path, text);
  for (const args of [['--check'], []]) {
    const result = run(root, ...args);
    assert.equal(result.status, 1);
    if (args.length) assert.equal(result.stdout.trim(), `stale: ${ROLE}`);
    else assert.ok(result.stderr.includes(`skipped: ${ROLE}.md — ${ROLE}.toml belongs to another converter or author`));
    assert.equal(readFileSync(path, 'utf8'), text);
  }
});

await test('a role of ours with a hand-added TOML table is never rewritten or deleted', (t) => {
  const { root } = fixture(t);
  assert.equal(run(root).status, 0);
  const path = join(root, '.codex/agents', `${ROLE}.toml`);
  const text = `${readFileSync(path, 'utf8')}\n[features]\nshell_tool = false\n`;
  writeFileSync(path, text);
  for (const args of [['--check'], []]) {
    const result = run(root, ...args);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`skipped: ${ROLE}.md — ${ROLE}.toml has hand-added [features]`), result.stderr);
    assert.equal(readFileSync(path, 'utf8'), text);
  }
  rmSync(join(root, '.claude/agents', `${ROLE}.md`));
  const orphan = run(root);
  assert.equal(orphan.status, 1);
  assert.match(orphan.stdout, /orphan: fixture-reader\.toml \(kept: hand-added \[features\]\)/);
  assert.equal(readFileSync(path, 'utf8'), text);
});

await test('a bracketed line inside the instruction string is not a hand-added table', (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, '.codex/roles.d', `${ROLE}.post.md`), '[features]\n');
  assert.equal(run(root).status, 0);
  writeFileSync(join(root, '.codex/roles.d', `${ROLE}.post.md`), 'changed\n');
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readRole(root).includes('changed\n'));
});
