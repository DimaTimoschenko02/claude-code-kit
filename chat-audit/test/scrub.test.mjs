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

test('names and short ids that merely share a prefix stay', () => {
  for (const s of ['secret_key_name', 'hf_hub_download', 'npm_config_cache', 'ntn_page', 'sk_live_mode', 'port 5432:AA']) {
    assert.equal(scrub(s), s);
  }
});
