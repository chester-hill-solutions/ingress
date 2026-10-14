#!/usr/bin/env node
// Throwaway terminal shell for the dependency-aware checkout experiment.
import { createInterface } from 'node:readline/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CheckoutArbiter } from '../src/prototypes/checkout/arbiter.mjs';
import { fixture, requestFor } from '../src/prototypes/checkout/fixture.mjs';
import { discoverCandidates, indexCatalog } from '../src/prototypes/checkout/impact.mjs';
import { embeddingGemmaClient } from '../src/prototypes/checkout/embeddinggemma.mjs';
import { evaluateCheckouts } from '../src/prototypes/checkout/evaluate.mjs';
import { verifyArbiter } from './checkout/verify.mjs';

const { values } = parseArgs({ options: {
  evaluate: { type: 'boolean' }, demo: { type: 'boolean' }, embeddings: { type: 'boolean' },
  endpoint: { type: 'string', default: 'http://127.0.0.1:8766' }, output: { type: 'string' },
  'top-k': { type: 'string', default: '3' }, 'minimum-score': { type: 'string', default: '0.2' },
} });
const client = values.embeddings ? embeddingGemmaClient(values.endpoint) : null;
const topK = Number(values['top-k']), minimumScore = Number(values['minimum-score']);
if (!Number.isSafeInteger(topK) || topK < 1 || topK > 20 || !Number.isFinite(minimumScore)
  || minimumScore < -1 || minimumScore > 1) throw new TypeError('invalid_candidate_settings');

if (values.evaluate) {
  const report = await evaluateCheckouts({ client, topK, minimumScore });
  report.boundaryChecks = verifyArbiter();
  if (values.output) {
    const path = resolve(values.output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  if (client && report.embeddings.status !== 'completed') process.exitCode = 1;
} else if (values.demo) {
  const arbiter = new CheckoutArbiter(fixture);
  const a = arbiter.checkout(requestFor('a', 'discount'), 0);
  const b = arbiter.checkout(requestFor('b', 'shipping'), 0);
  const conflict = arbiter.checkout(requestFor('c', 'invoice'), 0);
  const identity = grant => ({ checkoutId: grant.checkoutId, participantId: grant.participantId });
  const outOfScope = arbiter.submit({ ...identity(a), files: {
    'pricing.mjs': a.files['pricing.mjs'].replace('weight > 10', 'weight > 15'),
  }, validate: () => true }, 1);
  const first = arbiter.submit({ ...identity(a), files: {
    'pricing.mjs': a.files['pricing.mjs'].replace('(1 - rate)', '(1 - rate / 100)'),
  }, validate: syntaxOnly }, 1);
  const second = arbiter.submit({ ...identity(b), files: {
    'pricing.mjs': b.files['pricing.mjs'].replace('weight > 10', 'weight > 15'),
  }, validate: syntaxOnly }, 1);
  console.log(JSON.stringify({ experiment: 'memory-only checkout arbiter',
    checkouts: { independentBlocks: a.granted && b.granted, dependent: conflict },
    outOfScope, publications: [first, second], final: arbiter.snapshot(1), boundaryChecks: verifyArbiter() }, null, 2));
} else {
  let arbiter = new CheckoutArbiter(fixture), now = 0, policy = 'suggest', outcome = null;
  const copies = new Map();
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  function render() {
    if (process.stdout.isTTY) console.clear();
    const state = arbiter.snapshot(now);
    console.log('CHECKOUT PROTOTYPE — memory only; submissions are gated; native filesystem access is not sandboxed.');
    console.log(JSON.stringify({ revision: state.revision, now, embeddings: !!client, candidatePolicy: policy,
      coverage: state.dependencyCoverage, grants: state.grants.map(grant => ({ actor: grant.participantId,
        writes: grant.writes.map(w => `${w.blockId}:${w.start + 1}-${w.end}`), reads: grant.reads.map(r => r.id), expiresAt: grant.expiresAt })),
      last: outcome }, null, 2));
    console.log('Blocks: discount, shipping, invoice, refund, audit, tutorial, theme, contract');
    console.log('checkout ACTOR BLOCK [FIRST LAST] | edit ACTOR PATH LINE JSON_STRING | submit ACTOR');
    console.log('show ACTOR PATH | release ACTOR | renew ACTOR | tick MS | policy suggest/protect | reset | quit');
  }
  try {
    while (true) {
      render();
      const command = await terminal.question('> ');
      const [action, actor, arg, first, last] = command.trim().split(/\s+/);
      if (action === 'quit' || action === 'q') break;
      try {
        if (action === 'reset') { arbiter = new CheckoutArbiter(fixture); copies.clear(); now = 0; outcome = { reset: true }; }
        else if (action === 'tick') { const step = Number(actor); if (!Number.isSafeInteger(step) || step < 0) throw new TypeError('invalid_tick'); now += step; outcome = { now }; }
        else if (action === 'policy') { if (!['suggest', 'protect'].includes(actor)) throw new TypeError('invalid_policy'); policy = actor; outcome = { policy }; }
        else if (action === 'checkout') {
          if (copies.has(actor) && arbiter.snapshot(now).grants.some(g => g.participantId === actor)) throw new Error('release_existing_checkout_first');
          const request = requestFor(actor, arg);
          if (first || last) Object.assign(request.writes[0], { startLine: Number(first), endLine: Number(last) });
          let candidates = [];
          if (client) candidates = await discoverCandidates(await indexCatalog(arbiter.catalog, client.embed), request, client.embed, { topK, minimumScore });
          const grant = arbiter.checkout({ ...request, candidates, candidatePolicy: policy }, now);
          if (grant.granted) copies.set(actor, { grant, files: structuredClone(grant.files) });
          outcome = grant.granted ? { granted: true, actor, revision: grant.revision, candidates: grant.candidates } : grant;
        } else {
          const local = copies.get(actor);
          if (!local) throw new Error('actor_has_no_checkout');
          const identity = { checkoutId: local.grant.checkoutId, participantId: actor };
          if (action === 'release') outcome = arbiter.release(identity, now);
          else if (action === 'renew') outcome = arbiter.renew(identity, now);
          else if (action === 'edit') {
            const match = command.match(/^edit\s+\S+\s+\S+\s+(\d+)\s+(.+)$/);
            if (!match || !Object.hasOwn(local.files, arg)) throw new Error('invalid_edit');
            const replacement = JSON.parse(match[2]);
            const parts = local.files[arg].match(/[^\n]*\n|[^\n]+$/g) ?? [];
            const line = Number(match[1]);
            if (typeof replacement !== 'string' || line < 1 || line > parts.length) throw new Error('invalid_edit');
            parts[line - 1] = `${replacement}\n`; local.files[arg] = parts.join('');
            outcome = { editedPrivateCopy: true, path: arg, line };
          } else if (action === 'submit') {
            const modified = Object.fromEntries(Object.entries(local.files).filter(([path, text]) => text !== local.grant.files[path]));
            outcome = arbiter.submit({ ...identity, files: modified, validate: syntaxOnly }, now);
          } else if (action === 'show') outcome = { path: arg, text: local.files[arg] };
          else throw new Error('unknown_command');
        }
      } catch (error) { outcome = { error: error.message }; }
    }
  } finally { terminal.close(); }
}

function syntaxOnly(tree) {
  // Compilation only: fixture code is never executed. This is not semantic validation.
  for (const [path, text] of Object.entries(tree)) if (path.endsWith('.mjs')) {
    new Function(text.replace(/^import[^\n]*\n/gm, '').replace(/\bexport\s+/g, ''));
  }
  return true;
}
