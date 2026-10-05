/**
 * The in-container reporter, executed for real.
 *
 * `CONTAINER_REPORTER` is the string that runs inside a participant's container and
 * crosses the network boundary to the gate. It had no test at all: every gate guarantee
 * was asserted by reading its source, and every bug in that class so far — the pooled
 * Buffer hash, the dropped `baseRevision`, the string `manifestVersion` — shipped
 * because the unit tests built the same objects in-process where those faults do not
 * appear.
 *
 * So this runs the actual string, unmodified, under Node, with `fetch` replaced by a
 * stub that records what was sent. It needs no account and no container. It cannot prove
 * the platform behaves as the reporter assumes; that still needs a real container, which
 * is what the e2e scripts are for. What it does prove is everything on this side of the
 * hop: the request shape, the headers, the manifest version, and the base revisions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { CONTAINER_REPORTER, launcherScript } from '../src/product/launcher.mjs';
import { TIMEOUT_EXIT_STATUS } from '../src/product/start.mjs';

const SECRET = 'reporter-test-token';

/**
 * Run the reporter string in a child process with a stubbed `fetch`.
 *
 * A child process rather than an import because the reporter reads `process.argv` and
 * `process.env` at module scope and runs its work immediately. Isolation also means a
 * stubbed global cannot leak into the rest of the suite.
 *
 * The response body is passed as a *string*, not a function. An earlier draft stringified
 * a stub function and ran it in the child, where it had no access to anything the parent
 * scope held — so the stub threw and every test failed on `ok is not defined` rather than
 * on anything to do with the reporter.
 */
function runReporter({
  workDir,
  revisionsPath,
  responseBody = '{}',
  exitCode = 0,
  mode = 'commit',
  leaseId = '',
  leaseMs = 0,
}) {
  const dir = mkdtempSync(join(tmpdir(), 'ingress-reporter-'));
  const script = join(dir, 'reporter.cjs');
  const harness = `
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body });
  return { ok: true, status: 200, text: async () => ${JSON.stringify(responseBody)} };
};
process.on('exit', () => { process.stdout.write('\\n__CALLS__' + JSON.stringify(calls)); });
${CONTAINER_REPORTER}
`;

  writeFileSync(script, harness);
  const argv = mode === 'commit'
    ? [String(exitCode)]
    : mode === 'seed' ? ['--seed']
    : mode === 'renew' ? ['--renew', String(leaseMs)]
    : ['--release'];

  const result = spawnSync(process.execPath, [script, ...argv], {
    encoding: 'utf8',
    env: {
      ...process.env,
      INGRESS_WORKSPACE: 'demo',
      INGRESS_PARTICIPANT: 'builder',
      INGRESS_TOKEN: SECRET,
      INGRESS_WORK_DIR: workDir,
      INGRESS_MANIFEST_VERSION: '1',
      INGRESS_REVISIONS_PATH: revisionsPath,
      // Empty rather than absent, matching what the launcher passes when no lease was
      // issued. The reporter treats both the same way, and asserting that here is what
      // keeps the two from drifting.
      INGRESS_LEASE_ID: leaseId,
      ...(leaseMs ? { INGRESS_LEASE_MS: String(leaseMs) } : {}),
    },
  });

  const stdout = result.stdout ?? '';
  const marker = stdout.indexOf('__CALLS__');
  assert.notEqual(marker, -1, `the reporter did not report its calls.\nstdout: ${stdout}\nstderr: ${result.stderr}`);
  return {
    calls: JSON.parse(stdout.slice(marker + '__CALLS__'.length)),
    log: stdout.slice(0, marker),
    status: result.status,
    stderr: result.stderr ?? '',
  };
}

/**
 * Run the renewer and kill it after `afterMs`.
 *
 * `spawnSync` cannot be used: the renewer loops until it is killed, so the test has to
 * interrupt it rather than wait for it. The calls are read back through a file rather than
 * stdout, because killing the process gives no chance to flush a pipe.
 */
