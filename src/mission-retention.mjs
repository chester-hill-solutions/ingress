import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * What a flight keeps of its own trace, and what it says it dropped.
 *
 * The gap this closes: a flight records its *aggregate* faithfully -- per-actor outcomes, tool
 * calls, usage, the verifier's checks at each observation band -- and the artifact *bytes* are
 * frozen into the blind review when a cohort settles. What is not kept is the trace in between:
 * the fence receipts (every native tool call with the allow/deny decision) and the workspace
 * tree. They live in temp directories, so "what did it look like at ninety seconds" is
 * answerable from hashes and "show me the file" is not.
 *
 * The planner is separated from the copying for the usual reason: what to keep, what to refuse,
 * and what to admit it dropped are decisions, and decisions are worth testing without a
 * filesystem. The rules are deliberately conservative:
 *
 *   - a file over the per-file cap is not copied, and is counted, not silently skipped
 *   - once the total cap is reached the remaining files are counted as truncated, so a reader
 *     can tell a complete trace from a partial one
 *   - a path that is absolute or escapes the workspace is refused outright: this walks a
 *     directory it did not create, and a trace is not worth a traversal
 *   - a capture is labelled with when it happened relative to the flight. A trace taken from a
 *     running cohort is a *snapshot of a moving object* and must never be presented as the
 *     settled artifact -- the blind review's frozen sample is that, and this is not.
 */

const DIRECTORY = /^(?!\.{1,2}$)[\w .@+-]{1,80}$/;

export const retentionLimits = Object.freeze({
  /** A single file larger than this is not trace material; it is a build artefact or a database. */
  fileBytes: 512 * 1024,
  /** Total copied bytes across every cohort of one flight. */
  totalBytes: 64 * 1024 * 1024,
  /** The receipts log, which is appended to while a cohort runs. */
  receiptsBytes: 8 * 1024 * 1024,
  /** Files per cohort, so a pathological tree cannot walk forever. */
  files: 2000,
});

/** Refuse a path that is absolute, escapes, or names something other than a plain segment. */
export function tracePath(value, label) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.startsWith('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`invalid_trace_path:${label}`);
  }
  const segments = value.split('/');
  for (const segment of segments) if (!DIRECTORY.test(segment)) throw new Error(`invalid_trace_path:${label}`);
  return value;
}

/**
 * Decide what to copy for one flight.
 *
 * @param {object} input
 * @param {Array} input.cohorts `[{id, workspace, receipts}]` as the evidence records them
 * @param {object} input.inventory `{ [cohortId]: [{path, bytes}] }` -- what the walk found
 * @param {object} input.receipts `{ [cohortId]: bytes | null }` -- receipts size, or null
 * @param {string} input.capture `'settled' | 'running' | 'post-hoc'`
 * @param {object} input.limits
 */
export function retentionPlan({ cohorts = [], inventory = {}, receipts = {}, capture = 'settled', limits = retentionLimits } = {}) {
  if (!['settled', 'running', 'post-hoc'].includes(capture)) throw new Error('invalid_capture_basis');
  const plan = { capture, cohorts: [], totalBytes: 0, files: 0, truncated: [], oversized: [], refused: [] };

  for (const cohort of cohorts) {
    if (typeof cohort?.id !== 'string' || !cohort.id) throw new Error('invalid_trace_cohort');
    let id;
    try { id = tracePath(cohort.id, 'cohort'); } catch (error) { plan.refused.push({ id: cohort?.id ?? null, reason: String(error.message) }); continue; }

    const entry = { id, files: [], skipped: [], bytes: 0, receipts: null };

    if (Number.isFinite(receipts[id]) && receipts[id] > 0) {
      if (receipts[id] > limits.receiptsBytes) entry.receipts = { include: false, bytes: receipts[id], reason: 'over_receipts_cap' };
      else entry.receipts = { include: true, bytes: receipts[id] };
    }

    const files = Array.isArray(inventory[id]) ? inventory[id] : [];
    for (const file of files) {
      if (entry.files.length >= limits.files) { plan.truncated.push({ id, path: file?.path ?? null, reason: 'file_cap' }); continue; }
      let path;
      try { path = tracePath(file?.path, 'file'); } catch (error) { plan.refused.push({ id, path: file?.path ?? null, reason: String(error.message) }); continue; }
      const bytes = Number.isFinite(file?.bytes) && file.bytes >= 0 ? file.bytes : 0;
      if (bytes > limits.fileBytes) { plan.oversized.push({ id, path, bytes }); entry.skipped.push({ path, reason: 'over_file_cap' }); continue; }
      if (plan.totalBytes + bytes > limits.totalBytes) { plan.truncated.push({ id, path, reason: 'total_cap' }); continue; }
      plan.totalBytes += bytes;
      plan.files += 1;
      entry.bytes += bytes;
      entry.files.push({ path, bytes });
    }

    plan.cohorts.push(entry);
  }

  const dropped = plan.truncated.length + plan.oversized.length + plan.refused.length;
  return {
    ...plan,
    // Said plainly, because a trace that quietly stops being a trace is worse than one that
    // never claimed to be complete.
    complete: dropped === 0,
    note: capture === 'settled'
      ? 'Captured when the cohort settled: this is the artifact the blind review froze.'
      : capture === 'running'
        ? 'Captured while the cohort was still running: a snapshot of a moving object, not a settled artifact.'
        : 'Captured after the flight ended, from directories the harness left in place. Files written after the last observation band may be missing.',
  };
}

