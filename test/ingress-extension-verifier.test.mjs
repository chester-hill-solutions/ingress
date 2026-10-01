import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedIngress } from '../fixtures/ingress.mjs';
import { verifyIngressExtensions } from '../fixtures/ingress-extension-verifier.mjs';

test('extension evaluator retains every missing component outcome instead of accepting an incomplete game', async () => {
  const root = await mkdtemp(join(tmpdir(), 'missing-crossroads-extensions-'));
  try {
    await seedIngress(root);
    const result = await verifyIngressExtensions(root);
    assert.equal(result.correct, false);
    assert.equal(result.checks.length, 58);
    const exports = result.checks.filter(check => check.name.startsWith('extension-exports-'));
    assert.equal(exports.length, 14);
    assert.ok(exports.every(check => check.passed === false));
    assert.equal(result.checks.find(check => check.name === 'extension-exports-a11y').passed, false);
    assert.ok(!result.checks.some(check => check.name === 'extension-verifier-execution'));
    assert.equal(result.checks.find(check => check.name === 'extension-ui-references').passed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
