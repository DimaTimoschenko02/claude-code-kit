// node --test tests/private-check.test.mjs
// The public-repo guard (.githooks/private-check.sh): owner words come from a private file, identity from the machine,
// session ids from the transcripts on disk — none of it is written in this repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CHECK = path.join(import.meta.dirname, '..', '.githooks', 'private-check.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'private-check-'));
const patterns = path.join(tmp, 'patterns');
fs.writeFileSync(patterns, '# comment\n\nacme-secret-project\n(^|[^[:alpha:]])Zorg([^[:alpha:]]|$)\n!Zorg Publicname\n');
const projects = path.join(tmp, 'projects');
const SESSION = '0f0e0d0c-1111-4222-8333-944445555666';
fs.mkdirSync(path.join(projects, 'some-folder'), { recursive: true });
fs.writeFileSync(path.join(projects, 'some-folder', SESSION + '.jsonl'), '');

const check = (text) => spawnSync('bash', [CHECK], {
  input: text, encoding: 'utf8', env: { ...process.env, KIT_PRIVATE_PATTERNS: patterns, CLAUDE_PROJECTS_DIR: projects },
});

test('clean text passes', () => {
  assert.equal(check('a generic comment about the user and a project\n').status, 0);
});

test('a word from the private file is caught; a whole-word pattern ignores the word inside another word', () => {
  assert.equal(check('cd ~/code/ACME-SECRET-PROJECT/api\n').status, 1);
  assert.equal(check("what Zorg chose\n").status, 1);
  assert.equal(check('Zorgonite is a mineral\n').status, 0);
});

test('an allow line skips attribution published on purpose', () => {
  assert.equal(check('Copyright (c) 2026 Zorg Publicname\n').status, 0);
});

test('the login name is caught in a pasted transcript folder name', { skip: os.userInfo().username.length < 4 }, () => {
  const r = check(`const DIR = 'C--Users-${os.userInfo().username}-code-proj';\n`);
  assert.equal(r.status, 1);
});

test('a session id of this machine is caught; an unknown UUID is not', () => {
  const r = check(`real('${SESSION}')\n`);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /session id of this machine/);
  assert.equal(check("uuid: '123e4567-e89b-42d3-a456-426614174000'\n").status, 0);
});
