import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const oracle = JSON.parse(await readFile(resolve(root, 'test/checkout-cases.json'), 'utf8'));
const contracts = JSON.parse(await readFile(resolve(root, 'contracts.json'), 'utf8'));

test('checkout lab: frozen case IDs and expected outcomes are explicit', () => {
  assert.equal(oracle.oracleOnly, true);
  assert.equal(oracle.cases.length, 13);
  assert.equal(new Set(oracle.cases.map(entry => entry.id)).size, 13);
  assert.deepEqual([...new Set(oracle.cases.map(entry => entry.expected))].sort(), ['allow', 'block', 'scope_expansion_required', 'unknown', 'validation_refuse']);
});

test('checkout lab: every requested symbol and mutation anchor exists in the baseline', async () => {
  for (const entry of oracle.cases) {
    for (const scope of [entry.a, entry.b].filter(Boolean)) {
      const source = await readFile(resolve(root, scope.path), 'utf8');
      assert.ok(source.includes(`function ${scope.symbol}(`), `${entry.id}: ${scope.path}#${scope.symbol}`);
    }
    if (entry.mutation) {
      const source = await readFile(resolve(root, entry.mutation.path), 'utf8');
      assert.equal(source.split(entry.mutation.search).length - 1, 1, `${entry.id}: mutation must have one exact anchor`);
    }
    if (entry.contract) assert.ok(contracts.contracts.some(contract => contract.id === entry.contract));
  }
});

test('checkout lab: explicit contracts have real producer and consumer symbols', async () => {
  assert.equal(contracts.contracts.length, 2);
  for (const contract of contracts.contracts) {
    assert.ok(contract.evidence);
    for (const scope of [contract.producer, ...contract.consumers]) {
      const source = await readFile(resolve(root, scope.path), 'utf8');
      assert.ok(source.includes(`function ${scope.symbol}(`));
    }
  }
});
