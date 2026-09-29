import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { observeFiles } from '../src/file-observer.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');

test('declared bytes baseline, changed content and gap reconciliation remain attribution unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'collab-observe-'));
  let observer;
  const events = [];
  try {
    await writeFile(join(root, 'money.mjs'), 'dollars');
    observer = await observeFiles({ root, paths: ['money.mjs'], epoch: 'epoch-1', onObservation: event => events.push(event), intervalMs: 10_000 });
    assert.equal(events.find(e => e.type === 'file.observed').data.hash, hash('dollars'));
    await writeFile(join(root, 'money.mjs'), 'cents');
    await observer.reconcile();
    const changes = events.filter(e => e.type === 'file.observed');
    assert.deepEqual(changes.map(e => e.data.hash), [hash('dollars'), hash('cents')]);
    assert.deepEqual(changes.map(e => e.data.revision), [1, 2]);
    assert.ok(changes.every(e => e.data.attribution === 'unknown' && e.data.intermediateWrites === 'unknown'));
    assert.ok(events.some(e => e.type === 'coverage.changed' && e.data.complete === false && /gap/.test(e.data.reason)));
    assert.equal(events.at(-1).data.complete, true);
    assert.equal(events.at(-1).data.historicalComplete, false);
    await observer.reconcile();
    assert.equal(events.filter(e => e.type === 'file.observed').length, 2);
    assert.ok(events.every((e, i) => e.sourceSeq === i + 1));
  } finally { observer?.close(); await rm(root, { recursive: true, force: true }); }
});

test('unsupported oversized content and escaped symlinks leave visible coverage gaps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'collab-confine-'));
  let observer;
  const events = [];
  try {
    await writeFile(join(root, 'large.mjs'), '0123456789');
    observer = await observeFiles({ root, paths: ['large.mjs'], maxBytes: 4, onObservation: event => events.push(event), intervalMs: 10_000 });
    assert.equal(events.at(-1).data.complete, false);
    assert.equal(events.filter(e => e.type === 'file.observed').length, 0);
    await rm(join(root, 'large.mjs'));
    await symlink('/etc/hosts', join(root, 'large.mjs'));
    await observer.reconcile();
    assert.ok(events.some(e => e.type === 'coverage.changed' && /escaped/.test(e.data.reason ?? '')));
    assert.equal(events.at(-1).data.complete, false);
    await rm(join(root, 'large.mjs'));
    await writeFile(join(root, 'large.mjs'), 'ok');
    await observer.reconcile();
    assert.equal(events.at(-1).data.complete, true);
    assert.equal(events.filter(e => e.type === 'file.observed').at(-1).data.hash, hash('ok'));
  } finally { observer?.close(); await rm(root, { recursive: true, force: true }); }
});

test('periodic reconciliation of unchanged bytes emits no activity churn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'collab-quiet-'));
  let observer;
  const events = [];
  try {
    await writeFile(join(root, 'file.mjs'), 'same');
    observer = await observeFiles({ root, paths: ['file.mjs'], onObservation: event => events.push(event), intervalMs: 10, watchImpl: () => Object.assign(new EventEmitter(), { close() {} }) });
    const count = events.length;
    await new Promise(resolve => setTimeout(resolve, 45));
    assert.equal(events.length, count);
    observer.close();
    await writeFile(join(root, 'file.mjs'), 'after close');
    await observer.reconcile();
    assert.equal(events.length, count);
  } finally { observer?.close(); await rm(root, { recursive: true, force: true }); }
});
