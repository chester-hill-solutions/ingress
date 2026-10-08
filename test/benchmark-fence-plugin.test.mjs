import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { installBenchmarkPlugin } from '../src/benchmark-plugin.mjs';

test('the fence is absent by default and present when asked, and the generated plugin parses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fence-plugin-'));
  try {
    const bridge = join(root, 'bridge');
    await mkdir(bridge, { recursive: true });

    const plain = await installBenchmarkPlugin(root, bridge);
    assert.equal(plain.fenceTtlMs, null);
    assert.ok(!plain.source.includes('permission.hook'), 'the default plugin must not fence');

    const fenced = await installBenchmarkPlugin(root, bridge, { fenceTtlMs: 90_000 });
    assert.equal(fenced.fenceTtlMs, 90_000);
    assert.ok(fenced.source.includes("permission.hook('evaluate'"), 'the fenced plugin must register the hook');
    assert.ok(fenced.source.includes('createWriteFence'), 'the policy must be inlined');
    assert.ok(fenced.source.includes('event.effect=\'deny\''), 'a refusal must set the deny effect');

    // The plugin runs inside OpenCode as a module. It must parse as one, and the inlined
    // policy must not reference a name the inlining dropped.
    const file = join(root, 'plugin.mjs');
    await writeFile(file, fenced.source);
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a non-positive fence ttl is refused rather than silently disabling the fence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fence-plugin-'));
  try {
    const bridge = join(root, 'bridge');
    await mkdir(bridge, { recursive: true });
    await assert.rejects(installBenchmarkPlugin(root, bridge, { fenceTtlMs: 0 }), RangeError);
    await assert.rejects(installBenchmarkPlugin(root, bridge, { fenceTtlMs: -5 }), RangeError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
