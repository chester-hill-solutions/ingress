import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readMissionFile, missionBounds } from './mission-verifier.mjs';
import { observeFiles } from './file-observer.mjs';

/** Double collection detects ordinary concurrent changes, not an atomic filesystem snapshot. */
export async function gradeMissionSnapshot(fixture, root, verify) {
  const paths = Object.keys(fixture.files), files = {}, hashes = {}, started = performance.now();
  if (paths.length > missionBounds.files) throw Error('snapshot_scope_bounds');
  let bytes = 0, snapshot;
  try {
    for (const path of paths) { files[path] = await readMissionFile(root, path); bytes += Buffer.byteLength(files[path]); hashes[path] = createHash('sha256').update(files[path]).digest('hex'); }
    if (bytes > missionBounds.totalBytes) throw Error('snapshot_bytes_bounds');
    for (const path of paths) if (createHash('sha256').update(await readMissionFile(root, path)).digest('hex') !== hashes[path]) return { status: 'unstable', elapsedMs: performance.now() - started, basis: 'double_collection_changed' };
    snapshot = await mkdtemp(join(tmpdir(), 'ingress-mission-observation-'));
    for (const path of paths) { await mkdir(dirname(join(snapshot, path)), { recursive: true }); await writeFile(join(snapshot, path), files[path], { mode: 0o600 }); }
    const verification = await verify(fixture.id, snapshot);
    return { status: 'graded', elapsedMs: performance.now() - started, hashes, verification, basis: 'double_collection_stable_nonatomic_then_immutable_copy' };
  } catch { return { status: 'unavailable', elapsedMs: performance.now() - started, basis: 'bounded_confined_copy_failed' }; }
  finally { if (snapshot) await rm(snapshot, { recursive: true, force: true }); }
}
export function missionObserver(fixture, verify, milestones, onSnapshot) {
  return async options => {
    const observer = await observeFiles(options), start = performance.now(), timers = [];
    let pending = Promise.resolve(), closed = false;
    for (const targetMs of milestones) {
      const timer = setTimeout(() => {
        if (closed) return;
        pending = pending.then(async () => {
          if (closed) return;
          const observedAtMs = performance.now() - start;
          const result = await gradeMissionSnapshot(fixture, options.root, verify);
          onSnapshot({ targetMs, observedAtMs, ...result });
        }).catch(() => { onSnapshot({ targetMs, status: 'unavailable', basis: 'snapshot_runtime_failed' }); });
      }, targetMs);
      timer.unref(); timers.push(timer);
    }
    return { ...observer, close() { closed = true; for (const timer of timers) clearTimeout(timer); observer.close(); }, async settled() { await pending; } };
  };
}
