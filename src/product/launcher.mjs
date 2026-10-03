/**
 * The launcher: what actually runs inside a participant's container.
 *
 * This is the piece that decides whether the workspace learns anything true.
 *
 * The ordering is the whole point. The workspace supplies this script, starts the
 * participant as a child of it, and only computes and sends the manifest *after*
 * the participant has exited. So the file listing is produced by the workspace's
 * code rather than assembled by the thing being measured — the participant does
 * not get to describe its own changes.
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
 * Kept as a string rather than a file to upload because a container is booted
 * with an entrypoint, and an entrypoint cannot fetch code the workspace did not
 * inline. The trade-off is that this is not directly unit-testable; what *is*
 * tested is the manifest contract it produces, against the same parser the
 * Durable Object uses.
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
  // or a `$` cannot rewrite the launcher's own logic.
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
    // reporter written to `/` fails after the participant has already run — and
    // the failure is invisible from outside, because the participant's work is
    // simply never reported. The .cjs extension matters too: .mjs would be parsed
    // as an ES module, where require() does not exist.
    "cat > /tmp/ingress-reporter.cjs <<'INGRESS_REPORTER_EOF'",
    CONTAINER_REPORTER.trimEnd(),
    'INGRESS_REPORTER_EOF',
    '',
    'mkdir -p "$WORK" 2>/dev/null',
    '',
    '# The participant runs first and to completion. Nothing below this line runs',
    '# until it has exited, and its exit status is recorded rather than swallowed.',
    'sh -c "$PARTICIPANT_COMMAND" >/tmp/ingress-participant.log 2>&1',
    'PARTICIPANT_EXIT=$?',
    '',
    'node /tmp/ingress-reporter.cjs "$PARTICIPANT_EXIT" >>/tmp/ingress-participant.log 2>&1',
    'cat /tmp/ingress-participant.log',
    'exit $PARTICIPANT_EXIT',
  ].join('\n');
}

/**
 * The in-container half: walk the tree, build the commit, POST it to the gate.
 *
 * Written in Node because the image is Debian-with-Node (measured, not assumed —
 * see docs/container-commit-report.md) and Node gives one JSON encoder for both
 * hashing and transport, so the manifest cannot be malformed by shell quoting.
 */
export const CONTAINER_REPORTER = String.raw`
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const participantExit = Number(process.argv[2] ?? 'null');
const workDir = process.env.INGRESS_WORK_DIR || '/workspace';
const maxFileBytes = Number(process.env.INGRESS_MAX_FILE_BYTES || 262144);
const workspace = process.env.INGRESS_WORKSPACE;
const participantId = process.env.INGRESS_PARTICIPANT;
const token = process.env.INGRESS_TOKEN;

function walk(dir, base, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = base ? base + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) continue;           // never follow a link out of the tree
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

const files = walk(workDir, '', []);
files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

const body = JSON.stringify({
  manifestVersion: process.env.INGRESS_MANIFEST_VERSION,
  participantId,
  participantExit,
  files,
});

(async () => {
  try {
    const res = await fetch('http://workspace.internal/commit', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ingress-workspace': workspace,
        'x-ingress-participant': participantId,
        'x-ingress-token': token,
      },
      body,
    });
    const text = await res.text();
    // Written to stdout as well as the log file: the gate's verdict is the last
    // thing the participant's container ever says, and it should be legible.
    console.log('INGRESS-COMMIT ' + res.status + ' ' + text);
  } catch (error) {
    console.log('INGRESS-COMMIT-FAILED ' + (error && error.message));
  }
})();
`;