// scrub.mjs — provider tokens known by their prefix. Case: a Notion token lay unmasked in two audit slices
// (2026-10-04), the detector list had no ntn_. Tokens are built from pieces so that no scanner, ours or a push
// protection, takes this file for a leak. Run: node --test chat-audit/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub, findSecrets } from '../payload/skills/chat-audit/lib/scrub.mjs';

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

test('names and short ids that merely share a prefix stay', () => {
  for (const s of ['secret_key_name', 'hf_hub_download', 'npm_config_cache', 'ntn_page', 'sk_live_mode', 'port 5432:AA']) {
    assert.equal(scrub(s), s);
  }
});
