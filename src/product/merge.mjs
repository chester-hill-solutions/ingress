/**
 * The merge: reconcile a participant's edit with what landed while it worked.
 *
 * Why this exists
 *
 * The fence used to refuse. When a participant's declared base had moved -- someone else
 * landed a change to the same file -- `evaluateCommit` returned `write_base_stale` and the
 * work was discarded. The contention trial measured what that costs: five of six *disjoint*
 * same-file edits refused, each one correct, none of them in conflict with anything. A refusal
 * that throws away correct work is the wrong default when the two edits could simply be
 * combined.
 *
 * Three independent efforts converged on the same answer. agent-semaphore measured that
 * "conflicts are removed by the catch-up, not by the claim", and that its write hook never
 * fired once in 40 live runs. CAID integrates by merge. Git resolves divergence by merging.
 * This is that mechanism, and it is the one the product was missing.
 *
 * Why the base is exact
 *
 * A git three-way merge infers its base -- the merge-base is a commit, and the common ancestor
 * of two lines has to be discovered. This product does not infer: every commit declares the
 * revision each file was built from (`baseRevision`, and per-input `builtFrom`), and the
 * content store retains the bytes. So the base here is not a guess. That is the whole
 * difference, and it is the one thing the worktree-and-merge crowd does not have.
 *
 * What it is not
 *
 * It is a *textual* line merge. Two edits that are textually clean and semantically broken --
 * one moves every caller onto a new service while another extends the old one -- merge without
 * a conflict and are wrong. Only a test gate catches that; agent-semaphore measured it (their
 * WME column) and found every advisory layer blind to it. This module does not pretend
 * otherwise.
 *
 * Pure and synchronous. No I/O, no Cloudflare, no git. The decision is the part that has to be
 * correct, and correctness is testable without an account.
 */

/**
 * A cap on the line count this will diff.
 *
 * The diff is a longest-common-subsequence table, so memory is O(n*m). At the cap of 1500
 * lines that is a few megabytes; past it the merge is *refused*, never approximated. Refusing
 * is safe -- the caller falls back to the old behaviour, a refusal -- whereas a wrong merge
 * would silently corrupt a file. Most source files are far under the cap; a generated file is
 * not, and refusing it is the honest answer.
 */
export const MAX_MERGE_LINES = 1500;

/** Split into lines, keeping the terminator on the line it ends, so joining is exact. */
function splitLines(text) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) {
      lines.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** Longest common subsequence of two line arrays, as matched index pairs. */
function lcsPairs(a, b) {
  const n = a.length, m = b.length, width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + (j + 1)] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) i++;
    else j++;
  }
  return pairs;
}

/**
 * The changes that turn `base` into `other`, as hunks over base indices.
 *
 * A hunk `{ start, end, lines }` means base[start:end] was replaced by `lines`. A pure
 * insertion has `start === end`. Hunks are ordered and do not overlap within one side.
 */
function hunks(base, other) {
  const pairs = lcsPairs(base, other);
  const out = [];
  let baseIndex = 0, otherIndex = 0;
  for (const [matchBase, matchOther] of pairs) {
    if (matchBase > baseIndex || matchOther > otherIndex) {
      out.push({ start: baseIndex, end: matchBase, lines: other.slice(otherIndex, matchOther) });
    }
    baseIndex = matchBase + 1;
    otherIndex = matchOther + 1;
  }
  if (base.length > baseIndex || other.length > otherIndex) {
    out.push({ start: baseIndex, end: base.length, lines: other.slice(otherIndex) });
  }
  return out;
}

/** Do a region and a hunk touch the same base lines -- or the same insertion point? */
function overlaps(region, hunk) {
  const regionIsInsertion = region.start === region.end;
  const hunkIsInsertion = hunk.start === hunk.end;
  if (regionIsInsertion && hunkIsInsertion) return region.start === hunk.start;
  if (regionIsInsertion) return hunk.start < region.start && region.start < hunk.end;
  if (hunkIsInsertion) return region.start < hunk.start && hunk.start < region.end;
  return hunk.start < region.end && region.start < hunk.end;
}

/** The lines one side produces for base[start:end], applying that side's hunks in range. */
function applySide(base, sideHunks, start, end) {
  const out = [];
  let position = start;
  for (const hunk of sideHunks) {
    if (hunk.start < start || hunk.start > end) continue;
    if (hunk.start === hunk.end) {
      if (hunk.start < position) continue;
      for (let index = position; index < hunk.start; index++) out.push(base[index]);
      out.push(...hunk.lines);
      position = hunk.start;
      continue;
    }
    if (hunk.end <= start || hunk.start >= end) continue;
    for (let index = position; index < hunk.start; index++) out.push(base[index]);
    out.push(...hunk.lines);
    position = Math.max(position, hunk.end);
  }
  for (let index = position; index < end; index++) out.push(base[index]);
  return out;
}

