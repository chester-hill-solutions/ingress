import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBenchmarkToolPaths } from '../src/benchmark-tool-paths.mjs';

const multi = '*** Begin Patch\n*** Add File: a.mjs\n+PRIVATE DIFF CONTENT\n*** Update File: b.mjs\n*** Move to: moved.mjs\n@@\n-old\n+new\n*** Delete File: old.mjs\n*** End Patch\n';

test('native patch metadata includes every add/update/delete and move destination, without diff prose', () => {
  const result = extractBenchmarkToolPaths({ patchText: multi }, 'patch');
  assert.deepEqual(result, { paths: ['a.mjs', 'b.mjs', 'moved.mjs', 'old.mjs'], complete: true });
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('bounded wrapped JSON and ordinary file aliases preserve only paths', () => {
  for (const key of ['path', 'filePath', 'file_path']) assert.deepEqual(extractBenchmarkToolPaths({ value: JSON.stringify({ [key]: 'a.mjs', content: 'PRIVATE' }) }, 'write'), { paths: ['a.mjs'], complete: true });
  assert.deepEqual(extractBenchmarkToolPaths({ value: JSON.stringify({ patchText: multi }) }), extractBenchmarkToolPaths({ patchText: multi }, 'patch'));
  assert.deepEqual(extractBenchmarkToolPaths({ path: 'a.mjs', filePath: 'b.mjs' }), { paths: ['a.mjs', 'b.mjs'], complete: false });
  for (const value of [null, {}, { value: '{broken' }, { value: 'x'.repeat(262145) }, { value: JSON.stringify([]) }, { patchText: 'x'.repeat(262145) }]) assert.equal(extractBenchmarkToolPaths(value, 'patch').complete, false);
});

test('external and protected destinations are retained for the runtime permission diagnosis', () => {
  const patchText = '*** Begin Patch\n*** Update File: sub/../package.json\n*** Move to: ../outside.json\n@@\n-a\n+b\n*** Add File: /tmp/external.mjs\n+x\n*** End Patch';
  assert.deepEqual(extractBenchmarkToolPaths({ patchText }, 'patch'), { paths: ['sub/../package.json', '../outside.json', '/tmp/external.mjs'], complete: true });
});

test('malformed structure preserves known headers but marks target coverage incomplete', () => {
  const malformed = [
    '*** Add File: a\n+x',
    '*** Begin Patch\n*** End Patch',
    '*** Begin Patch\n*** Update File: a\n*** End Patch',
    '*** Begin Patch\n*** Add File: a\n*** Move to: b\n+x\n*** End Patch',
    '*** Begin Patch\n*** Add File: a\nnot a diff\n*** End Patch',
    '*** Begin Patch\n*** Delete File: a\n*** Unexpected: b\n*** End Patch',
    '*** Begin Patch\n*** Add File: \n+x\n*** End Patch',
    '*** Begin Patch\n*** Add File: a\u0000b\n+x\n*** End Patch',
  ];
  for (const patchText of malformed) assert.equal(extractBenchmarkToolPaths({ patchText }, 'patch').complete, false);
  const partial = extractBenchmarkToolPaths({ patchText: malformed[4] }, 'patch');
  assert.deepEqual(partial.paths, ['a']); assert.equal(partial.complete, false);
});

test('target and input bounds produce explicit unknown coverage instead of hiding overflow', () => {
  const patchText = '*** Begin Patch\n' + Array.from({ length: 65 }, (_, i) => `*** Add File: f${i}.mjs\n+x\n`).join('') + '*** End Patch';
  const result = extractBenchmarkToolPaths({ patchText }, 'patch');
  assert.equal(result.paths.length, 64); assert.equal(result.complete, false);
  assert.deepEqual(extractBenchmarkToolPaths({ path: 'x'.repeat(1025) }), { paths: [], complete: false });
  assert.deepEqual(extractBenchmarkToolPaths({ path: '💡'.repeat(300) }), { paths: [], complete: false });
});

test('serialized standalone extractor has identical behavior without imports', () => {
  const embedded = Function('return (' + extractBenchmarkToolPaths.toString() + ')')();
  assert.deepEqual(embedded({ patchText: multi }, 'patch'), extractBenchmarkToolPaths({ patchText: multi }, 'patch'));
});