async function runRenewer({
  workDir,
  leaseId = 'L1',
  leaseMs = 60_000,
  intervalMs = 50,
  responseStatus = 200,
  responseBody = JSON.stringify({ alive: true, expiresAt: Date.now() + 60_000 }),
  networkError = false,
  afterMs = 400,
  afterAnnouncing = null,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ingress-renewer-'));
  const script = join(dir, 'renewer.cjs');
  const callsPath = join(dir, 'calls.json');

  // The recorder is attached to `globalThis`, and nothing is declared with `const` here.
  //
  // An earlier version of this harness opened with `const fs = require('fs')` and the
  // reporter opens with exactly that line, so the child died on a redeclaration before it
  // made a single call — and every renewer test failed on a call count of zero, which
  // reads like the renewer never ran rather than like the harness being broken.
  writeFileSync(script, `
const calls = [];
globalThis.__flush = function () {
  require('fs').writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls));
};
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body });
  globalThis.__flush();
  ${networkError ? "throw new Error('connect ECONNREFUSED');" : `
  return {
    ok: ${responseStatus} < 400,
    status: ${responseStatus},
    text: async () => ${JSON.stringify(responseBody)},
    json: async () => ${JSON.stringify(responseBody)},
  };`}
};
process.on('exit', globalThis.__flush);
setInterval(globalThis.__flush, 50).unref?.();
${CONTAINER_REPORTER}
`);

  const child = spawn(process.execPath, [script, '--renew', String(intervalMs)], {
    env: {
      ...process.env,
      INGRESS_WORKSPACE: 'demo',
      INGRESS_PARTICIPANT: 'builder',
      INGRESS_TOKEN: SECRET,
      INGRESS_WORK_DIR: workDir,
      INGRESS_MANIFEST_VERSION: '1',
      INGRESS_REVISIONS_PATH: join(dir, 'revisions.json'),
      INGRESS_LEASE_ID: leaseId,
      INGRESS_LEASE_MS: String(leaseMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });

  // Closed before the kill is awaited. Without this the runner hangs after the last test:
  // a SIGKILLed child's pipes are closed asynchronously, and until they are the handles
  // keep the event loop alive. Every assertion passes and then the process sits there.
  const closed = new Promise(resolve => child.once('close', resolve));

  // The window is awaited asynchronously rather than slept through synchronously. A
  // synchronous wait would freeze this process's event loop, the stdout handlers above
  // would never fire, and the log would come back empty for reasons that have nothing to
  // do with the renewer — which is precisely the failure this harness had first.
  //
  // `afterAnnouncing` measures from the reporter's own first line of output rather than
  // from the spawn. Node startup under the full suite's parallel load is long enough that
  // a window started at the spawn expires before the reporter has even parsed its
  // arguments, and the assertion then reads "no requests were made" when the truth is
  // "the reporter had not started". Every renewer test that cares about *intervals*
  // rather than about totals uses this form; `afterMs` remains for the ones that only need
  // the process to have run.
  const collect = () => (existsSync(callsPath) ? JSON.parse(readFileSync(callsPath, 'utf8')) : []);

  let calls;
  if (afterAnnouncing !== null) {
    const started = await waitFor(() => /INGRESS-LEASE-(?:RENEWING|NO-ID)/.test(log), 5_000);
    assert.ok(started, 'the reporter never announced itself, so the test proved nothing');
    await new Promise(resolve => setTimeout(resolve, afterAnnouncing));
    calls = collect();
  } else {
    await new Promise(resolve => setTimeout(resolve, afterMs));
    calls = collect();
  }

  child.kill('SIGKILL');
  await closed;

  return { calls, log };
}

/** Poll a predicate on the child's collected output until it holds or the budget runs out. */
async function waitFor(predicate, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return predicate();
}

test('the seed fetch carries the three gate headers and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ingress-seed-'));
  const result = runReporter({
    workDir: dir,
    revisionsPath: join(dir, 'revisions.json'),
    mode: 'seed',
    responseBody: JSON.stringify({ files: [], leasedPaths: [], fingerprint: 'f' }),
  });

  assert.equal(result.calls.length, 1, 'a seed must make exactly one request');
  const [call] = result.calls;
  assert.equal(call.url, 'http://workspace.internal/seed');
  assert.equal(call.method, 'GET');
  assert.equal(call.headers['x-ingress-workspace'], 'demo');
  assert.equal(call.headers['x-ingress-participant'], 'builder');
  assert.equal(call.headers['x-ingress-token'], SECRET);
  // The workspace credential must not be sent from inside a container: that traffic is
  // intercepted to the gate, which does not check it, and sending it would widen the
  // secret's reach for nothing.
  assert.equal(call.headers['x-ingress-workspace-token'], undefined,
    'the container must not carry the workspace credential');
});

