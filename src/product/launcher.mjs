/**
 * The launcher: what actually runs inside a participant's container.
 *
 * This is the piece that decides whether the workspace learns anything true.
 *
 * The ordering is deliberate. The workspace supplies this script, fetches the tree the
 * participant is entitled to, starts the participant as a child of it, and only then
 * walks the tree and sends the manifest. So the file listing is produced by the
 * workspace's own code rather than assembled by the thing being measured.
 *
 * What that actually enforces, and where it stops
 *
 * Most of what follows is conditioned on one thing: this reporter runs unmodified. A
 * participant is root in its own container, and this script and its reporter are files
 * on the same filesystem it can write, so a determined participant can replace them and
 * describe whatever it likes. Snapshot isolation would close that and is unavailable on
 * this account. Read every dependent claim here as holding *unless* the reporter is
 * replaced.
 *
 * Enforced regardless of the reporter, because these are properties of the receiving
 * end rather than of the code that sends:
 *
 *   - The workspace stores the bytes it received, never bytes described by a hash. The
 *     hash is recomputed on arrival, so a commit cannot be stored under a hash its
 *     content does not match.
 *   - A participant cannot reach another workspace. Its egress is intercepted into the
 *     gate, and the gate resolves the workspace itself rather than accepting a name.
 *   - A participant cannot act as another. The container token is minted by the
 *     workspace for exactly one container and checked on every commit.
 *
 * Dependent on the reporter being unmodified:
 *
 *   - The file list is trustworthy. A replaced reporter can fabricate it.
 *   - The bytes came from the container filesystem. A replaced reporter can send any
 *     bytes at all; the workspace can prove they hash to what was declared, not that
 *     they were ever written to disk.
 *   - Nothing was omitted. A hidden change is simply never sent.
 *
 * The asymmetry is what makes this safe rather than merely weak. A participant that
 * replaces the reporter can lie in one direction only, and it costs that participant its
 * own work: nothing it does corrupts another participant's view, because the fence
 * decides from revisions the workspace itself holds.
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
 * @param {number} [options.maxFileBytes] files above this are not committed
 *
 * `workDir` is deliberately not a parameter. It reaches the container as
 * `INGRESS_WORK_DIR` in the environment, and a value interpolated into this script
 * could rewrite the script — see the note at the body below.
 */
