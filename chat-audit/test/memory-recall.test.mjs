import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moduleOf } from '../payload/skills/chat-audit/lib/memory-recall.mjs';

test('module is the segment after the last container dir', () => {
  assert.equal(moduleOf('/r/apps/api/src/modules/supplier-item/x.service.ts'), 'supplier-item');
  assert.equal(moduleOf('/r/packages/parsers/src/a/b.ts'), 'parsers');
  assert.equal(moduleOf('/r/apps/api/src/modules/matching/sub/modules/inner/y.ts'), 'inner');
});

test('docs, memory, deps and non-code are not module files', () => {
  assert.equal(moduleOf('/r/docs/modules/matching/a.ts'), null);
  assert.equal(moduleOf('/r/node_modules/pkg/modules/x/a.js'), null);
  assert.equal(moduleOf('/r/apps/api/src/modules/matching/README.md'), null);
  assert.equal(moduleOf('/r/apps/api/src/modules/index.ts'), null);
});