/**
 * Copy the trace a flight's evidence describes.
 *
 * Exported so the harness can call it at the moment a cohort settles, which is the only point at
 * which a capture is a record rather than a rescue, and so this script and that call cannot
 * diverge about what "keeping the trace" means.
 *
 * The receipts are located by *session id* rather than by directory name. The harness's state
 * directory is random and its path is not in the result, but every row it writes carries the
 * session that caused it, so a file that mentions one of this cohort's sessions is this cohort's
 * receipts. A cohort with none is recorded as having none, never guessed at.
 */
export async function retain({ evidence, directory, capture = 'settled', limits = retentionLimits }) {
  const cohorts = (evidence.results ?? [])
    .filter(result => typeof result?.workspace === 'string' && typeof result?.id === 'string')
    .map(result => ({
      id: result.id,
      workspace: result.workspace,
      sessions: [...new Set((result.actors ?? []).map(actor => actor?.sessionID).filter(session => typeof session === 'string'))],
    }));

  const inventory = {};
  const receipts = {};
  const located = {};
  for (const cohort of cohorts) {
    inventory[cohort.id] = await walkCohort(cohort.workspace);
    const found = await findReceipts(dirname(cohort.workspace), cohort.sessions);
    located[cohort.id] = found;
    receipts[cohort.id] = found === null ? null : (await stat(found)).size;
  }

  const plan = retentionPlan({ cohorts, inventory, receipts, capture, limits });
  const traces = join(directory, 'traces');
  await mkdir(traces, { recursive: true, mode: 0o700 });

  for (const cohort of plan.cohorts) {
    const source = cohorts.find(value => value.id === cohort.id).workspace;
    const target = join(traces, cohort.id);
    await mkdir(join(target, 'workspace'), { recursive: true, mode: 0o700 });
    for (const file of cohort.files) {
      const destination = join(target, 'workspace', file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(join(source, file.path), destination);
    }
    if (cohort.receipts?.include && located[cohort.id]) await copyFile(located[cohort.id], join(target, 'receipts.jsonl'));
    await writeFile(join(target, 'manifest.json'), JSON.stringify({
      cohort: cohort.id,
      workspace: source,
      capture,
      note: plan.note,
      files: cohort.files,
      receipts: cohort.receipts,
      skipped: cohort.skipped,
      // A trace claiming to be the graded artifact should point at the same hashes the grader
      // used, rather than assert its own equivalence.
      evidence: 'results[].seedSHA256 and results[].snapshots[].hashes in ../evidence-private.json',
    }, null, 2) + '\n', { mode: 0o600 });
  }

  await writeFile(join(traces, 'manifest.json'), JSON.stringify({
    flight: directory,
    capturedAt: new Date().toISOString(),
    capture,
    note: plan.note,
    limits,
    cohorts: plan.cohorts.map(cohort => ({ id: cohort.id, files: cohort.files.length, bytes: cohort.bytes, receipts: cohort.receipts })),
    truncated: plan.truncated,
    oversized: plan.oversized,
    refused: plan.refused,
    complete: plan.complete,
  }, null, 2) + '\n', { mode: 0o600 });

  return { directory: traces, plan };
}

/** The cohort's tree, without the parts that are not the work. */
export async function walkCohort(workspace, depth = 0, prefix = '') {
  if (depth > 8) return [];
  let entries = [];
  try { entries = await readdir(join(workspace, prefix), { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of entries) {
    if (['node_modules', '.git', '.opencode', '.ingress'].includes(entry.name)) continue;
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await walkCohort(workspace, depth + 1, path));
    else {
      let info;
      try { info = await stat(join(workspace, path)); } catch { continue; }
      out.push({ path, bytes: info.size });
    }
  }
  return out;
}

/** The receipts log belonging to a cohort, found by the sessions it names. */
export async function findReceipts(base, sessions) {
  if (sessions.length === 0) return null;
  let names = [];
  try { names = (await readdir(base)).filter(name => name.startsWith('ingress-benchmark-state-')); } catch { return null; }
  for (const name of names) {
    const candidate = join(base, name, 'receipts.jsonl');
    try {
      const rows = await readFile(candidate, 'utf8');
      if (sessions.some(session => rows.includes(session))) return candidate;
    } catch { /* no receipts here */ }
  }
  return null;
}
