/**
 * The launcher: what actually runs inside a participant's container.
 *
 * This is the piece that decides whether the workspace learns anything true.
 *
 * The ordering is the whole point. The workspace supplies this script, fetches the
 * tree the participant is entitled to, starts the participant as a child of it, and
 * only then walks the tree and sends the manifest. So the file listing is produced
 * by the workspace's own code rather than assembled by the thing being measured —
 * the participant does not get to describe its own changes.
 *
 * What that does and does not buy, stated precisely:
 *
 *   - The workspace cannot be fed a fabricated file list.
 *   - The bytes it stores are the bytes that were actually sent, hashed on arrival.
 *   - A participant can still modify this script, since it is root in its own
 *     container and the script is on the same filesystem. Snapshot isolation would
 *     close that and is unavailable on this account (see
 *     docs/container-commit-report.md). So this raises the bar for a careless or
 *     casual defector; it does not stop a determined one.
 *
 * The seed is not optional. A container whose gate only accepts writes is sealed:
 * the participant would build its work against an empty directory, and the fence
 * would be judging changes made against a tree it never received.
 *
 * The revisions file is the other half. It records the revision each seeded file
 * was at, and the reporter sends those as baseRevision with the commit. That is
 * what makes the fence's base-revision check live rather than dead code.
 *
 * Kept as a string rather than a file to upload because a container is booted with
 * an entrypoint, and an entrypoint cannot fetch code the workspace did not inline.
 */

import { MANIFEST_VERSION } from './manifest.mjs';

/**
 * @param {object} options
 * @param {string} options.participantCommand shell command the participant runs
 * @param {string} [options.workDir] directory treated as the workspace
 * @param {number} [options.maxFileBytes] files above this are not committed
 */
export function launcherScript({
  participantCommand,
  workDir = '/workspace',
  maxFileBytes = 262144,
} = {}) {
  if (typeof participantCommand !== 'string' || !participantCommand) {
    throw new TypeError('launcherScript requires a participantCommand');
  }

  // The participant command is passed through the environment rather than
  // interpolated into the script body, so a command containing quotes, newlines,
  // or a $ cannot rewrite the launcher's own logic.
  return [
    '#!/bin/sh',
    '# Workspace-supplied launcher. Written by the Worker, not by the participant.',
    `MANIFEST_VERSION='${MANIFEST_VERSION}'`,
    `WORK='${workDir}'`,
    `MAX_FILE_BYTES='${maxFileBytes}'`,
    'PARTICIPANT_COMMAND="$INGRESS_PARTICIPANT_COMMAND"',
    '',
    // The reporter is inlined rather than fetched. A container is booted with an
    // entrypoint and has no route out except the gate, so a reporter that had to
    // be downloaded would be one that could not be trusted to arrive. Quoted
    // heredoc, so nothing in the JS below is expanded by the shell.
    //
    // It goes in /tmp, not /. The container filesystem root is read-only, so a
    // reporter written to / fails after the participant has already run — and the
    // failure is invisible from outside, because the participant's work is simply
    // never reported. The .cjs extension matters too: .mjs would be parsed as an ES
    // module, where require() does not exist.
    "cat > /tmp/ingress-reporter.cjs <<'INGRESS_REPORTER_EOF'",
    CONTAINER_REPORTER.trimEnd(),
    'INGRESS_REPORTER_EOF',
    '',
    'mkdir -p "$WORK" 2>/dev/null',
    '',
    '# Step 1: receive the tree this participant is entitled to start from.',
    '# A refusal here is logged and the participant still runs — an empty workspace',
    '# is a legitimate state, and refusing to work would be worse than working blind.',
    'node /tmp/ingress-reporter.cjs --seed >>/tmp/ingress-participant.log 2>&1',
    '',
    '# Step 2: the participant runs, to completion. Nothing below runs until it exits,',
    '# and its exit status is recorded rather than swallowed.',
    'sh -c "$PARTICIPANT_COMMAND" >>/tmp/ingress-participant.log 2>&1',
    'PARTICIPANT_EXIT=$?',
    '',
    '# Step 3: report what changed, carrying the revisions the participant started from.',
    'node /tmp/ingress-reporter.cjs "$PARTICIPANT_EXIT" >>/tmp/ingress-participant.log 2>&1',
    'cat /tmp/ingress-participant.log',
    'exit $PARTICIPANT_EXIT',
  ].join('\n');
}

