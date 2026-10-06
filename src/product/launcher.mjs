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
 *   - A participant cannot reach another workspace *through the gate's workspace
 *     routes*. Its internal egress is intercepted into the gate, and the gate resolves
 *     the workspace itself rather than accepting a name. It can reach the open
 *     internet -- the sandbox model asks for that now -- but another workspace's
 *     `/internal/*` stays behind the same allow-list.
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
    // entrypoint, and what gets executed must not depend on what the image happened to
    // ship — a missing file fails at boot, not at commit time.
    // Written as a quoted heredoc, so nothing in the JS below is expanded by the shell.
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
    '# Step 1b: restore the build cache, so a second start does not re-install.',
    '#',
    '# Before the participant runs, so `npm test` finds `node_modules` already there. A miss',
    '# is normal and logged; the run proceeds either way.',
    'if [ -n "$INGRESS_CACHE_PATHS" ]; then',
    '  node /tmp/ingress-reporter.cjs --cache-restore >>/tmp/ingress-participant.log 2>&1',
    'fi',
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
    '# Step 3b: save the build cache for the next start.',
    '#',
    '# Before the commit report, and after the participant ran, so what gets cached is what',
    '# the participant actually installed. It is not part of the commit: a cache carries no',
    '# revision and the fence never sees it.',
    'if [ -n "$INGRESS_CACHE_PATHS" ]; then',
    '  node /tmp/ingress-reporter.cjs --cache-save >>/tmp/ingress-participant.log 2>&1',
    'fi',
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
const { spawnSync } = require('child_process');

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
const CACHE_RESTORE_MODE = arg === '--cache-restore';
const CACHE_SAVE_MODE = arg === '--cache-save';
const participantExit = SEED_MODE || RENEW_MODE || RELEASE_MODE || CACHE_RESTORE_MODE || CACHE_SAVE_MODE
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

// Where a participant declares what each of its outputs was built from.
//
// A JSON map of output path -> [{path, revision}]. Absent means "did not declare", and the
// workspace then falls back to the participant-wide dependency list — which refuses more
// than necessary, and is what makes a swarm of agents deadlock.
//
// It lives under .ingress/ rather than /tmp for two reasons. It is inside the work tree, so
// it is something a participant can actually write during a run; and .ingress/ is already
// in the reporter's ALWAYS_IGNORED list, so the declaration can never be committed as
// workspace content. A participant cannot smuggle it in as a file change.
//
// Read at commit time rather than at seed time: the revisions it refers to are what the
// participant was handed, and the file is written while it works.
const BUILT_FROM_PATH = process.env.INGRESS_BUILT_FROM_PATH
  || path.join(workDir, '.ingress', 'built-from.json');

// The participant's captured output.
//
// Bounded, and the tail kept rather than the head: a build failure lives at the end of the
// log, and a bound that kept the beginning would send back the preamble and not the cause.
const OUTPUT_PATH = process.env.INGRESS_OUTPUT_PATH || '/tmp/ingress-participant.log';
const MAX_OUTPUT_BYTES = 256 * 1024;
function readLog() {
  let text;
  try { text = fs.readFileSync(OUTPUT_PATH, 'utf8'); }
  catch { return null; }                    // missing output is common: the command never ran
  if (Buffer.byteLength(text) <= MAX_OUTPUT_BYTES) return text;
  // Say what was dropped rather than hiding that the text is a slice.
  return '...[truncated, head dropped]\n' + text.slice(-MAX_OUTPUT_BYTES);
}

// The build cache: directories whose contents make the next start cheap.
//
// Declared by the caller, not guessed. A cache is an optimisation, so the failure mode is
// "the next run installs again" and never "the workspace is wrong" -- which is why none of
// the cache code touches the fence.
const CACHE_PATHS = (process.env.INGRESS_CACHE_PATHS || '')
  .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
const CACHE_KEY = process.env.INGRESS_CACHE_KEY || 'default';

// Files this reporter never sends, however the participant asks.
//
// Inlined rather than imported, because this string runs in a container and cannot import
// anything. It MUST stay identical to ALWAYS_IGNORED in ../manifest.mjs -- and for a long
// time it did not, because that constant was never applied by anything at all.
// test/product-launcher.test.mjs now asserts the two lists agree, which is the only thing
// stopping them drifting again.
const IGNORED_NAMES = ['node_modules', '.git', '.ingress'];
const IGNORED_FILES = ['.DS_Store'];

/**
 * Read the provenance declaration, if there is one.
 *
 * A malformed declaration is **ignored**, and announced, rather than refused. The reasoning
 * is asymmetric on purpose: the workspace validates the provenance claim on arrival
 * and refuses a malformed claim there — so a bad file costs this participant its
 * refined scoping and falls back to the coarse check. It cannot cost anyone a commit
 * they would otherwise have had, because the fallback is today's behaviour exactly.
 */
function readBuiltFrom() {
  let raw;
  try {
    raw = fs.readFileSync(BUILT_FROM_PATH, 'utf8');
  } catch {
    return null;                       // no declaration is the common case, not an error
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log('INGRESS-BUILT-FROM-IGNORED the declaration is not valid JSON; falling back to declared dependencies');
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.log('INGRESS-BUILT-FROM-IGNORED the declaration is not an object keyed by output path');
    return null;
  }
  return parsed;
}

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

