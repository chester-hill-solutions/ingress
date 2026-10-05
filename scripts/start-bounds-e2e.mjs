/**
 * What `/start` will accept, what it costs, and what it does when a command overruns.
 *
 * The caps in `src/product/start.mjs` are pure and unit-tested, so what this adds is the
 * half a unit test cannot reach: whether the platform behaves the way `waitBounded`
 * assumes when the deadline actually fires.
 *
 * Two things have never been observed, and both are asserted from source text in the
 * comments those source texts sit next to:
 *
 *   1. `container.stop()` exists on the runtime. `waitBounded` guards the call with
 *      `typeof stop === 'function'`, so if the method does not exist the deadline still
 *      returns and the slot still frees — and nothing tells anyone the container is still
 *      running. The guard makes the failure quiet, which is exactly why it needed checking
 *      rather than assuming.
 *   2. The ceiling actually stops an overrunning command rather than merely returning
 *      while it continues to burn money.
 *
 * Both are answered here by `runMs: 1000` against `sleep 30`: a deadline that fires in a
 * second instead of a quarter of an hour, at the cost of one container like any other
 * start. Before item 7 that was awkward to arrange, because a 30-second command needed a
 * lease longer than the default to survive its own boot.
 *
 * The refusals are free — no container boots — so they are probed here too rather than
 * being left to `curl`, and the script exits non-zero if any expectation fails.
 */

import { client, freshWorkspace, check as ok, step, finish } from './e2e-client.mjs';

const WORKSPACE = process.env.INGRESS_WORKSPACE ?? freshWorkspace('bounds');

const { post, get } = client(WORKSPACE);

const results = [];
const expect = (label, value) => results.push(ok(label, value));

console.log(`workspace: ${WORKSPACE}`);

// --- the refusals. Nothing is created, so these cost nothing ----------------

step('1. a start that is too long is refused, and nothing is created');
{
  const response = await post('/start', {
    participantId: 'refused-command',
    // 4097 bytes: one over `MAX_COMMAND_BYTES`. Not a metacharacter and not a shell
    // construct, so the refusal can only be about length.
    participantCommand: 'x'.repeat(4097),
  });
  console.log(`  status ${response.status} | reason: ${response.body.reason}`);
  console.log(`  limit ${response.body.limitBytes} | sent ${response.body.bytes}`);
  expect('an over-long command is refused by name', response.status === 409 && response.body.reason === 'participant_command_too_long');
  expect('the refusal says what the limit was', response.body.limitBytes === 4096);
}

step('2. a malformed workDir is refused');
{
  // This is the value that used to be interpolated into the launcher as `WORK='...'`,
  // where `'; echo INJECTED; #` ran as root before the participant read its command.
  const response = await post('/start', {
    participantId: 'refused-workdir',
    participantCommand: 'true',
    workDir: "'; echo INJECTED; #",
  });
  console.log(`  status ${response.status} | reason: ${response.body.reason}`);
  console.log(`  detail: ${response.body.detail}`);
  expect('a shell metacharacter in workDir is refused', response.status === 409 && response.body.reason === 'invalid_work_dir');
}

step('3. a dot-only segment is refused, though every character is permitted');
{
  // `[A-Za-z0-9._-]` looks safe and admits `/workspace/..`, because `.` is made of
  // permitted characters. The charset is not the guard; the segment rule is.
  for (const workDir of ['/workspace/..', '/workspace/.', '/w/../x']) {
    const response = await post('/start', { participantId: 'refused-traversal', participantCommand: 'true', workDir });
    expect(`workDir ${JSON.stringify(workDir)} is refused`, response.status === 409 && response.body.reason === 'invalid_work_dir');
  }
}

step('4. a runMs outside its bounds is refused');
{
  for (const [runMs, label] of [[999, 'below the floor'], [900_001, 'above the ceiling'], ['60000', 'a string where a number belongs']]) {
    const response = await post('/start', { participantId: 'refused-run', participantCommand: 'true', runMs });
    console.log(`  runMs ${JSON.stringify(runMs)} (${label}) -> ${response.status} ${response.body.reason}`);
    expect(`runMs ${JSON.stringify(runMs)} is refused`, response.status === 409);
  }
}

