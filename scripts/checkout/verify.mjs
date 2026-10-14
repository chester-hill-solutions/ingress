// Independent counterexamples for the experiment's admission boundary; no model required.
import assert from 'node:assert/strict';
import { CheckoutArbiter } from '../../src/prototypes/checkout/arbiter.mjs';
import { fixture, requestFor } from '../../src/prototypes/checkout/fixture.mjs';
import { changes, covered, touches } from '../../src/prototypes/checkout/regions.mjs';
import { hashText } from '../../src/prototypes/checkout/impact.mjs';

export function verifyArbiter() {
  const checks = [];
  function check(name, run) { run(); checks.push({ name, passed: true }); }
  const submit = (arbiter, grant, files, options = {}) => arbiter.submit({ checkoutId: grant.checkoutId,
    participantId: grant.participantId, files, validate: () => true, ...options }, 1);

  check('independent blocks share a file and both changes survive publication', () => {
    const arbiter = new CheckoutArbiter(fixture);
    const a = arbiter.checkout(requestFor('a', 'discount'), 0);
    const b = arbiter.checkout(requestFor('b', 'shipping'), 0);
    assert.equal(a.granted && b.granted, true);
    const av = a.files['pricing.mjs'].replace('(1 - rate)', '(1 - rate / 100)');
    const bv = b.files['pricing.mjs'].replace('weight > 10', 'weight > 15');
    assert.equal(submit(arbiter, a, { 'pricing.mjs': av }).admitted, true);
    const second = submit(arbiter, b, { 'pricing.mjs': bv });
    assert.equal(second.admitted, true);
    assert.deepEqual(second.merged, ['pricing.mjs']);
    assert.ok(arbiter.snapshot(1).files['pricing.mjs'].includes('(1 - rate / 100)'));
    assert.ok(arbiter.snapshot(1).files['pricing.mjs'].includes('weight > 15'));
  });
  check('overlap refused, including multiple grants to the same participant', () => {
    const arbiter = new CheckoutArbiter(fixture);
    arbiter.checkout(requestFor('a', 'discount'), 0);
    assert.equal(arbiter.checkout(requestFor('a', 'discount'), 0).reason, 'checkout_conflict');
  });
  check('a line insertion in an earlier block does not relocate another active grant', () => {
    const arbiter = new CheckoutArbiter(fixture);
    const a = arbiter.checkout(requestFor('a', 'discount'), 0);
    const b = arbiter.checkout(requestFor('b', 'shipping'), 0);
    const first = a.files['pricing.mjs'].replace('  return subtotal', '  // local calculation\n  return subtotal');
    assert.equal(submit(arbiter, a, { 'pricing.mjs': first }).admitted, true);
    const second = b.files['pricing.mjs'].replace('weight > 10', 'weight > 15');
    assert.equal(submit(arbiter, b, { 'pricing.mjs': second }).admitted, true);
    assert.ok(arbiter.snapshot(1).files['pricing.mjs'].includes('// local calculation'));
    assert.ok(arbiter.snapshot(1).files['pricing.mjs'].includes('weight > 15'));
  });
  check('partial line requests permit separate lines inside one block', () => {
    const arbiter = new CheckoutArbiter({ ...fixture, edges: [] });
    assert.equal(arbiter.checkout({ participantId: 'a', writes: [{ blockId: 'discount', startLine: 1, endLine: 1 }] }, 0).granted, true);
    assert.equal(arbiter.checkout({ participantId: 'b', writes: [{ blockId: 'discount', startLine: 2, endLine: 2 }] }, 0).granted, true);
  });
  check('dependency conflict refuses a whole request without a partial grant', () => {
    const arbiter = new CheckoutArbiter(fixture);
    arbiter.checkout(requestFor('a', 'discount'), 0);
    assert.equal(arbiter.checkout({ participantId: 'b', writes: [{ blockId: 'theme' }, { blockId: 'invoice' }] }, 0).granted, false);
    assert.equal(arbiter.snapshot(0).grants.length, 1);
    assert.equal(arbiter.checkout(requestFor('c', 'theme'), 0).granted, true);
  });
  check('expiry allows takeover and fences the old submitter', () => {
    const arbiter = new CheckoutArbiter(fixture);
    const a = arbiter.checkout({ ...requestFor('a', 'discount'), leaseMs: 10 }, 0);
    assert.equal(arbiter.checkout(requestFor('b', 'discount'), 10).granted, true);
    assert.equal(arbiter.submit({ checkoutId: a.checkoutId, participantId: 'a', files: a.files, validate: () => true }, 10).reason, 'checkout_not_live');
  });
  check('renewal and release require the issued participant identity', () => {
    const arbiter = new CheckoutArbiter(fixture);
    const a = arbiter.checkout(requestFor('a', 'discount'), 0);
    assert.equal(arbiter.renew({ checkoutId: a.checkoutId, participantId: 'b' }, 1).reason, 'checkout_not_live');
    assert.equal(arbiter.release({ checkoutId: a.checkoutId, participantId: 'b' }, 1).reason, 'checkout_not_live');
    assert.equal(arbiter.renew({ checkoutId: a.checkoutId, participantId: 'a' }, 1).renewed, true);
    assert.equal(arbiter.release({ checkoutId: a.checkoutId, participantId: 'a' }, 1).released, true);
    assert.equal(submit(arbiter, a, a.files).reason, 'checkout_not_live');
  });
  check('submitted full file is checked against scope, including insertion and deletion', () => {
    for (const mutate of [
      text => text.replace('weight > 10', 'weight > 11'),
      text => text.replace('export function shippingFee', '// unauthorized\nexport function shippingFee'),
      text => text.replace('  return weight > 10 ? 20 : 5;\n', ''),
    ]) {
      const arbiter = new CheckoutArbiter(fixture), a = arbiter.checkout(requestFor('a', 'discount'), 0);
      const before = arbiter.snapshot(0);
      assert.equal(submit(arbiter, a, { 'pricing.mjs': mutate(a.files['pricing.mjs']) }).reason, 'outside_modification_scope');
      assert.deepEqual(arbiter.snapshot(1).files, before.files);
    }
  });
  check('adjacent insertion belongs to the following line and EOF to the last', () => {
    const boundary = changes('a\nb\n', 'a\nnew\nb\n')[0];
    assert.equal(covered(boundary, [{ start: 0, end: 1 }], 2), false);
    assert.equal(covered(boundary, [{ start: 1, end: 2 }], 2), true);
    const eof = changes('a\nb\n', 'a\nb\nnew\n')[0];
    assert.equal(covered(eof, [{ start: 1, end: 2 }], 2), true);
    assert.equal(touches(eof, { start: 1, end: 2 }, 2), true);
  });
  check('multi-file refusal is atomic and failed work remains retryable', () => {
    const arbiter = new CheckoutArbiter(fixture);
    const a = arbiter.checkout({ participantId: 'a', writes: [{ blockId: 'discount' }, { blockId: 'theme' }] }, 0);
    const revised = a.files['pricing.mjs'].replace('(1 - rate)', '(1 - rate / 100)');
    assert.equal(submit(arbiter, a, { 'pricing.mjs': revised, 'refund.mjs': 'outside\n' }).admitted, false);
    assert.deepEqual(arbiter.snapshot(1).files, a.files);
    assert.equal(submit(arbiter, a, { 'pricing.mjs': revised }).admitted, true);
  });
  check('validation is mandatory and cannot mutate the publication candidate', () => {
    const arbiter = new CheckoutArbiter(fixture), a = arbiter.checkout(requestFor('a', 'discount'), 0);
    const files = { 'pricing.mjs': a.files['pricing.mjs'].replace('(1 - rate)', '(1 - rate / 100)') };
    assert.equal(submit(arbiter, a, files, { validate: undefined }).reason, 'validation_required');
    assert.equal(submit(arbiter, a, files, { validate: () => false }).reason, 'validation_failed');
    assert.equal(submit(arbiter, a, files, { validate: tree => { tree['theme.mjs'] = 'forged'; return true; } }).admitted, true);
    assert.equal(arbiter.snapshot(1).files['theme.mjs'], a.files['theme.mjs']);
  });
  check('checkout copies and returned scopes cannot mutate the arbiter', () => {
    const arbiter = new CheckoutArbiter(fixture), a = arbiter.checkout(requestFor('a', 'discount'), 0);
    a.files['pricing.mjs'] = 'forged'; a.writes[0].end = 99;
    assert.equal(arbiter.snapshot(0).files['pricing.mjs'], fixture.files['pricing.mjs']);
    assert.equal(submit(arbiter, a, { 'pricing.mjs': fixture.files['pricing.mjs'].replace('weight > 10', 'weight > 11') }).reason, 'outside_modification_scope');
  });
  check('another publication during validation fences the original candidate', () => {
    const arbiter = new CheckoutArbiter(fixture);
    const a = arbiter.checkout(requestFor('a', 'discount'), 0);
    const b = arbiter.checkout(requestFor('b', 'theme'), 0);
    const result = submit(arbiter, a, { 'pricing.mjs': a.files['pricing.mjs'].replace('(1 - rate)', '(1 - rate / 100)') }, {
      validate: () => {
        assert.equal(submit(arbiter, b, { 'theme.mjs': b.files['theme.mjs'].replace('"night"', '"dark"') }).admitted, true);
        return true;
      },
    });
    assert.equal(result.reason, 'publication_moved');
    assert.equal(arbiter.snapshot(1).files['pricing.mjs'], fixture.files['pricing.mjs']);
    assert.ok(arbiter.snapshot(1).files['theme.mjs'].includes('"dark"'));
  });
  check('old line coordinates require re-indexing before another checkout', () => {
    const arbiter = new CheckoutArbiter(fixture), a = arbiter.checkout(requestFor('a', 'discount'), 0);
    assert.equal(submit(arbiter, a, { 'pricing.mjs': a.files['pricing.mjs'].replace('  return subtotal', '  // inserted\n  return subtotal') }).admitted, true);
    assert.equal(arbiter.checkout(requestFor('b', 'shipping'), 1).reason, 'catalog_stale');
    const blocks = fixture.blocks.map(block => block.path !== 'pricing.mjs' ? block : {
      ...block, startLine: block.startLine + (block.id === 'shipping' ? 1 : 0), endLine: block.endLine + 1 });
    arbiter.reindex({ blocks, edges: fixture.edges });
    assert.equal(arbiter.checkout(requestFor('b', 'shipping'), 1).granted, true);
  });
  check('re-indexing cannot compare incompatible active line coordinates', () => {
    const arbiter = new CheckoutArbiter(fixture);
    const a = arbiter.checkout(requestFor('a', 'discount'), 0);
    arbiter.checkout(requestFor('b', 'shipping'), 0);
    submit(arbiter, a, { 'pricing.mjs': a.files['pricing.mjs'].replace('(1 - rate)', '(1 - rate / 100)') });
    arbiter.reindex({ blocks: fixture.blocks, edges: fixture.edges });
    const refused = arbiter.checkout(requestFor('c', 'discount'), 1);
    assert.equal(refused.reason, 'checkout_conflict');
    assert.ok(refused.conflicts.some(conflict => conflict.reason === 'coordinate_basis_moved'));
  });
  check('candidates suggest by default and protect only under the explicit policy', () => {
    for (const policy of ['suggest', 'protect']) {
      const arbiter = new CheckoutArbiter(fixture);
      const candidates = [{ blockId: 'refund', fileHash: hashText(fixture.files['refund.mjs']), score: 0.5 }];
      arbiter.checkout({ ...requestFor('a', 'invoice'), candidates, candidatePolicy: policy }, 0);
      assert.equal(arbiter.checkout(requestFor('b', 'refund'), 0).granted, policy === 'suggest');
    }
  });
  check('stale, unknown, and non-finite embedding candidates are refused', () => {
    const arbiter = new CheckoutArbiter(fixture);
    for (const candidate of [{ blockId: 'refund', fileHash: 'old', score: 0.5 },
      { blockId: 'unknown', fileHash: 'old', score: 0.5 },
      { blockId: 'refund', fileHash: hashText(fixture.files['refund.mjs']), score: NaN }]) {
      assert.equal(arbiter.checkout({ ...requestFor('a', 'invoice'), candidates: [candidate] }, 0).reason, 'invalid_candidate');
    }
  });
  check('malformed ranges and candidates cannot acquire a grant', () => {
    const arbiter = new CheckoutArbiter(fixture);
    assert.equal(arbiter.checkout({ participantId: 'a', writes: [null] }, 0).reason, 'invalid_modification_scope');
    assert.equal(arbiter.checkout({ ...requestFor('a', 'discount'), candidates: [null] }, 0).reason, 'invalid_candidate');
    assert.equal(arbiter.checkout({ participantId: 'a', writes: [{ blockId: 'discount', startLine: 1, endLine: 4 }] }, 0).reason, 'invalid_modification_scope');
    assert.equal(arbiter.snapshot(0).grants.length, 0);
  });
  return checks;
}