test('the seed writes the content it was given, and records the revision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ingress-seed-write-'));
  const revisions = join(dir, 'revisions.json');
  const content = Buffer.from('export const version = 1;\n', 'utf8').toString('base64');

  const result = runReporter({
    workDir: dir,
    revisionsPath: revisions,
    mode: 'seed',
    responseBody: JSON.stringify({
      files: [{ path: 'engine.mjs', exists: true, revision: 3, contentBase64: content, contentHash: 'h' }],
      leasedPaths: ['engine.mjs'],
      fingerprint: 'f',
    }),
  });

  assert.match(result.log, /INGRESS-SEED/, `seed did not report: ${result.log}${result.stderr}`);
  assert.equal(readFileSync(join(dir, 'engine.mjs'), 'utf8'), 'export const version = 1;\n');
  assert.deepEqual(JSON.parse(readFileSync(revisions, 'utf8')), { 'engine.mjs': 3 },
    'the revision each file was handed must be recorded, or the base-revision check is dead code');
});

test('an absent path stays absent rather than becoming an empty file', () => {
  // Materialising an empty file for a path the workspace has never seen would destroy a
  // file the participant never saw either.
  const dir = mkdtempSync(join(tmpdir(), 'ingress-seed-absent-'));
  const revisions = join(dir, 'revisions.json');

  runReporter({
    workDir: dir,
    revisionsPath: revisions,
    mode: 'seed',
    responseBody: JSON.stringify({
      files: [{ path: 'never-written.mjs', exists: false, revision: null, contentBase64: null }],
      leasedPaths: [],
      fingerprint: 'f',
    }),
  });

  assert.equal(existsSync(join(dir, 'never-written.mjs')), false,
    'an absent path must not be created as an empty file');
  assert.deepEqual(JSON.parse(readFileSync(revisions, 'utf8')), {});
});

test('the commit sends a manifest the gate can parse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ingress-commit-'));
  const revisions = join(dir, 'revisions.json');
  mkdirSync(join(dir, 'nested'), { recursive: true });
  writeFileSync(join(dir, 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'nested', 'b.mjs'), 'export const b = 2;\n');
  writeFileSync(revisions, JSON.stringify({ 'a.mjs': 7 }));

  const result = runReporter({ workDir: dir, revisionsPath: revisions });

  assert.equal(result.calls.length, 1);
  const [call] = result.calls;
  assert.equal(call.url, 'http://workspace.internal/commit');
  assert.equal(call.method, 'POST');

  const manifest = JSON.parse(call.body);
  assert.equal(manifest.manifestVersion, '1',
    'the version crosses a process boundary as a string and must be sent as one');
  assert.equal(manifest.participantId, 'builder');
  assert.equal(manifest.participantExit, 0);
  assert.equal(manifest.baseKnown, true);

  assert.deepEqual(manifest.files.map(f => f.path), ['a.mjs', 'nested/b.mjs'],
    'paths must be sorted and relative');
  assert.equal(manifest.files[0].baseRevision, 7,
    'a seeded file must declare the revision it was handed, or the base check never fires');
  assert.equal(manifest.files[1].baseRevision, undefined,
    'a file that was never seeded has no base to claim');

  for (const file of manifest.files) {
    const onDisk = readFileSync(join(dir, file.path));
    assert.equal(file.contentHash, createHash('sha256').update(onDisk).digest('hex'),
      `${file.path} hash must match the bytes on disk`);
    assert.equal(Buffer.from(file.contentBase64, 'base64').toString('utf8'), onDisk.toString('utf8'));
  }
});