step('5. nothing above created a participant, a container or a lease');
{
  const state = await get('/state');
  const leases = await get('/leases');
  console.log(`  participants: ${state.body.participants.length}`);
  console.log(`  live leases: ${leases.body.leases.length}`);
  expect('a refused start registers nothing', state.body.participants.length === 0);
  expect('a refused start grants no lease', leases.body.leases.length === 0);
}

// --- the deadline. One container, and the only part that costs anything -------

// Whether this deployment can stop a container at all. Set by step 6 and read by the
// steps after it, because the two cases need different things: a workspace whose container
// cannot be stopped is still running that container, and the next `/start` in it fails
// with a platform 500 rather than anything of ours.
step('6. a command that overruns is killed by the container, not merely abandoned');
{
  const started = Date.now();
  const response = await post('/start', {
    participantId: 'overrunner',
    kind: 'agent',
    // No `writePaths`: this participant commits nothing, so it needs no lease, and a
    // missing one keeps the case to exactly one mechanism.
    runMs: 1000,
    participantCommand: 'sleep 30',
  });
  const elapsed = Date.now() - started;

  console.log(`  runMs 1000 | wall clock ${Math.round(elapsed / 1000)}s`);
  console.log(`  status ${response.status} | timedOut: ${response.body.timedOut} | commandTimeout: ${response.body.commandTimeout}`);
  console.log(`  participantExit: ${JSON.stringify(response.body.participantExit)}`);
  console.log(`  commit: ${JSON.stringify(response.body.commit)}`);

  expect('the request answered 200 rather than throwing', response.status === 200);
  // The container kills its own command with `timeout`, so it *exits* — and the wait ends
  // because the container finished, not because a deadline fired. `timedOut` is therefore
  // **false**, and that is the change that matters: before the launcher was bounded the
  // container outlived the workspace's deadline, and this reported `timedOut: true` with a
  // container still running and still billing.
  expect('the workspace did not have to time out — the container exited on its own',
    response.body.timedOut === false);
  expect('and the response says the work was cut short', response.body.commandTimeout === true);
  expect(`with timeout(1)'s exit status, 124 (got ${response.body.participantExit})`,
    response.body.participantExit === 124);
  // Returning in about a second is the point: `sleep 30` had thirty seconds to run.
  expect(
    `the request returned at the command's own bound, not its own (${Math.round(elapsed / 1000)}s)`,
    elapsed < 20_000,
  );
  // The launcher still ran its reporting step, so there is a verdict — an empty commit,
  // carrying the exit status. Before the fix there was no manifest at all on this path.
  expect('and the launcher still reported, with the exit status',
    response.body.commit?.participantExit === 124);

  // Nothing was stopped by the workspace, and that is still true — `container.stop` does
  // not exist here. It no longer matters, because the container stopped itself. Recorded
  // so the distinction survives: `stopAvailable` is absent on this path because there was
  // no timeout to report, not because the runtime grew a `stop` method.
  expect('and nothing claims the workspace stopped it',
    response.body.stopAvailable === undefined,
    'stopAvailable belongs to the timeout path');
}

step('7. the workspace is free immediately, because the container died with its command');
{
  // This step used to assert the opposite, and the assertion was right at the time: the
  // container could not be stopped, so a following `/start` failed with a platform 500
  // until the original command finished on its own 29 seconds later. That was the
  // unbounded-cost hole — `MAX_RUN_MS` bounded how long the caller *waited*, and nothing
  // bounded how long the *work* ran.
  //
  // With the launcher bounded the container is gone, so the workspace is usable again at
  // once. That is now asserted as the property it is, rather than as the platform's error
  // string — which also means this check would catch a regression that reintroduced the
  // hole, rather than merely recording it.
  const followUp = await post('/start', {
    participantId: 'after-timeout',
    kind: 'agent',
    runMs: 30_000,
    participantCommand: 'true',
  });
  console.log(`  a start immediately after -> ${followUp.status} ${JSON.stringify(followUp.body?.reason ?? 'started')}`);

  expect('a start immediately after an overrun succeeds', followUp.status === 200,
    'the overrunning container is gone, not still billing');
  expect('and it runs normally', followUp.body?.timedOut === false);

  // The status is asserted directly and never inferred from `body.reason`. The first
  // version read `slotsFree.body.reason ?? 'started'`, so a **500** printed `started` and
  // passed — it was reading its own fallback. Three checks in a row passed that way while
  // the workspace was refusing every single start.
}