/**
 * The in-container program, in two modes.
 *
 * Written in Node because the image is Debian-with-Node (measured, not assumed —
 * see docs/container-commit-report.md) and Node gives one JSON encoder for both
 * hashing and transport, so the manifest cannot be malformed by shell quoting.
 *
 * NOTE: this is embedded in a template literal, so it contains no backticks.
 */
export const CONTAINER_REPORTER = String.raw`
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SEED_MODE = process.argv[2] === '--seed';
const participantExit = SEED_MODE ? null : Number(process.argv[2]);
const workDir = process.env.INGRESS_WORK_DIR || '/workspace';
const maxFileBytes = Number(process.env.INGRESS_MAX_FILE_BYTES || 262144);
const workspace = process.env.INGRESS_WORKSPACE;
const participantId = process.env.INGRESS_PARTICIPANT;
const token = process.env.INGRESS_TOKEN;

const REVISIONS_PATH = '.ingress/revisions.json';

function headers() {
  return {
    'content-type': 'application/json',
    'x-ingress-workspace': workspace,
    'x-ingress-participant': participantId,
    'x-ingress-token': token,
  };
}

/**
 * Fetch the workspace's admitted content for this participant and write it down.
 *
 * Also records the revision each file arrived at, which the commit then sends as
 * baseRevision. Without it a participant could overwrite a file it received at
 * revision 4 while the workspace is at revision 9, and nothing would notice.
 */
async function seed() {
  const res = await fetch('http://workspace.internal/seed', { headers: headers() });
  const text = await res.text();
  if (!res.ok) {
    console.log('INGRESS-SEED-REFUSED ' + res.status + ' ' + text);
    return;
  }
  const payload = JSON.parse(text);

  const revisions = {};
  let written = 0;
  for (const file of payload.files) {
    // Absent stays absent. Materialising an empty file for a path the workspace
    // has never seen would destroy a file the participant never saw either.
    if (!file.exists || file.contentBase64 == null) continue;
    const target = path.join(workDir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(file.contentBase64, 'base64'));
    revisions[file.path] = file.revision;
    written += 1;
  }

  fs.mkdirSync(path.join(workDir, '.ingress'), { recursive: true });
  fs.writeFileSync(path.join(workDir, REVISIONS_PATH), JSON.stringify(revisions));
  console.log('INGRESS-SEED ' + JSON.stringify({
    leased: (payload.leasedPaths || []).length,
    written: written,
    fingerprint: payload.fingerprint,
  }));
}

function walk(dir, base, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  entries.sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = base ? base + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) continue;          // never follow a link out of the tree
    if (rel === REVISIONS_PATH) continue;          // our own bookkeeping is not workspace content
    if (entry.isDirectory()) { walk(full, rel, out); continue; }
    if (!entry.isFile()) continue;
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.size > maxFileBytes) {
      out.push({ path: rel, skipped: 'too_large', byteLength: stat.size });
      continue;
    }
    let bytes;
    try { bytes = fs.readFileSync(full); } catch { continue; }
    out.push({
      path: rel,
      byteLength: bytes.length,
      contentHash: crypto.createHash('sha256').update(bytes).digest('hex'),
      contentBase64: bytes.toString('base64'),
    });
  }
  return out;
}

async function commit() {
  // What the participant started from, per path. Absent for a path it was never
  // seeded with, which is exactly right: it has no base to claim.
  let revisions = {};
  try {
    revisions = JSON.parse(fs.readFileSync(path.join(workDir, REVISIONS_PATH), 'utf8'));
  } catch {}

  const files = walk(workDir, '', []);
  for (const file of files) {
    const base = revisions[file.path];
    if (base != null) file.baseRevision = base;
  }
  files.sort(function (a, b) { return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0); });

  const body = JSON.stringify({
    manifestVersion: process.env.INGRESS_MANIFEST_VERSION,
    participantId: participantId,
    participantExit: participantExit,
    files: files,
  });

  const res = await fetch('http://workspace.internal/commit', {
    method: 'POST',
    headers: headers(),
    body: body,
  });
  const text = await res.text();
  // Also written to stdout: the gate's verdict is the last thing the participant's
  // container ever says, and it should be legible.
  console.log('INGRESS-COMMIT ' + res.status + ' ' + text);
}

(async function () {
  try {
    if (SEED_MODE) await seed();
    else await commit();
  } catch (error) {
    console.log('INGRESS-REPORTER-FAILED ' + (error && error.message));
  }
})();
`;