test('a missing revisions file is announced, not swallowed', () => {
  // The difference between the fence judging a change against what the participant
  // started from and judging it against nothing.
  const dir = mkdtempSync(join(tmpdir(), 'ingress-nobase-'));
  writeFileSync(join(dir, 'a.mjs'), 'export const a = 1;\n');

  const result = runReporter({
    workDir: dir,
    revisionsPath: join(dir, 'does-not-exist.json'),
  });

  assert.match(result.log, /INGRESS-BASE-UNKNOWN/,
    `a lost base must be announced loudly: ${result.log}${result.stderr}`);
  const manifest = JSON.parse(result.calls[0].body);
  assert.equal(manifest.baseKnown, false);
  assert.equal(manifest.files[0].baseRevision, undefined);
});

test('a symbolic link out of the tree is never followed', () => {
  // The reporter walks a directory the participant controls. Following a link would let
  // it read and transmit anything on the container filesystem.
  const dir = mkdtempSync(join(tmpdir(), 'ingress-symlink-'));
  const outside = `${dir}-outside.txt`;
  writeFileSync(outside, 'secret');
  symlinkSync(outside, join(dir, 'escape.txt'));
  writeFileSync(join(dir, 'real.mjs'), 'export const r = 1;\n');

  const result = runReporter({
    workDir: dir,
    revisionsPath: join(dir, 'revisions.json'),
  });

  const manifest = JSON.parse(result.calls[0].body);
  assert.deepEqual(manifest.files.map(f => f.path), ['real.mjs'],
    'a symlink must not appear in the manifest');
  rmSync(outside, { force: true });
});

test('an oversized file is reported as skipped rather than silently dropped', () => {
  // Silently dropping would be indistinguishable from the participant hiding a change.
  const dir = mkdtempSync(join(tmpdir(), 'ingress-toobig-'));
  writeFileSync(join(dir, 'small.mjs'), 'ok');
  writeFileSync(join(dir, 'big.bin'), Buffer.alloc(300 * 1024, 1));

  const result = runReporter({
    workDir: dir,
    revisionsPath: join(dir, 'revisions.json'),
  });

  const manifest = JSON.parse(result.calls[0].body);
  const paths = manifest.files.map(f => f.path);
  assert.ok(paths.includes('small.mjs'));
  // It is sent with `skipped`, which `parseManifest` drops — so the workspace learns it
  // existed and declined it, rather than never hearing about it.
  assert.ok(paths.includes('big.bin'), 'an oversized file must be reported, not omitted');
  assert.equal(manifest.files.find(f => f.path === 'big.bin').skipped, 'too_large');
});

test("the reporter's own bookkeeping is never part of the workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), 'ingress-self-'));
  const revisions = join(dir, 'revisions.json');
  writeFileSync(join(dir, 'a.mjs'), 'ok');
  writeFileSync(revisions, JSON.stringify({ 'a.mjs': 1 }));

  const result = runReporter({ workDir: dir, revisionsPath: revisions });

  const paths = JSON.parse(result.calls[0].body).files.map(f => f.path);
  assert.deepEqual(paths, ['a.mjs'],
    'the revisions file is not workspace content, even when it lives inside the work tree');
});