// Its own workspace. Step 6's participant writes nothing but still boots a container, and a
// workspace runs one container at a time — so a start here would contend with it for a
// reason that has nothing to do with what step 8 is testing.
//
// Separated rather than worked around, because the alternative — adding sleeps — is a test
// that passes for a timing reason. That confusion is what the first run of this script
// produced: three "PASS" lines and a `too_many_concurrent_starts` refusal reported as a
// lease problem.
const leaseWs = `${WORKSPACE}-lease`;

step('8. a write lease is refused when it cannot be granted, having created nothing');
{
  const { post: leasePost, get: leaseGet } = client(leaseWs);

  await leaseGet('/join?name=holder');
  const held = await leasePost('/lease/checkout', { participantId: 'holder', paths: ['contested.mjs'], mode: 'write' });
  expect('the first participant holds contested.mjs', held.status === 200);

  const started = await leasePost('/start', {
    participantId: 'blocked',
    kind: 'agent',
    writePaths: ['contested.mjs'],
    runMs: 1000,
    participantCommand: 'true',
  });
  console.log(`  status ${started.status} | reason: ${started.body.reason}`);
  console.log(`  blockedOn: ${JSON.stringify(started.body.blockedOn)}`);
  console.log(`  detail: ${started.body.detail}`);
  expect('a start whose lease is held by someone else is refused', started.status === 409 && started.body.reason === 'lease_conflict');
  expect('the refusal names who is in the way', (started.body.blockedOn ?? []).includes('holder'));

  // The refused participant must not exist: it never got a token or a container.
  const state = await leaseGet('/state');
  const names = state.body.participants.map(p => p.participantId);
  console.log(`  participants now: ${names.join(', ')}`);
  expect('the refused start created no participant', !names.includes('blocked'));

  // And nothing partial leaked onto the holder's side.
  const leases = await leaseGet('/leases');
  const onContested = leases.body.leases.filter(l => (l.paths ?? []).includes('contested.mjs'));
  console.log(`  leases on contested.mjs: ${onContested.map(l => l.participantId).join(', ')}`);
  expect('only the original holder holds the file', onContested.length === 1 && onContested[0].participantId === 'holder');
}

// A third workspace, for the same reason as step 8: the one step 6 used still has that
// container in it, and the point of this step is that an ordinary start works
// *here*, not that the product recovered from something it cannot recover from.
const healthyWs = `${WORKSPACE}-healthy`;
step('9. a normal start still works, after all of the above');
{
  const { post: healthyPost, get: healthyGet } = client(healthyWs);

  const response = await healthyPost('/start', {
    participantId: 'healthy',
    kind: 'agent',
    writePaths: ['healthy.mjs'],
    runMs: 30_000,
    participantCommand: "cat > /workspace/healthy.mjs <<'XEOF'\nexport const healthy = true;\nXEOF",
  });
  const verdict = response.body.commit;
  console.log(`  status ${response.status} | timedOut: ${response.body.timedOut}`);
  console.log(`  admitted: ${verdict?.admitted} | reason: ${verdict?.reason} | landed: ${JSON.stringify(verdict?.landed)}`);
  expect('an ordinary commit is still admitted', verdict?.admitted === true);
  expect('and a clean run reports nothing about stopping', response.body.stopAvailable === undefined,
    'stopAvailable belongs to the timeout path; on a normal exit it would read as "not stopped"');

  const content = await healthyGet('/content?path=healthy.mjs');
  expect('and the bytes are stored', content.status === 200);
  expect('and they are what the command wrote',
    content.status === 200 && Buffer.from(content.body.contentBase64, 'base64').toString('utf8').includes('healthy = true'));

  const leases = await healthyGet('/leases');
  const stillHeld = leases.body.leases.filter(l => (l.paths ?? []).includes('healthy.mjs'));
  expect('and its lease was given back on the way out', stillHeld.length === 0);
}

finish(
  results,
  okVerdict => okVerdict
    ? 'EVERY /start BOUND HELD, AND AN OVERRUNNING COMMAND WAS KILLED BY ITS OWN CONTAINER'
    : 'SOME /start BOUNDS DID NOT HOLD',
);