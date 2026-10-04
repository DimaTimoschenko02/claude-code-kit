// scrub.mjs — provider tokens known by their prefix. Case: a Notion token lay unmasked in two audit slices
// (2026-10-04), the detector list had no ntn_. Tokens are built from pieces so that no scanner, ours or a push
// protection, takes this file for a leak. Run: node --test chat-audit/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub, findSecrets, scrubHead, scrubTail } from '../payload/skills/chat-audit/lib/scrub.mjs';

const body = (n) => 'Ab3x'.repeat(Math.ceil(n / 4)).slice(0, n);

const TOKENS = {
  notion: 'ntn_' + body(46),
  'notion legacy': 'secret_' + body(43),
  stripe: 'sk_' + 'live_' + body(24),
  npm: 'npm_' + body(36),
  'hugging face': 'hf_' + body(34),
  linear: 'lin_' + 'api_' + body(40),
  atlassian: 'ATA' + 'TT3x' + body(60),
  telegram: '7123456789:' + 'AA' + body(33),
};

for (const [name, token] of Object.entries(TOKENS)) {
  test(`${name} token is masked inside prose and JSON`, () => {
    const prose = `use ${token} for the call`;
    assert.equal(scrub(prose), 'use [REDACTED] for the call');
    assert.ok(!scrub(JSON.stringify({ cmd: `curl -H "x: ${token}"` })).includes(token));
    assert.equal(findSecrets(prose).length, 1);
  });
}

// agents.mjs scrubs JSON.stringify(tool result): a token opening a line sits right after the two characters \n.
test('a token right after an escaped newline or tab in serialized JSON is masked, old shapes too', () => {
  const shapes = [...Object.values(TOKENS), 'sk-' + body(30), 'ghp_' + body(36), 'AKIA' + 'ABCDEFGHIJKLMNOP', 'AIza' + body(30)];
  for (const token of shapes) {
    for (const sep of ['\n', '\t', '\r\n']) {
      const out = scrub(JSON.stringify({ stdout: `line one${sep}${token}` }));
      assert.ok(!out.includes(token), `${token.slice(0, 6)}… after ${JSON.stringify(sep)}`);
      assert.ok(out.includes('line one'));
    }
  }
});

test('a token right after a terminal colour code is masked, raw and serialized', () => {
  const token = TOKENS.notion;
  for (const text of [`\x1b[32mok\x1b[0m${token}`, JSON.stringify({ out: `\x1b[0m${token}` })]) {
    assert.ok(!scrub(text).includes(token));
  }
});

// A view that blanked "\t" alone cut these values at the escape or lost the match, and the tail leaked.
test('a value holding a literal backslash-t or backslash-n is masked whole', () => {
  const texts = [
    'postgres://app:Qx\\t9vLm2@db.example.com/x',
    JSON.stringify({ c: 'postgres://app:Qx\\t9vLm2@db.example.com/x' }),
    'curl -u admin:Qx\\n9vLm2 https://h',
    'mysql -pQx\\t9vLm2 db',
  ];
  for (const text of texts) assert.ok(!scrub(text).includes('9vLm2'), text);
});

test('names and short ids that merely share a prefix stay', () => {
  for (const s of ['secret_key_name', 'hf_hub_download', 'npm_config_cache', 'ntn_page', 'sk_live_mode', 'port 5432:AA']) {
    assert.equal(scrub(s), s);
  }
});

test('a Telegram token inside its API URL is masked', () => {
  const token = TOKENS.telegram;
  const out = scrub(`curl https://api.telegram.org/bot${token}/sendMessage`);
  assert.ok(!out.includes(token.split(':')[1]), out);
});

// Probe 2026-10-04: shapes that leaked in real-looking text. P is a password, K a 40-char key.
const P = 'Qx9' + 'kLm2pRt7Zw';
const K = 'Ck' + 'F10yxf'.repeat(6) + 'Ab';
const leaks = (text, secret) => scrub(text).includes(secret);

test('a value in escaped quotes inside serialized JSON is masked', () => {
  for (const cmd of [`export DB_PASSWORD="${P}"`, `mysql --password="${P}" db`, `mysql -uroot -p"${P}" db`,
    `curl -u "admin:${P}" https://h`, `PGPASSWORD="${P}" psql -h h`]) {
    assert.ok(!leaks(JSON.stringify({ command: cmd }), P), cmd);
  }
  assert.ok(!leaks(JSON.stringify({ content: JSON.stringify({ db: { password: P } }) }), P), 'json in json');
});

test('PHP arrays, define, getenv defaults and env fallbacks are masked', () => {
  for (const text of [`'password' => '${P}',`, `'password'=>'${P}',`, `"db_password" => "${P}",`, `password => ${P}`,
    `define('DB_PASSWORD', '${P}');`, `os.getenv("API_KEY", "${K}")`, `const pw = process.env.DB_PASSWORD || '${P}';`,
    `const t = process.env.API_TOKEN ?? '${K}';`, `<password>${P}</password>`]) {
    const secret = text.includes(K) ? K : P;
    assert.ok(!leaks(text, secret), text);
  }
});