test('the participant exit code is reported, not swallowed', () => {
  // A container that crashed after doing real work is visible only if this is reported.
  const dir = mkdtempSync(join(tmpdir(), 'ingress-exit-'));
  const result = runReporter({
    workDir: dir,
    revisionsPath: join(dir, 'revisions.json'),
    exitCode: 42,
  });

  assert.equal(JSON.parse(result.calls[0].body).participantExit, 42,
    'a non-zero exit must reach the gate, or a crashed participant looks like a silent one');
});

test('the renewer asks for the lease it was granted, not the default', async () => {
  // `heartbeat` sets `expiresAt = now + leaseMs`. A renewer that sent the default instead
  // of the granted duration would shorten the lease on its first renewal and lose it
  // part-way through a run that is working perfectly well.
  const dir = mkdtempSync(join(tmpdir(), 'ingress-renew-'));
  const result = await runRenewer({
    workDir: dir,
    leaseId: 'L1',
    leaseMs: 900_000,
    intervalMs: 60,
    afterAnnouncing: 300,
  });

  // The count is not asserted to be 1: the renewer is a loop and this test kills it after
  // a wall-clock window, so how many times it got round is a matter of scheduling. What
  // matters is that *every* request asks for the granted duration — one right answer
  // followed by five wrong ones would still pass a check on the first call.
  assert.ok(result.calls.length >= 1, 'the renewer made no request at all');
  for (const call of result.calls) {
    assert.equal(call.url, 'http://workspace.internal/lease/heartbeat');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['x-ingress-participant'], 'builder');
    assert.equal(call.headers['x-ingress-token'], SECRET);
    assert.equal(JSON.parse(call.body).leaseId, 'L1');
    assert.equal(JSON.parse(call.body).leaseMs, 900_000,
      'every renewal must re-apply the duration the workspace granted');
  }
});

test('the renewer sleeps before its first renewal', async () => {
  // The lease was issued moments ago, so an immediate renewal buys nothing — and on a
  // fast participant it is one more request that can fail before any work is done.
  //
  // The clock starts when the reporter *announces* itself, not when the test spawned the
  // process. Node startup is tens of milliseconds normally and several hundred under the
  // parallel load of the full suite, so a wall-clock window measured from the spawn
  // asserted on the scheduler rather than on the renewer: this test passed alone and
  // failed in `npm test`, which is the definition of a guard that does not guard.
  const result = await runRenewer({
    workDir: mkdtempSync(join(tmpdir(), 'ingress-renew-sleep-')),
    leaseId: 'L1',
    intervalMs: 1_000,
    afterAnnouncing: 250,
  });
  assert.match(result.log, /INGRESS-LEASE-RENEWING/,
    'the reporter never started, so this test proved nothing');
  assert.equal(result.calls.length, 0,
    'a full interval passed and no renewal was sent');
});

test('a refused renewal stops the loop instead of retrying forever', async () => {
  // The workspace distinguishes "your lease lapsed" from "that is not your lease". In
  // every case the claim this container is making is false. Carrying on would let the
  // participant work for the rest of the run believing it holds files it does not, and
  // have the commit refused at the end having spent the whole time misled.
  const result = await runRenewer({
    workDir: mkdtempSync(join(tmpdir(), 'ingress-renew-lost-')),
    leaseId: 'L1',
    intervalMs: 40,
    responseStatus: 409,
    responseBody: JSON.stringify({ alive: false, reason: 'lease_expired' }),
    // Five intervals' worth of opportunity to retry. A loop that ignored the refusal
    // would make many calls; one that honours it makes exactly one.
    afterAnnouncing: 300,
  });

  assert.equal(result.calls.length, 1, 'a refusal must end the loop, not be retried');
  assert.match(result.log, /INGRESS-LEASE-LOST 409/);
  assert.match(result.log, /lease_expired/, 'the reason must reach the participant, not just the status');
});

