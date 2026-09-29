import { watch, constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, relative, isAbsolute, sep, dirname } from 'node:path';
import { declaredPath } from './workspace-state.mjs';

/** Observe declared native files, never infer author/read revision or every intermediate write. */
export async function observeFiles({ root, paths, onObservation, signal, intervalMs = 500, epoch = 'observer', maxBytes = 256 * 1024, watchImpl = watch }) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 128) throw new Error('declare 1–128 files');
  if (typeof onObservation !== 'function') throw new Error('observation callback required');
  if (!Number.isFinite(intervalMs) || intervalMs < 10) throw new Error('invalid reconciliation interval');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error('invalid bounded file size');
  root = await realpath(root);
  paths = [...new Set(paths.map(declaredPath))];
  let closed = false, sourceSeq = 0, pendingScan = null, coverageKey = null;
  const known = new Map(), watchers = [], dirty = new Set(), pendingPaths = new Set();
  function emit(type, data) {
    if (closed) return;
    onObservation({ id: randomUUID(), epoch, source: 'file-watcher', sourceSeq: ++sourceSeq, type, time: new Date().toISOString(), data });
  }
  function coverage(complete, reason) {
    const key = JSON.stringify([complete, reason]);
    if (key === coverageKey) return;
    coverageKey = key;
    emit('coverage.changed', { complete, reason, scope: 'current_declared_content', historicalComplete: false, intermediateWrites: 'unknown' });
  }
  async function confined(path) {
    const location = join(root, path);
    const resolved = await realpath(location);
    const rel = relative(root, resolved);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('declared file escaped workspace');
    return resolved;
  }
  async function inspect(path) {
    let hash;
    try {
      const location = await confined(path);
      const file = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size > maxBytes) throw new Error('declared file type/size unsupported');
        const buffer = Buffer.alloc(maxBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        const after = await file.stat();
        if (length > maxBytes || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || await confined(path) !== location) throw new Error('file changed during observation');
        const content = buffer.subarray(0, length);
        new TextDecoder('utf-8', { fatal: true }).decode(content);
        hash = createHash('sha256').update(content).digest('hex');
      } finally { await file.close(); }
    } catch (error) {
      if (error.code === 'ENOENT') hash = null;
      else { dirty.add(path); coverage(false, `${path}: ${error.message}`); return false; }
    }
    const previous = known.get(path);
    if (!previous || previous.hash !== hash) {
      const revision = (previous?.revision ?? 0) + 1;
      known.set(path, { hash, revision });
      emit('file.observed', { path, hash, revision, attribution: 'unknown', confidence: 'observed', intermediateWrites: 'unknown' });
    }
    dirty.delete(path);
    return true;
  }
  function schedule(pathsToScan, reason) {
    if (closed) return Promise.resolve();
    for (const path of pathsToScan) pendingPaths.add(path);
    if (reason) coverage(false, reason);
    if (!pendingScan) pendingScan = (async () => {
      while (!closed && pendingPaths.size) {
        const batch = [...pendingPaths];
        pendingPaths.clear();
        for (const path of batch) await inspect(path);
      }
      if (!closed) coverage(dirty.size === 0, dirty.size ? 'declared content reconciliation incomplete' : null);
    })().finally(() => { pendingScan = null; });
    return pendingScan;
  }
  await schedule(paths, 'initial baseline pending');
  const watchedDirs = [...new Set(paths.map(path => dirname(join(root, path))))];
  for (const directory of watchedDirs) {
    try {
      const watcher = watchImpl(directory, (_, filename) => {
        const requested = filename ? paths.filter(path => join(root, path) === join(directory, filename.toString())) : paths;
        if (requested.length) schedule(requested, filename ? null : 'watcher event lacks path; reconciling').catch(() => {});
      });
      watcher.on('error', error => { coverage(false, `watcher error: ${error.code ?? error.message}`); schedule(paths, 'watcher gap reconciliation').catch(() => {}); });
      watchers.push(watcher);
    } catch (error) { coverage(false, `watcher unavailable: ${error.code ?? error.message}`); }
  }
  const timer = setInterval(() => schedule(paths, null).catch(() => {}), intervalMs);
  timer.unref();
  const close = () => { closed = true; clearInterval(timer); for (const watcher of watchers) watcher.close(); signal?.removeEventListener('abort', close); };
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();
  return { close, reconcile: () => schedule(paths, 'explicit watcher-gap reconciliation') };
}