function ignored(rel, name) {
  if (IGNORED_NAMES.indexOf(name) !== -1) return true;
  if (IGNORED_FILES.indexOf(name) !== -1) return true;
  // Matches the '*.swp' entry in ALWAYS_IGNORED, which is a glob on any path segment.
  // The first version of this only matched *directories* ending in .swp, which is not a
  // thing — swap files are files, named like engine.mjs.swp — so the pattern matched
  // nothing. Caught by the assertion that compares this list against the canonical one.
  return rel.split('/').some(function (segment) { return segment.slice(-4) === '.swp'; });
}

function walk(dir, base, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  entries.sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = base ? base + '/' + entry.name : entry.name;
    // Never sent: dependency trees, VCS metadata, our own bookkeeping, editor droppings.
    //
    // This is the first time anything has actually applied that list. ALWAYS_IGNORED was
    // exported from manifest.mjs and documented as "files the workspace never commits,
    // whatever a participant says" — and neither the walk nor parseManifest consulted it,
    // so a participant that ran npm install or git init sent the entire tree, and the
    // workspace stored it.
    if (ignored(rel, entry.name)) continue;
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
  // What this participant says each output was built from, keyed by output path.
  const declared = readBuiltFrom();

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

    // Attach provenance only where it was declared. A file with no entry in the declaration
    // is left alone, which the workspace reads as "did not declare" and answers with the
    // participant-wide dependency check. Copying an absent claim across as an empty one
    // would silently opt every unlisted file out of the check.
    if (declared && Object.prototype.hasOwnProperty.call(declared, file.path)) {
      file.builtFrom = declared[file.path];
    }
  }

  const scoped = files.filter(function (f) { return f.builtFrom !== undefined; }).length;
  if (declared) {
    console.log('INGRESS-BUILT-FROM ' + JSON.stringify({
      declared: Object.keys(declared).length,
      attached: scoped,
    }));
  }
  files.sort(function (a, b) { return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0); });

  const body = JSON.stringify({
    manifestVersion: process.env.INGRESS_MANIFEST_VERSION,
    participantId: participantId,
    participantExit: participantExit,
    baseKnown: baseKnown,
    // The captured output, so the harness can read what its command did without a second
    // round trip through the container. Absent when the command produced no output file.
    //
    // Without this an external caller drives the sandbox blind: the start route used to
    // return only the commit verdict, and a failing build looked identical to a green one
    // unless the caller already knew where in the container to look -- which it cannot,
    // because the container is gone by then.
    log: readLog(),
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
 * Restore the declared cache, if the workspace has one.
 *
 * A miss is normal -- the first start of a workspace has no cache -- and is logged, not
 * treated as a failure. The whole point is that a cache is optional, so a restore that
 * cannot happen costs a slow start and never a failed one.
 */
async function cacheRestore() {
  if (CACHE_PATHS.length === 0) return;
  let res;
  try {
    res = await fetch('http://workspace.internal/cache?key=' + encodeURIComponent(CACHE_KEY), { headers: headers() });
  } catch (error) {
    console.log('INGRESS-CACHE-RESTORE-UNREACHABLE ' + (error && error.message));
    return;
  }
  if (res.status === 404) {
    console.log('INGRESS-CACHE-MISS ' + JSON.stringify({ key: CACHE_KEY }));
    return;
  }
  if (!res.ok) {
    console.log('INGRESS-CACHE-RESTORE-REFUSED ' + res.status + ' ' + await res.text());
    return;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const tarball = '/tmp/ingress-cache-in.tgz';
  fs.writeFileSync(tarball, buffer);
  const extracted = spawnSync('tar', ['xzf', tarball, '-C', workDir], { encoding: 'utf8' });
  console.log('INGRESS-CACHE-RESTORED ' + JSON.stringify({
    key: CACHE_KEY,
    bytes: buffer.length,
    tarStatus: extracted.status,
  }));
}

/**
 * Save the declared cache for the next start.
 *
 * Tarred from the work directory. A path that does not exist makes tar exit non-zero, and
 * that is skipped with a reason rather than retried -- there is nothing to cache, which is
 * a legitimate outcome for a project that never installed anything.
 */
async function cacheSave() {
  if (CACHE_PATHS.length === 0) return;
  const tarball = '/tmp/ingress-cache-out.tgz';
  const packed = spawnSync('tar', ['czf', tarball, '-C', workDir].concat(CACHE_PATHS), { encoding: 'utf8' });
  if (packed.status !== 0) {
    console.log('INGRESS-CACHE-SAVE-SKIPPED ' + JSON.stringify({
      status: packed.status,
      stderr: (packed.stderr || '').slice(0, 200),
    }));
    return;
  }
  let buffer;
  try { buffer = fs.readFileSync(tarball); }
  catch { console.log('INGRESS-CACHE-SAVE-SKIPPED no tarball was written'); return; }

  let res;
  try {
    res = await fetch('http://workspace.internal/cache?key=' + encodeURIComponent(CACHE_KEY), {
      method: 'POST',
      headers: Object.assign(headers(), { 'content-type': 'application/gzip' }),
      body: buffer,
    });
  } catch (error) {
    console.log('INGRESS-CACHE-SAVE-UNREACHABLE ' + (error && error.message));
    return;
  }
  console.log('INGRESS-CACHE-SAVED ' + res.status + ' ' + await res.text());
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
    else if (CACHE_RESTORE_MODE) await cacheRestore();
    else if (CACHE_SAVE_MODE) await cacheSave();
    else if (RENEW_MODE) await renew(Number(process.argv[3]) || 15000);
    else if (RELEASE_MODE) await release();
    else await commit();
  } catch (error) {
    console.log('INGRESS-REPORTER-FAILED ' + (error && error.message));
  }
})();
`;