test('an unreachable gate is not a refusal', async () => {
  // A transport failure may be the container being stopped mid-flight, in which case
  // nothing is reading. Ending the renewal on one would turn a momentary blip into a
  // lost lease.
  const result = await runRenewer({
    workDir: mkdtempSync(join(tmpdir(), 'ingress-renew-unreachable-')),
    leaseId: 'L1',
    intervalMs: 60,
    networkError: true,
    afterAnnouncing: 400,
  });

  assert.ok(result.calls.length >= 2,
    `a transport failure must be retried; the renewer made ${result.calls.length} call(s)`);
  assert.match(result.log, /INGRESS-LEASE-UNREACHABLE/);
  assert.doesNotMatch(result.log, /INGRESS-LEASE-LOST/, 'an unreachable gate is not a lost lease');
});

test('the release gives up the lease by id, with no paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ingress-release-'));
  const result = runReporter({
    workDir: dir,
    revisionsPath: join(dir, 'r.json'),
    mode: 'release',
    leaseId: 'L1',
  });

  assert.equal(result.calls.length, 1);
  const [call] = result.calls;
  assert.equal(call.url, 'http://workspace.internal/lease/release');
  assert.equal(call.method, 'POST');
  const body = JSON.parse(call.body);
  assert.equal(body.leaseId, 'L1');
  assert.equal(body.paths, undefined, 'the whole lease is released, not a named subset');
  assert.equal(body.participantId, 'builder');
});

test('a container with no lease does not ask to renew or release', async () => {
  // The workspace may start a container without issuing a lease, and the reporter is
  // written once for both cases. A renewer with no lease id would post `leaseId: ''`
  // forever and get `lease_unknown` each time.
  const dir = mkdtempSync(join(tmpdir(), 'ingress-nolease-'));
  const result = await runRenewer({
    workDir: dir,
    leaseId: '',
    intervalMs: 60,
    afterAnnouncing: 250,
  });
  assert.match(result.log, /INGRESS-LEASE-NO-ID/);
  assert.equal(result.calls.length, 0);

  const released = await runReporter({ workDir: dir, revisionsPath: join(dir, 'r.json'), mode: 'release' });
  assert.equal(released.calls.length, 0, 'there is nothing to release');
});

test('the launcher starts the renewer before the participant, and releases after the commit', () => {
  // Both orderings are load-bearing. A renewer started after the command has finished is
  // too late to keep the lease alive, and a lease released before the commit guarantees
  // the commit is refused with `lease_required`.
  //
  // Positioned by *lastIndexOf* for the two flags that also appear in the step comments.
  // Searching from the start finds the prose — "Step 2: ... `--renew`" — and then the
  // assertion passes for a script that never runs a renewer at all, because a comment sits
  // in roughly the right place. That is the shape of a guard that cannot fail.
  //
  // Lines are matched on their *trimmed* form: the participant command moved inside an `if`
  // when it became bounded by `timeout`, and a helper that demanded column zero would have
  // reported "no line starts with" rather than the ordering it was checking.
  const script = launcherScript({ participantCommand: 'true' });
  const lines = script.split('\n');
  const commandLine = needle => {
    const index = lines.findIndex(line => line.trim().startsWith(needle));
    assert.notEqual(index, -1, `no line starts with ${JSON.stringify(needle)}`);
    return index;
  };

  const seed = commandLine('node /tmp/ingress-reporter.cjs --seed');
  const renew = commandLine('node /tmp/ingress-reporter.cjs --renew');
  const participant = commandLine('timeout -k');
  const commit = commandLine('node /tmp/ingress-reporter.cjs "$PARTICIPANT_EXIT"');
  const release = commandLine('node /tmp/ingress-reporter.cjs --release');

  assert.ok(seed < renew, 'the seed runs before the renewer starts');
  assert.ok(renew < participant, 'the renewer must be running while the participant works');
  assert.ok(participant < commit, 'the commit happens after the participant exits');
  assert.ok(commit < release, 'the lease is released only after the commit is made');
});