test('a quoted value is masked whole: spaces of a Gmail app password, a paren inside', () => {
  const out = scrub('IMAP_PASSWORD="qmzv kytr bnwx plhd"');
  for (const group of ['qmzv', 'kytr', 'bnwx', 'plhd']) assert.ok(!out.includes(group), out);
  assert.ok(!leaks('password="XoI)uu6bY7JR"', 'uu6bY7JR'));
});

test('env keys, any-case bearer, base64 PEM, PGP, 0x hex, base64 with slashes, curl -uuser:pw', () => {
  const pemB64 = 'LS0tLS1CRUdJTi' + 'BSU0EgUFJJVkFURSBLRVktLS0tLQo' + K;
  const hex = 'ec21' + '1731974ef4ec'.repeat(5);
  const slashed = 's7pOW/' + 'GZkVNZ/' + 'imYPssVWYH';
  const cases = [
    [`ENCRYPTION_KEY=${K}`, K], [`APP_KEY=base64:${K}=`, K], [`DB_PW=${P}`, P],
    [`authorization: bearer ${K}`, K], [`    client-key-data: ${pemB64}`, K],
    [`-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${K}\n-----END PGP PRIVATE KEY BLOCK-----`, K],
    [`PRIVATE=0x${hex}`, hex], [`DB_PASS=${slashed}`, slashed], [`{"SecretAccessKey":"${slashed}"}`, slashed],
    [`curl -uadmin:${P} https://h/api`, P],
  ];
  for (const [text, secret] of cases) assert.ok(!leaks(text, secret), text);
});

test('code, descriptions of a secret and ordinary config stay as written', () => {
  for (const s of ['author: Пушкин', 'authors=Толстой Шевченко', 'authMode: basic', 'authenticated: true',
    'max_tokens=4096', 'tokenCount: 1234', 'const token = getToken();',
    '{ password: dto.password }', 'passwordHash: user.passwordHash', 'accessKey: this.cfg.accessKey',
    'secret: Buffer.from(raw)', 'secretName: pricehub-env', 'apiKey: string;', 'token_type: Bearer',
    'password-reset: enabled', 'sk-learn-classification-tutorial', 'image@sha256:' + 'ab12'.repeat(16),
    `.option('--password', 'Password to use')`, '{ password: "Password is required" }',
    'password: "see brain/access.md → Postgres"', "IDENTIFIED BY '$PW'"]) {
    assert.equal(scrub(s), s);
    assert.equal(findSecrets(s).length, 0, s);
  }
});

test('a cut made after scrubbing never shows the head of a token it crosses', () => {
  const token = TOKENS.notion;
  const cmd = `curl -H 'Authorization: Bearer ${token}' -d @page.json`;
  for (let n = cmd.indexOf(token) + 4; n < cmd.indexOf(token) + token.length; n += 7) {
    assert.ok(!scrubHead(cmd, n).includes(token.slice(4, 12)), `head ${n}`);
  }
  const tail = scrubTail(`noise ${TOKENS.telegram} tail`, 20);
  assert.ok(!tail.includes(TOKENS.telegram.slice(-12)), tail);
});

// Unbounded runs around a key and a splice per hit made these take 6–19 s; serialized JSON is one line of megabytes.
test('long words, hex runs and a big serialized output are scrubbed in linear time', () => {
  const rows = Array.from({ length: 12000 }, (_, i) => `row ${i} token=abc${i} https://h/x?a=${i} password: see vault`);
  for (const text of ['a'.repeat(100000), 'ab12'.repeat(25000), 'password'.repeat(6000), JSON.stringify({ o: rows.join('\n') })]) {
    const started = performance.now();
    scrub(text);
    findSecrets(text);
    assert.ok(performance.now() - started < 3000, `${text.slice(0, 12)}… took ${Math.round(performance.now() - started)} ms`);
  }
});

// The redaction-only net under the detectors stays broad: narrowing it with the detectors' value checks lost all of
// these, which the version before it masked (a security review of 2cf532d caught it).
test('the broad net still masks what only it caught: glued auth keys, numbers, paths, camelCase words', () => {
  const ts = 'tskey-auth-' + 'kQ9xZ2'.repeat(5);
  const long = '{"k":"v"},'.repeat(80);
  const cases = [
    [`TS_AUTHKEY=${ts}`, ts], [`authkey: ${ts}`, ts], ['DB_PASSWORD=84736251', '84736251'], ['password=4821', '4821'],
    ['db_pass=>4821', '4821'], [`PASS=>XoI)uu6bY7JR`, 'uu6bY7JR'], ['token=84736251', '84736251'],
    ['password: Ab3/x9.Kq', 'x9.Kq'], ['password: superSecretPassword', 'superSecretPassword'],
    [`VAULT_SECRET_ID=${P}`, P], [`api_secret_hash: ${P}`, P], [`token_header: ${P}`, P],
    [`curl -s -X POST https://h/api -d '${long}' -u admin:${P}`, P],
  ];
  for (const [text, secret] of cases) assert.ok(!leaks(text, secret), text);
});