export function launcherScript({
  participantCommand,
  maxFileBytes = 262144,
} = {}) {
  if (typeof participantCommand !== 'string' || !participantCommand) {
    throw new TypeError('launcherScript requires a participantCommand');
  }

  // Every caller-supplied value is passed through the environment rather than
  // interpolated into the script body, so a value containing a quote, a newline, or a
  // $ cannot rewrite the launcher's own logic.
  //
  // `workDir` used to be interpolated here as `WORK='${workDir}'`, which was a shell
  // injection: a workDir of `'; <command>; #` closed the quote and ran whatever
  // followed, as root, before the participant command was even read. It is now read
  // from the environment like everything else. `decideStart` also validates the shape
  // of a workDir, so the value is constrained at the boundary and merely carried here.
  return [
    '#!/bin/sh',
    '# Workspace-supplied launcher. Written by the Worker, not by the participant.',
    `MANIFEST_VERSION='${MANIFEST_VERSION}'`,
    `MAX_FILE_BYTES='${maxFileBytes}'`,
    'WORK="${INGRESS_WORK_DIR:-/workspace}"',
    'PARTICIPANT_COMMAND="$INGRESS_PARTICIPANT_COMMAND"',
    // Declared up front rather than only inside the branch that sets it, so reading the
    // script top to bottom does not leave a variable appearing from nowhere.
    'LEASE_RENEWER=\'\'',
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
    '# Step 2: keep the write lease alive while the participant runs.',
    '#',
    '# Only when the workspace issued one at /start. The lease it issued is short by',
    '# design — the expiry is the bound, and this is what makes recovery fast when a',
    '# participant dies holding a file. A participant command that outran a lease it',
    '# could not renew had its commit refused with `lease_required`, which is the',
    '# interaction this fixes. `INGRESS_LEASE_MS` is the duration it was granted, sent',
    '# back verbatim so a renewal re-applies the same length instead of shortening it.',
    'if [ -n "$INGRESS_LEASE_ID" ]; then',
    '  node /tmp/ingress-reporter.cjs --renew "$INGRESS_RENEW_INTERVAL_MS" >>/tmp/ingress-lease.log 2>&1 &',
    '  LEASE_RENEWER=$!',
    'fi',
    '',
    '# Step 3: the participant runs, bounded, and its exit status is recorded rather than',
    '# swallowed.',
    '#',
    '# `timeout` is the only thing here that actually stops work. The workspace gives up',
    '# *waiting* at its deadline; that bounds the caller, not the bill. Without this, a',
    '# command that never exits keeps its container alive indefinitely — and since',
    '# `container.stop` does not exist on this runtime, nothing else could stop it.',
    '#',
    '# `-k` escalates to SIGKILL, because a participant that ignores SIGTERM would otherwise',
    '# be the hole this closes.',
    '#',
    '# `timeout` exits 124 when it had to kill the command, so the gate learns the difference',
    '# between "finished" and "was stopped" without this script inventing it.',
    'if [ -n "$INGRESS_RUN_SECONDS" ] && command -v timeout >/dev/null 2>&1; then',
    '  timeout -k "$INGRESS_KILL_GRACE_SECONDS" "$INGRESS_RUN_SECONDS" sh -c "$PARTICIPANT_COMMAND" >>/tmp/ingress-participant.log 2>&1',
    'else',
    '  # No `timeout` in the image: the command is unbounded here and the workspace is the',
    '  # only bound, which is the hole this branch exists to be honest about.',
    '  echo "INGRESS-NO-TIMEOUT no timeout(1); this run is bounded only by the caller" >>/tmp/ingress-participant.log',
    '  sh -c "$PARTICIPANT_COMMAND" >>/tmp/ingress-participant.log 2>&1',
    'fi',
    'PARTICIPANT_EXIT=$?',
    '',
    '# Step 4: report what changed, carrying the revisions the participant started from.',
    '#',
    '# Before the lease is given up, deliberately. The commit is refused without a live',
    '# write lease, so releasing first would guarantee the refusal.',
    'node /tmp/ingress-reporter.cjs "$PARTICIPANT_EXIT" >>/tmp/ingress-participant.log 2>&1',
    '',
    '# Step 5: stop renewing, and hand the lease back so anyone blocked on these paths',
    '# can proceed now rather than at the expiry. Best effort: the workspace also releases',
    '# it when the container exits, so a failure here costs a lease period, not a stall.',
    'if [ -n "$INGRESS_LEASE_ID" ]; then',
    '  kill "$LEASE_RENEWER" 2>/dev/null',
    '  wait "$LEASE_RENEWER" 2>/dev/null',
    '  node /tmp/ingress-reporter.cjs --release >>/tmp/ingress-lease.log 2>&1',
    'fi',
    '',
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
 * This string is the cross-boundary contract, and it is the part that could not be
 * tested until `INGRESS_REVISIONS_PATH` became overridable. It used to be a hardcoded
 * `/tmp/ingress-revisions.json`, which meant the reporter could only ever run inside a
 * container — the one place it is hardest to observe. `test/product-launcher.test.mjs`
 * now executes this exact string under Node against a stub gate and asserts the shape
 * of what it sends.
 *
 * NOTE: this is embedded in a template literal, so it contains no backticks. That is not
 * a style preference: a backtick in a comment here terminates the literal and the module
 * fails to parse with an error pointing at unrelated code. It happened while writing the
 * test below, so `test/product-launcher.test.mjs` asserts this string parses as a
 * function body — cheaply, and long before anything tries to run it in a container.
 */
export const CONTAINER_REPORTER = String.raw`
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Four modes, chosen by the first argument:
 *
 *   --seed              take the tree the workspace is entitled to hand over
 *   --renew <ms>        hold a lease alive, in a loop, until killed
 *   --release           give that lease up so others need not wait for the expiry
 *   <exit status>       report what changed
 *
 * The last one is a bare number rather than a flag because it is the participant's own
 * exit status, passed through from the shell so the gate learns whether the container
 * crashed after doing real work.
 */
const arg = process.argv[2];
const SEED_MODE = arg === '--seed';
const RENEW_MODE = arg === '--renew';
const RELEASE_MODE = arg === '--release';
const participantExit = SEED_MODE || RENEW_MODE || RELEASE_MODE
  ? null
  // Number(arg) is NaN for anything unrecognised, and NaN is what the gate would store
  // as an exit code. Absent rather than silently coerced to zero: zero means success.
  : (Number.isFinite(Number(arg)) ? Number(arg) : null);

const workDir = process.env.INGRESS_WORK_DIR || '/workspace';
const maxFileBytes = Number(process.env.INGRESS_MAX_FILE_BYTES || 262144);
const workspace = process.env.INGRESS_WORKSPACE;
const participantId = process.env.INGRESS_PARTICIPANT;
const token = process.env.INGRESS_TOKEN;

const leaseId = process.env.INGRESS_LEASE_ID || '';
// The duration the workspace granted, sent back verbatim. The heartbeat handler
  // computes expiresAt as now plus leaseMs, so re-applying a *shorter* duration would
  // quietly shorten the lease on its first renewal and lose it part-way through the run.
const leaseMs = Number(process.env.INGRESS_LEASE_MS || 0) || undefined;

const REVISIONS_PATH = process.env.INGRESS_REVISIONS_PATH || '/tmp/ingress-revisions.json';

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

  fs.mkdirSync(path.dirname(REVISIONS_PATH), { recursive: true });
  fs.writeFileSync(REVISIONS_PATH, JSON.stringify(revisions));
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
    // Our own bookkeeping is not workspace content.
    //
    // Compared as resolved absolute paths. This used to compare the path relative to the
    // work directory against REVISIONS_PATH, which is absolute, so it never matched. It
    // was harmless only because the file lives in /tmp, outside the tree being walked,
    // which is a coincidence rather than a guard. Found by running this reporter for the
    // first time outside a container.
    if (full === path.resolve(REVISIONS_PATH)) continue;
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
  let baseKnown = true;
  try {
    revisions = JSON.parse(fs.readFileSync(REVISIONS_PATH, 'utf8'));
  } catch {
    // Loud, because this is the difference between the fence judging a change
    // against what the participant started from and judging it against nothing.
    // The lease still gates the write either way — but a silent loss of the base
    // is exactly the class of degradation this project keeps finding.
    baseKnown = false;
    console.log('INGRESS-BASE-UNKNOWN the revisions file is missing; committing without declared base revisions');
  }

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
    baseKnown: baseKnown,
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

/**
 * Keep the lease alive until this process is killed.
 *
 * Sleeps first, then renews: the workspace issued the lease moments ago and it is not
 * near its expiry, so an immediate renewal would be a request that buys nothing.
 *
 * A refusal ends the loop rather than being retried. The workspace distinguishes "your
 * lease lapsed" from "that is not your lease" from "no such lease", and in every case the
 * claim this container is making is no longer true. Carrying on would let the participant
 * keep working on the assumption that it holds files it does not — and its commit would
 * be refused at the end anyway, after it had spent the whole run believing otherwise. The
 * message goes to the participant's own log, which is the only place it can be read.
 */
async function renew(intervalMs) {
  if (!leaseId) {
    console.log('INGRESS-LEASE-NO-ID nothing to renew; no lease id was issued to this container');
    return;
  }
  console.log('INGRESS-LEASE-RENEWING ' + JSON.stringify({ leaseId: leaseId, everyMs: intervalMs }));
  for (;;) {
    await sleep(intervalMs);
    let res;
    try {
      res = await fetch('http://workspace.internal/lease/heartbeat', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ leaseId: leaseId, participantId: participantId, leaseMs: leaseMs }),
      });
    } catch (error) {
      // A transport failure is not a refusal. It may be the container being stopped
      // mid-flight, in which case nothing is listening and nothing is reading. Not
      // exiting here means a briefly unreachable gate cannot silently end the renewal.
      console.log('INGRESS-LEASE-UNREACHABLE ' + (error && error.message));
      continue;
    }
    if (!res.ok) {
      console.log('INGRESS-LEASE-LOST ' + res.status + ' ' + await res.text());
      return;
    }
    const answer = await res.json();
    console.log('INGRESS-LEASE-RENEWED ' + JSON.stringify({
      expiresInMs: answer.expiresAt - Date.now(),
    }));
  }
}

/**
 * Give the lease up.
 *
 * Best effort by design. The workspace also releases it when the container exits, so a
 * failure here costs one lease period of waiting rather than a stall, and the commit has
 * already been made by the time this runs.
 */
async function release() {
  if (!leaseId) return;
  try {
    const res = await fetch('http://workspace.internal/lease/release', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ leaseId: leaseId, participantId: participantId }),
    });
    console.log('INGRESS-LEASE-RELEASED ' + res.status + ' ' + await res.text());
  } catch (error) {
    console.log('INGRESS-LEASE-RELEASE-FAILED ' + (error && error.message));
  }
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

(async function () {
  try {
    if (SEED_MODE) await seed();
    else if (RENEW_MODE) await renew(Number(process.argv[3]) || 15000);
    else if (RELEASE_MODE) await release();
    else await commit();
  } catch (error) {
    console.log('INGRESS-REPORTER-FAILED ' + (error && error.message));
  }
})();
`;