test('the launcher renews only when a lease was issued', () => {
  const script = launcherScript({ participantCommand: 'true' });
  assert.match(script, /if \[ -n "\$INGRESS_LEASE_ID" \]; then/);
  // The renewer and the release are both inside that guard, so a container with no lease
  // never starts a background process at all.
  assert.equal((script.match(/if \[ -n "\$INGRESS_LEASE_ID" \]; then/g) ?? []).length, 2);
});

test('the participant command is bounded by timeout, with a kill escalation', () => {
  // This is the only thing in the product that actually stops work. `container.stop` does
  // not exist on this runtime, so without it a command that never exits keeps its container
  // — and its cost — alive indefinitely, while the workspace merely stops waiting.
  const script = launcherScript({ participantCommand: 'true' });
  assert.match(script, /timeout -k "\$INGRESS_KILL_GRACE_SECONDS" "\$INGRESS_RUN_SECONDS"/,
    'the participant must be run under timeout, escalating to SIGKILL');
  assert.match(script, /command -v timeout >\/dev\/null 2>&1/,
    'and its absence must be detected rather than assumed away');
});

test('the bound is applied around the participant command, not around the launcher', () => {
  // Wrapping the whole script would bound the seed and the commit too, so an overrunning
  // participant could be cut off between finishing its work and reporting it — which loses
  // the work silently.
  const script = launcherScript({ participantCommand: 'true' });
  const bounded = script.search(/timeout -k .*sh -c "\$PARTICIPANT_COMMAND"/);
  const commit = script.search(/ingress-reporter\.cjs "\$PARTICIPANT_EXIT"/);

  assert.notEqual(bounded, -1, 'the participant command must be the bounded thing');
  assert.ok(bounded < commit, 'and the commit must be outside the bound');
  assert.match(script, /INGRESS-NO-TIMEOUT/,
    'an image without timeout(1) must say the run is unbounded rather than pretend');
});

test('a killed command is distinguishable from one that finished', () => {
  // `timeout` exits 124. That is the only signal the workspace gets that the work was cut
  // short, because a container killed by its own launcher exits well before the workspace's
  // deadline — so `timedOut` is false and `commandTimeout` has to be true.
  assert.equal(TIMEOUT_EXIT_STATUS, 124);
});

test('the launcher script carries no caller text and reads its workDir from the environment', () => {
  const script = launcherScript({ participantCommand: 'true' });
  assert.match(script, /if \[ -n "\$INGRESS_LEASE_ID" \]; then/);
  // The renewer and the release are both inside that guard, so a container with no lease
  // never starts a background process at all.
  assert.equal((script.match(/if \[ -n "\$INGRESS_LEASE_ID" \]; then/g) ?? []).length, 2);
});

test('the launcher script carries no caller text and reads its workDir from the environment', () => {
  // The workDir injection this replaced: a value interpolated as WORK='${workDir}'.
  const script = launcherScript({ participantCommand: `'; echo INJECTED; #` });
  assert.doesNotMatch(script, /INJECTED/);
  assert.match(script, /WORK="\$\{INGRESS_WORK_DIR/);
  assert.doesNotMatch(script, /^WORK='/m);
  assert.match(script, /PARTICIPANT_COMMAND="\$INGRESS_PARTICIPANT_COMMAND"/);
});

test('the reporter string is itself valid JavaScript', () => {
  // `CONTAINER_REPORTER` is a template literal, so a backtick anywhere inside it —
  // including in a comment — terminates the literal and the module fails to parse with
  // an error pointing at unrelated code. That happened while writing this file, so the
  // invariant is asserted rather than remembered.
  assert.doesNotThrow(() => new Function(CONTAINER_REPORTER), 'the reporter must parse');
});

test('the reporter file is written to /tmp, not the read-only container root', () => {
  // A reporter written to `/` fails *after* the participant has run, and the failure is
  // invisible from outside because the work is simply never reported.
  const script = launcherScript({ participantCommand: 'true' });
  assert.match(script, /\/tmp\/ingress-reporter\.cjs/);
  assert.doesNotMatch(script, /cat > \/ingress-reporter/);
});

