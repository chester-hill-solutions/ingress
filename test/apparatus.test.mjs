import test from 'node:test';
import assert from 'node:assert/strict';
import { runApparatus } from '../src/apparatus.mjs';

test('independent apparatus observes dependency change, requests refresh and verifies final fixture', async () => {
  const result = await runApparatus();
  assert.equal(result.kind, 'deterministic-apparatus');
  assert.equal(result.incompleteDetected, true);
  assert.equal(result.verification.correct, true);
  assert.equal(result.shadow[0].status, 'shadow-only');
  assert.equal(result.shadow[0].decision.action, 'refresh_context');
  assert.equal(result.limits.productBenefitEstablished, false);
  const joins = result.events.filter(event => event.type === 'file.joined');
  assert.equal(joins[1].participants[0].id, 'producer');
});