const sameLines = (left, right) => left.length === right.length && left.every((line, index) => line === right[index]);

/**
 * Merge two edits of one file against the revision they were both built from.
 *
 * @param {string} baseText    the revision the participant declared it built from
 * @param {string} oursText    what the participant produced
 * @param {string} theirsText  what landed while it worked
 * @returns {{ clean: boolean, text: string|null, conflicts: Array<{start:number,end:number,ours:string[],theirs:string[]}>, refused?: boolean }}
 */
export function mergeText(baseText, oursText, theirsText) {
  if (typeof baseText !== 'string' || typeof oursText !== 'string' || typeof theirsText !== 'string') {
    throw new TypeError('mergeText requires three strings');
  }
  // A side that did not move is not a merge at all, and short-circuiting it keeps the
  // common case -- only one writer actually changed the file -- from touching the diff.
  if (oursText === baseText) return { clean: true, text: theirsText, conflicts: [] };
  if (theirsText === baseText) return { clean: true, text: oursText, conflicts: [] };
  if (oursText === theirsText) return { clean: true, text: oursText, conflicts: [] };

  const base = splitLines(baseText), ours = splitLines(oursText), theirs = splitLines(theirsText);
  if (base.length > MAX_MERGE_LINES || ours.length > MAX_MERGE_LINES || theirs.length > MAX_MERGE_LINES) {
    // Refused, not approximated. The caller falls back to a refusal, which loses work but
    // never corrupts a file.
    return { clean: false, text: null, conflicts: [], refused: true };
  }

  const oursHunks = hunks(base, ours);
  const theirsHunks = hunks(base, theirs);

  // Group hunks from both sides into regions where they touch the same base lines. Adjacent
  // edits -- ours on line 5, theirs on line 6 -- do *not* share a line, so they stay separate
  // regions and merge cleanly. Only genuinely overlapping edits become a conflict.
  const all = [...oursHunks, ...theirsHunks].sort((left, right) => left.start - right.start || left.end - right.end);
  const regions = [];
  for (const hunk of all) {
    const last = regions[regions.length - 1];
    if (last && overlaps(last, hunk)) last.end = Math.max(last.end, hunk.end);
    else regions.push({ start: hunk.start, end: hunk.end });
  }

  const out = [];
  const conflicts = [];
  let position = 0;
  for (const region of regions) {
    for (let index = position; index < region.start; index++) out.push(base[index]);
    const oursReplacement = applySide(base, oursHunks, region.start, region.end);
    const theirsReplacement = applySide(base, theirsHunks, region.start, region.end);
    const baseReplacement = base.slice(region.start, region.end);

    if (sameLines(oursReplacement, theirsReplacement)) out.push(...oursReplacement);
    else if (sameLines(oursReplacement, baseReplacement)) out.push(...theirsReplacement);
    else if (sameLines(theirsReplacement, baseReplacement)) out.push(...oursReplacement);
    else {
      conflicts.push({ start: region.start, end: region.end, ours: oursReplacement, theirs: theirsReplacement });
      out.push('<<<<<<< ours\n', ...oursReplacement, '=======\n', ...theirsReplacement, '>>>>>>> theirs\n');
    }
    position = region.end;
  }
  for (let index = position; index < base.length; index++) out.push(base[index]);

  return { clean: conflicts.length === 0, text: out.join(''), conflicts };
}

/** True when a buffer looks binary: a NUL in the first stretch is the usual heuristic. */
function looksBinary(bytes) {
  const limit = Math.min(bytes.byteLength, 8000);
  for (let index = 0; index < limit; index++) if (bytes[index] === 0) return true;
  return false;
}

/**
 * Merge three byte arrays as UTF-8 text.
 *
 * A binary file is never merged -- a line merge of a PNG is meaningless and a conflict marker
 * inside one corrupts it. It is refused, and the caller falls back to a refusal.
 */
export function mergeBytes(baseBytes, oursBytes, theirsBytes) {
  if (looksBinary(baseBytes) || looksBinary(oursBytes) || looksBinary(theirsBytes)) {
    return { clean: false, bytes: null, conflicts: [], binary: true };
  }
  const decoder = new TextDecoder();
  const result = mergeText(decoder.decode(baseBytes), decoder.decode(oursBytes), decoder.decode(theirsBytes));
  if (result.refused || result.text === null) return { clean: false, bytes: null, conflicts: [], refused: result.refused === true };
  return { clean: result.clean, bytes: new TextEncoder().encode(result.text), conflicts: result.conflicts, binary: false };
}
