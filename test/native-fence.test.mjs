import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteFence, DEFAULT_LEASE_TTL_MS, WRITE_ACTIONS } from '../src/native-fence.mjs';

const A = 'ses_a', B = 'ses_b';
const write = (sessionID, ...resources) => ({ sessionID, action: 'edit', resources });

test('a read is never fenced', () => {
  const fence = createWriteFence();
  fence.evaluate(write(A, 'view.mjs'));
  assert.equal(fence.evaluate({ sessionID: B, action: 'read', resources: ['view.mjs'] }).decision, 'allow');
});

test('the first writer takes the path and a second agent is refused', () => {
  // The collision this exists to stop: two agents appending to one file.
  const fence = createWriteFence();
  assert.equal(fence.evaluate(write(A, 'view.mjs')).decision, 'allow');
  const refused = fence.evaluate(write(B, 'view.mjs'));
  assert.equal(refused.decision, 'deny');
  assert.equal(refused.heldBy, A);
  assert.equal(refused.path, 'view.mjs');
});

test('the holder may write its own path again, and the lease refreshes', () => {
  const fence = createWriteFence({ ttlMs: 1000 });
  assert.equal(fence.evaluate(write(A, 'view.mjs'), 0).decision, 'allow');
  // B is refused at t=900, then A refreshes at t=900...
  assert.equal(fence.evaluate(write(B, 'view.mjs'), 900).decision, 'deny');
  assert.equal(fence.evaluate(write(A, 'view.mjs'), 900).decision, 'allow');
  // ...so B is still refused at t=1500, past the original expiry but inside the refresh.
  assert.equal(fence.evaluate(write(B, 'view.mjs'), 1500).decision, 'deny');
});

test('an idle lease expires and the path becomes free', () => {
  const fence = createWriteFence({ ttlMs: 1000 });
  fence.evaluate(write(A, 'view.mjs'), 0);
  assert.equal(fence.evaluate(write(B, 'view.mjs'), 1001).decision, 'allow');
});

test('a multi-path write is refused if any path is held, and grants nothing', () => {
  const fence = createWriteFence();
  fence.evaluate(write(A, 'app.mjs'));
  const refused = fence.evaluate(write(B, 'view.mjs', 'app.mjs'));
  assert.equal(refused.decision, 'deny');
  assert.equal(refused.path, 'app.mjs');
  // The first path in that refused write must not have been leased to B.
  assert.equal(fence.snapshot()['view.mjs'], undefined);
});

test('releasing a session frees only its paths', () => {
  const fence = createWriteFence();
  fence.evaluate(write(A, 'a.mjs'));
  fence.evaluate(write(B, 'b.mjs'));
  fence.release(A);
  assert.equal(fence.evaluate(write(B, 'a.mjs')).decision, 'allow');
  assert.equal(fence.evaluate(write(A, 'b.mjs')).decision, 'deny');
});

test('a write with no session or no path is not fenced', () => {
  // No attribution means no lease can be kept honest, so the fence does not pretend.
  const fence = createWriteFence();
  assert.equal(fence.evaluate({ sessionID: '', action: 'edit', resources: ['x'] }).decision, 'allow');
  assert.equal(fence.evaluate({ sessionID: A, action: 'edit', resources: [] }).decision, 'allow');
});

test('every declared write action is fenced and nothing else is', () => {
  const fence = createWriteFence();
  for (const action of WRITE_ACTIONS) {
    const fresh = createWriteFence();
    assert.equal(fresh.evaluate({ sessionID: A, action, resources: ['x'] }).decision, 'allow');
    assert.equal(fresh.evaluate({ sessionID: B, action, resources: ['x'] }).decision, 'deny', `${action} must be fenced`);
  }
  assert.equal(fence.evaluate({ sessionID: A, action: 'glob', resources: ['x'] }).decision, 'allow');
});

test('a non-positive ttl is refused rather than disabling the fence', () => {
  assert.throws(() => createWriteFence({ ttlMs: 0 }), RangeError);
  assert.throws(() => createWriteFence({ ttlMs: -1 }), RangeError);
  assert.equal(createWriteFence().evaluate(write(A, 'x')).decision, 'allow');
  assert.ok(DEFAULT_LEASE_TTL_MS > 0);
});
