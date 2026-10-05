/**
 * What `/start` will accept, and what it costs.
 *
 * `/start` boots a Container and runs a caller-supplied command as root inside it. It
 * is the most expensive route in the product, so its limits are asserted directly
 * rather than left as untested `if` statements in a handler.
 *
 * `src/product/start.mjs` is pure, so all of this runs without an account. What is not
 * covered here, and stated rather than implied: that the platform's `container.start`,
 * `container.monitor()` and `container.stop()` behave as `waitBounded` assumes. That
 * needs a live container — see `docs/product-hardening-plan.md` item 8.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decideStart,
  waitBounded,
  StartRefusal,
  MAX_RUN_MS,
  MAX_COMMAND_BYTES,
  MAX_CONCURRENT_STARTS,
  MAX_PATH_BYTES,
  SLOT_TTL_MS,
} from '../src/product/start.mjs';
import { launcherScript } from '../src/product/launcher.mjs';
import { MAX_LEASE_PATHS } from '../src/product/lease.mjs';

const NOW = 1_700_000_000_000;
const valid = { participantId: 'a', participantCommand: 'echo hi' };

const refuses = (body, slots, reason) => {
  assert.throws(
    () => decideStart(body, slots, NOW),
    error => {
      assert.ok(error instanceof StartRefusal, `expected a StartRefusal, got ${error}`);
      assert.equal(error.reason, reason, `expected reason ${reason}, got ${error.reason}`);
      return true;
    },
  );
};

// --- what is accepted ---------------------------------------------------------

test('a well-formed start is admitted on sensible defaults', () => {
  const decision = decideStart(valid, [], NOW);
  assert.equal(decision.participantId, 'a');
  assert.equal(decision.command, 'echo hi');
  assert.equal(decision.workDir, '/workspace');
  assert.equal(decision.runMs, MAX_RUN_MS);
});

test('an explicit workDir and runMs are carried through', () => {
  const decision = decideStart({ ...valid, workDir: '/workspace/sub', runMs: 60_000 }, [], NOW);
  assert.equal(decision.workDir, '/workspace/sub');
  assert.equal(decision.runMs, 60_000);
});

// --- the command must be short ------------------------------------------------

test('an over-long command is refused before anything is created', () => {
  refuses({ participantId: 'a', participantCommand: 'x'.repeat(MAX_COMMAND_BYTES + 1) }, [], 'participant_command_too_long');
});

test('the command cap is measured in bytes, not characters', () => {
  // A multi-byte character is one character and several bytes. Capping characters would
  // let a caller send 4x the intended budget.
  const multibyte = 'é'.repeat(MAX_COMMAND_BYTES / 2 + 1);
  assert.ok(multibyte.length < MAX_COMMAND_BYTES, 'fewer characters than the byte cap');
  refuses({ participantId: 'a', participantCommand: multibyte }, [], 'participant_command_too_long');
});

test('a command at exactly the cap is admitted', () => {
  const at = 'x'.repeat(MAX_COMMAND_BYTES);
  assert.equal(decideStart({ participantId: 'a', participantCommand: at }, [], NOW).command, at);
});

test('a missing or non-string command is refused', () => {
  refuses({ participantId: 'a' }, [], 'missing_participant_command');
  refuses({ participantId: 'a', participantCommand: '' }, [], 'missing_participant_command');
  refuses({ participantId: 'a', participantCommand: 42 }, [], 'missing_participant_command');
  refuses({ participantId: 'a', participantCommand: ['echo'] }, [], 'missing_participant_command');
});

// --- the run must terminate ---------------------------------------------------

test('a runMs beyond the ceiling is refused rather than clamped', () => {
  // Clamping would answer 200 for a request the caller did not make, and the container
  // would be stopped at a limit the caller never agreed to.
  refuses({ ...valid, runMs: MAX_RUN_MS + 1 }, [], 'invalid_run_ms');
  refuses({ ...valid, runMs: 0 }, [], 'invalid_run_ms');
  refuses({ ...valid, runMs: -1 }, [], 'invalid_run_ms');
  refuses({ ...valid, runMs: 999 }, [], 'invalid_run_ms');
  refuses({ ...valid, runMs: Infinity }, [], 'invalid_run_ms');
  refuses({ ...valid, runMs: '60000' }, [], 'invalid_run_ms');
});

// --- the workDir is a path, not a shell fragment ------------------------------

test('a workDir carrying shell metacharacters is refused', () => {
  // The injection this replaces:
  //   workDir = "'; echo INJECTED; #"
  //   →  WORK=''; echo INJECTED; #'
  // which ran as root in the container before the participant command was read.
  for (const workDir of [
    "'; echo INJECTED; #",
    '/workspace; rm -rf /',
    '/work$(id)space',
    '/work`id`space',
    '/work space',
    '/workspace\nrm -rf /',
    '/../etc',
    '/workspace/../..',
    'relative/path',
    '/',
    '',
    '/workspace/.',
  ]) {
    refuses({ ...valid, workDir }, [], 'invalid_work_dir');
  }
});

test('a reasonable workDir is admitted', () => {
  for (const workDir of ['/workspace', '/workspace/sub', '/w-1', '/a.b_c-d/e']) {
    assert.equal(decideStart({ ...valid, workDir }, [], NOW).workDir, workDir);
  }
});

test('the launcher no longer interpolates workDir into its script body', () => {
  // Belt and braces: `decideStart` validates the shape, and the launcher carries the
  // value in the environment so a second, forgotten interpolation cannot become an
  // injection later. Asserted on the generated script, not on the parameter list,
  // because the parameter list is easy to satisfy while the script is still unsafe.
  const script = launcherScript({ participantCommand: 'echo hi' });
  assert.doesNotMatch(script, /^WORK='/m, 'WORK must come from the environment, not the script body');
  assert.match(script, /WORK="\$\{INGRESS_WORK_DIR/, 'WORK must be read from INGRESS_WORK_DIR');

  const workLine = script.split('\n').find(line => line.startsWith('WORK='));
  assert.doesNotMatch(workLine, /'/, 'the WORK assignment must not introduce a quote to break out of');
});

test('a participantCommand cannot rewrite the launcher either', () => {
  // The pre-existing guarantee, asserted here because it is the same class of bug as
  // the workDir injection and belongs beside it.
  //
  // Checked line by line rather than by `script.includes(evil)`: the launcher ends with
  // `cat /tmp/ingress-participant.log`, and a naive whole-script search would pass for
  // the wrong reason if the text ever appeared in an unrelated context. What matters is
  // that no *executable* line contains caller text.
  const evil = `'; echo INJECTED; #`;
  const script = launcherScript({ participantCommand: evil });

  assert.doesNotMatch(script, /INJECTED/, 'the command text must not appear in the script at all');
  // The command is read from the environment on a line that introduces no quoting of
  // its own, so a value cannot close a string that is already open.
  const commandLine = script.split('\n').find(line => line.startsWith('PARTICIPANT_COMMAND='));
  assert.equal(commandLine, 'PARTICIPANT_COMMAND="$INGRESS_PARTICIPANT_COMMAND"');
});

// --- the workspace has a slot budget ------------------------------------------

test('a workspace at its cap refuses another start', () => {
  const slots = Array.from({ length: MAX_CONCURRENT_STARTS }, () => NOW + 60_000);
  refuses(valid, slots, 'too_many_concurrent_starts');
});

test('one slot below the cap is admitted', () => {
  const slots = Array.from({ length: MAX_CONCURRENT_STARTS - 1 }, () => NOW + 60_000);
  const decision = decideStart(valid, slots, NOW);
  assert.equal(decision.released.length, MAX_CONCURRENT_STARTS - 1);
});

test('an abandoned slot does not block the workspace forever', () => {
  // A Durable Object can be evicted mid-run. The next instance must not inherit a full
  // quota from a process that no longer exists, so expiry is what frees a slot — not a
  // timer, and not the previous holder returning.
  const abandoned = Array.from({ length: MAX_CONCURRENT_STARTS }, () => NOW - 1);
  const decision = decideStart(valid, abandoned, NOW);
  assert.equal(decision.released.length, 0, 'expired slots must be dropped, not carried');
});

test('a slot is freed exactly at its deadline, not before', () => {
  const expiry = NOW + SLOT_TTL_MS;
  const at = Array.from({ length: MAX_CONCURRENT_STARTS }, () => expiry);
  refuses(valid, at, 'too_many_concurrent_starts');
  // One millisecond later the same slots are gone.
  const after = decideStart(valid, at, expiry + 1);
  assert.equal(after.released.length, 0);
});

test('a non-numeric or malformed slot list is treated as empty, not trusted', () => {
  for (const slots of [[null], ['soon'], [{}], [Number.NaN], [undefined]]) {
    const decision = decideStart(valid, slots, NOW);
    assert.equal(decision.released.length, 0, `${JSON.stringify(slots)} was counted as a live slot`);
  }
});

// --- the wait is bounded ------------------------------------------------------

test('a command that exits in time returns without a timeout', async () => {
  const outcome = await waitBounded(async () => {}, null, 1000, {
    setTimer: (fn, ms) => ({ fn, ms }),
    clearTimer: () => {},
  });
  assert.equal(outcome.timedOut, false);
});

test('a command that overruns is reported as a timeout, not waited on forever', async () => {
  let stopped = false;
  const outcome = await waitBounded(
    () => new Promise(() => {}), // never settles, as a hung container would
    async () => { stopped = true; },
    50,
  );
  assert.equal(outcome.timedOut, true);
  assert.equal(stopped, true, 'an overrunning container must be stopped, not left billing');
});

test('a timeout is still reported when the runtime offers no stop', async () => {
  // The container API's shape was not verifiable from here, so `waitBounded` does not
  // assume `stop` exists. The deadline must return regardless.
  const outcome = await waitBounded(() => new Promise(() => {}), null, 50);
  assert.equal(outcome.timedOut, true);
});

test('a failing stop does not become a start that never returns', async () => {
  const outcome = await waitBounded(
    () => new Promise(() => {}),
    async () => { throw new Error('stop refused'); },
    50,
  );
  assert.equal(outcome.timedOut, true);
});

test('the deadline timer is cleared when the command exits first', async () => {
  let cleared = null;
  await waitBounded(async () => {}, null, 60_000, {
    setTimer: (fn, ms) => ({ fn, ms }),
    clearTimer: handle => { cleared = handle; },
  });
  assert.notEqual(cleared, null, 'a pending 15-minute timer must not outlive a fast command');
});

// --- the handler consults the decision before doing anything -----------------

test('the handler refuses before it mints a token or registers a participant', async () => {
  // The order matters: a refusal that has already written a token has had a side
  // effect the caller did not ask for.
  const source = readFileSync(new URL('../src/product/handlers/container.mjs', import.meta.url), 'utf8');
  const decided = source.indexOf('decideStart(');
  const minted = source.indexOf('crypto.randomUUID()');
  const started = source.indexOf('container.start(');

  assert.ok(decided > -1, 'the handler must consult decideStart');
  assert.ok(decided < minted, 'the decision must precede minting a token');
  assert.ok(decided < started, 'the decision must precede booting a container');
});

test('the handler takes a slot before starting and releases it after', async () => {
  const source = readFileSync(new URL('../src/product/handlers/container.mjs', import.meta.url), 'utf8');
  assert.ok(
    source.indexOf('startsKey') < source.indexOf('container.start('),
    'the slot must be taken before the container starts, or two concurrent starts both see a free slot',
  );
  assert.ok(
    source.indexOf('releaseStart') > source.indexOf('container.start('),
    'the slot must be released after the container runs',
  );
  assert.match(source, /finally|releaseStart\(ctx, decision\.releasedAt\)/, 'a slot must be released');
});

test('a deployment with no container binding still answers 501, not a refusal', async () => {
  // Ordering matters here and this pins it. `decideStart` runs before the container
  // check, so a malformed request is refused without side effects — which means the
  // route-coverage probe in `product-workspace.test.mjs` no longer reaches the 501
  // branch, because its probe body carries no `participantCommand`. Without this test
  // that branch would be uncovered and the probe would be passing for the wrong reason.
  const { WorkspaceAgent } = await import('../src/product/workspace-agent.mjs');
  const data = new Map();
  const agent = new WorkspaceAgent({
    storage: {
      async get(key) {
        return Array.isArray(key) ? new Map(key.map(k => [k, data.get(k)])) : data.get(key);
      },
      async put(key, value) {
        if (typeof key === 'object' && key !== null && !Array.isArray(key)) {
          for (const [k, v] of Object.entries(key)) data.set(k, structuredClone(v));
          return;
        }
        data.set(key, structuredClone(value));
      },
    },
  });

  const response = await agent.fetch(new Request('https://x/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantId: 'a', participantCommand: 'echo hi' }),
  }));
  assert.equal(response.status, 501);
  assert.equal((await response.json()).error, 'no_container');
});

test('a refused start has no side effects at all', async () => {
  // The refusal must not have minted a token or registered a participant. Checked
  // against storage, because "returns 409" alone would also be true of a handler that
  // did the damage first and apologised afterwards.
  const { WorkspaceAgent } = await import('../src/product/workspace-agent.mjs');
  const data = new Map();
  const agent = new WorkspaceAgent({
    storage: {
      async get(key) {
        return Array.isArray(key) ? new Map(key.map(k => [k, data.get(k)])) : data.get(key);
      },
      async put(key, value) {
        if (typeof key === 'object' && key !== null && !Array.isArray(key)) {
          for (const [k, v] of Object.entries(key)) data.set(k, structuredClone(v));
          return;
        }
        data.set(key, structuredClone(value));
      },
    },
  });

  const response = await agent.fetch(new Request('https://x/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      participantId: 'a',
      participantCommand: 'echo hi',
      workDir: "'; echo INJECTED; #",
    }),
  }));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.reason, 'invalid_work_dir');

  // The refusal names what was wrong and echoes the offending value, so a caller can
  // fix it. It does not leak the error class: spreading an Error copies `name`, and
  // an internal class name is not something a caller should be reading.
  assert.equal(body.workDir, "'; echo INJECTED; #");
  assert.equal('name' in body, false, `the refusal leaked the error class: ${JSON.stringify(body)}`);
  assert.equal(body.stack, undefined);

  const written = [...data.keys()];
  assert.deepEqual(written, [], `a refused start wrote ${JSON.stringify(written)}`);
});

test('the handler passes no workDir into the launcher script', async () => {
  const source = readFileSync(new URL('../src/product/handlers/container.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /launcherScript\(\{[^}]*workDir/s,
    'workDir must travel in the environment, not be interpolated into the script',
  );
});

// --- which paths the run will hold a lease on ---------------------------------

test('a start with no writePaths leases nothing, exactly as before', () => {
  // The default has to be the previous behaviour. A caller that already checked out, or
  // that wants the container to commit nothing, must not be silently handed a lease.
  const decision = decideStart(valid, [], NOW);
  assert.deepEqual(decision.writePaths, []);
});

test('writePaths are validated, and a bad one names itself', () => {
  for (const bad of [
    '/etc/cron.d/ingress',   // absolute, and outside the work directory entirely
    '../escape.mjs',         // upward
    'a/../../b.mjs',         // upward from a subdirectory
    './engine.mjs',          // leading dot segment
    'a//b.mjs',              // empty segment
    'a/',                    // trailing slash
    'a/./b.mjs',             // dot segment in the middle
    '',
    'a\\b.mjs',              // backslash is not a separator here, so this is one odd filename
    'a b.mjs',               // a space survives into the shell and the URL
    'a;b.mjs',               // a shell metacharacter
    42,                      // not a string
    null,
  ]) {
    assert.throws(
      () => decideStart({ ...valid, writePaths: [bad] }, [], NOW),
      error => {
        if (error.reason !== 'invalid_write_path') return false;
        // A non-string is reported as `null` rather than echoed, since there is no path
        // to name — but the caller still has to be able to tell *which* entry was wrong,
        // so the array position is what identifies it here.
        if (typeof bad === 'string') return error.writePath === bad;
        return error.writePath === null;
      },
      `${JSON.stringify(bad)} was accepted as a lease path`,
    );
  }
});

test('every malformed write path is reported, not just the first', () => {
  // A caller sending three paths and one malformed should not have to guess which of the
  // other two were fine. The guard loops; this asserts the loop reports the offender
  // rather than bailing on the array's length.
  const error = (() => {
    try {
      decideStart({ ...valid, writePaths: ['good.mjs', 'also-good.mjs', '../bad.mjs'] }, [], NOW);
    } catch (thrown) {
      return thrown;
    }
  })();
  assert.equal(error?.reason, 'invalid_write_path');
  assert.equal(error.writePath, '../bad.mjs');
});

test('a write path is bounded in length as well as in shape', () => {
  const long = `${'a'.repeat(MAX_PATH_BYTES)}.mjs`;
  assert.equal(Buffer.byteLength(long, 'utf8') > MAX_PATH_BYTES, true);
  assert.throws(
    () => decideStart({ ...valid, writePaths: [long] }, [], NOW),
    error => error.reason === 'invalid_write_path',
  );
  // A 512-byte path is not a plausible workspace file, but the cap must not be so tight
  // that a legitimate one is refused.
  assert.equal(decideStart({ ...valid, writePaths: ['a'.repeat(200)] }, [], NOW).writePaths.length, 1);
});

test('writePaths must be an array, and are deduplicated', () => {
  assert.throws(
    () => decideStart({ ...valid, writePaths: 'engine.mjs' }, [], NOW),
    error => error.reason === 'invalid_write_paths',
    'a string must not be read as a list of one path',
  );
  const decision = decideStart({ ...valid, writePaths: ['a.mjs', 'a.mjs', 'b.mjs'] }, [], NOW);
  assert.deepEqual(decision.writePaths, ['a.mjs', 'b.mjs']);
});

test('writePaths are capped at the lease path limit', () => {
  const many = Array.from({ length: 257 }, (_, i) => `f${i}.mjs`);
  assert.throws(
    () => decideStart({ ...valid, writePaths: many }, [], NOW),
    error => error.reason === 'too_many_write_paths' && error.cap === 256,
  );
});

test('nested write paths are allowed', () => {
  // `expandClosure` and the commit route both accept nested paths, so refusing them here
  // would make a legitimate workspace unworkable.
  const decision = decideStart({ ...valid, writePaths: ['src/deep/nested/file.mjs'] }, [], NOW);
  assert.deepEqual(decision.writePaths, ['src/deep/nested/file.mjs']);
});

// --- mutations: every guard above, broken on purpose -------------------------

/**
 * Load a mutated copy of `start.mjs` and assert the suite's own assertions fail.
 *
 * A guard that has never been observed failing is not known to work. Each mutation
 * below is one plausible regression; each must be caught by the assertion named in
 * `mustFail`, or this test fails.
 */
async function loadMutated(transform, name) {
  const { mkdtemp, writeFile, readFile, rm, cp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const { pathToFileURL } = await import('node:url');

  const original = await readFile(new URL('../src/product/start.mjs', import.meta.url), 'utf8');
  const mutated = transform(original);
  assert.notEqual(mutated, original, `mutation ${name} changed nothing, so it proves nothing`);

  const dir = await mkdtemp(joinPath(tmpdir(), 'ingress-start-mutation-'));

  // The whole directory, not just `start.mjs`. It started importing `./lease.mjs` for the
  // write-path cap, and a harness that copied one file reported every mutation as a
  // module-not-found failure rather than as the guard failing to catch anything. Which is
  // the more dangerous of the two errors: it looks like the mutations were caught.
  await cp(new URL('../src/product/', import.meta.url), dir, { recursive: true });
  await writeFile(joinPath(dir, 'start.mjs'), mutated);
  return { module: await import(pathToFileURL(joinPath(dir, 'start.mjs')).href), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Await a promise that is expected to finish, failing if it does not.
 *
 * The unbounded-wait guards below deliberately hand `waitBounded` a promise that never
 * settles. That is the bug being guarded against, so if `waitBounded` loses its
 * deadline the guard must still *fail* rather than hang the suite — a guard that can
 * hang the run cannot report that the property it checks is gone.
 */
function within(promise, ms = 2000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`waitBounded did not return within ${ms}ms`)), ms).unref?.(),
    ),
  ]);
}

const GUARDS = [
  // --- the write-path surface, as mutations of the same module ---------------
  //
  // These run through `GUARDS` rather than being standalone tests, because the mutation
  // pass at the end loads a broken copy of `start.mjs` and runs the guards against it. A
  // guard that is not in this list is not run against a mutation, so a mutation that
  // broke it would go unnoticed — which is exactly what happened the first time these
  // were written as ordinary tests: all four mutations "survived".
  {
    name: 'writePaths are validated',
    async run(m) {
      for (const bad of ['/etc/passwd', '../escape.mjs', './x.mjs', 'a//b.mjs', 'a b.mjs', 42]) {
        assert.throws(
          () => m.decideStart({ participantId: 'a', participantCommand: 'x', writePaths: [bad] }, [], NOW),
          error => error.reason === 'invalid_write_path',
          `${JSON.stringify(bad)} was accepted as a lease path`,
        );
      }
    },
  },
  {
    name: 'writePaths must be an array',
    async run(m) {
      assert.throws(
        () => m.decideStart({ participantId: 'a', participantCommand: 'x', writePaths: 'x.mjs' }, [], NOW),
        error => error.reason === 'invalid_write_paths',
      );
    },
  },
  {
    name: 'writePaths are capped',
    async run(m) {
      // `MAX_LEASE_PATHS` is read from this file rather than from `m`. The mutated module
      // imports it but does not re-export it, so `m.MAX_LEASE_PATHS` is `undefined`,
      // `undefined + 1` is `NaN`, and `Array.from({length: NaN})` is an *empty* array —
      // the guard would then be asserting that an empty list is refused, and pass.
      const many = Array.from({ length: MAX_LEASE_PATHS + 1 }, (_, i) => `f${i}.mjs`);
      assert.equal(many.length, MAX_LEASE_PATHS + 1, 'the fixture itself is empty');
      assert.throws(
        () => m.decideStart({ participantId: 'a', participantCommand: 'x', writePaths: many }, [], NOW),
        error => error.reason === 'too_many_write_paths' && error.cap === MAX_LEASE_PATHS,
      );
    },
  },
  {
    name: 'a start with no writePaths leases nothing',
    async run(m) {
      assert.deepEqual(
        m.decideStart({ participantId: 'a', participantCommand: 'x' }, [], NOW).writePaths,
        [],
      );
    },
  },
  {
    name: 'the workDir traversal guard',
    async run(m) {
      for (const workDir of ['/workspace/../..', '/workspace/.', '/a/../b']) {
        assert.throws(() => m.decideStart({ participantId: 'a', participantCommand: 'x', workDir }, [], NOW));
      }
    },
  },
  {
    name: 'the workDir metacharacter guard',
    async run(m) {
      for (const workDir of ["'; echo INJECTED; #", '/w;id', '/w$(id)', '/w`id`']) {
        assert.throws(() => m.decideStart({ participantId: 'a', participantCommand: 'x', workDir }, [], NOW));
      }
    },
  },
  {
    name: 'the runMs ceiling',
    async run(m) {
      assert.throws(() => m.decideStart({ participantId: 'a', participantCommand: 'x', runMs: m.MAX_RUN_MS * 10 }, [], NOW));
      assert.throws(() => m.decideStart({ participantId: 'a', participantCommand: 'x', runMs: 0 }, [], NOW));
    },
  },
  {
    name: 'the runMs type check',
    async run(m) {
      assert.throws(() => m.decideStart({ participantId: 'a', participantCommand: 'x', runMs: '60000' }, [], NOW));
    },
  },
  {
    name: 'the command byte cap',
    async run(m) {
      const long = 'x'.repeat(m.MAX_COMMAND_BYTES + 1);
      assert.throws(() => m.decideStart({ participantId: 'a', participantCommand: long }, [], NOW));
    },
  },
  {
    name: 'the concurrent-start cap',
    async run(m) {
      const slots = Array.from({ length: m.MAX_CONCURRENT_STARTS + 5 }, () => NOW + 60_000);
      assert.throws(() => m.decideStart({ participantId: 'a', participantCommand: 'x' }, slots, NOW));
    },
  },
  {
    // Asserted as *admission*, not as `released.length === 0`.
    //
    // The first draft of this guard checked the returned array, which is empty under
    // the mutation as well — `released` filters on `> now` either way, so the guard
    // passed while the property it claimed to check was gone. The observable difference
    // is whether an abandoned slot at the cap refuses the start, and that is what this
    // asserts.
    name: 'expiry of an abandoned slot',
    async run(m) {
      const abandoned = Array.from({ length: m.MAX_CONCURRENT_STARTS }, () => NOW - 1);
      const decision = m.decideStart({ participantId: 'a', participantCommand: 'x' }, abandoned, NOW);
      assert.equal(decision.participantId, 'a', 'an abandoned slot blocked the workspace');
      assert.equal(decision.released.length, 0);
    },
  },
  {
    name: 'the bounded wait',
    async run(m) {
      const outcome = await within(m.waitBounded(() => new Promise(() => {}), null, 20));
      assert.equal(outcome.timedOut, true, 'an overrunning command must time out');
    },
  },
  {
    name: 'stopping an overrunning container',
    async run(m) {
      let stopped = false;
      const outcome = await within(
        m.waitBounded(() => new Promise(() => {}), async () => { stopped = true; }, 20),
      );
      assert.equal(stopped, true);
      // And the outcome says so. A caller that gets `timedOut: true` with nothing about
      // `stop` cannot tell a stopped container from a running one, and on this runtime
      // that difference is the whole difference between "retry" and "wait" — the platform
      // refuses the next `/start` with a 500 until the original command finishes on its own.
      assert.equal(outcome.stopAvailable, true, 'a container that was stopped must be reported as stopped');
      assert.equal(outcome.stopError, null);
    },
  },
  {
    // The measurement from the live deployment: `container.stop` does not exist on this
    // runtime, so the deadline bounds the *request* and not the *work*. The guard is that
    // the outcome says which happened, rather than reporting a bare `timedOut: true` that
    // reads as "the command ended".
    name: 'a runtime that cannot stop a container says so',
    async run(m) {
      const outcome = await within(m.waitBounded(() => new Promise(() => {}), null, 20));
      assert.equal(outcome.timedOut, true, 'the deadline must still fire');
      assert.equal(outcome.stopAvailable, false, 'and the absence of stop must be reported');
    },
  },
  {
    name: 'a stop that throws is reported rather than swallowed',
    async run(m) {
      const outcome = await within(m.waitBounded(
        () => new Promise(() => {}),
        async () => { throw new Error('platform refused'); },
        20,
      ));
      assert.equal(outcome.timedOut, true, 'a failing stop must not become a start that never returns');
      assert.equal(outcome.stopAvailable, false, 'and it must not be reported as a successful stop');
      assert.match(outcome.stopError, /platform refused/);
    },
  },
  {
    // The worst one found on this deployment. `container.monitor()` *rejects* when the
    // container exits non-zero, and that rejection used to propagate: `POST /start`
    // answered 500 and the caller lost the verdict, the exit code and the receipts for a
    // participant that had done real work and then failed. Observed: a command that wrote
    // a file and then `exit 3` had that file admitted at revision 1, while the caller got
    // `{"error":"Container exited with unexpected exit code: 3"}`.
    //
    // A failing participant is not a server error, and this is the guard that says so.
    name: 'a container that exits non-zero is an outcome, not an error',
    async run(m) {
      const outcome = await within(m.waitBounded(
        () => Promise.reject(new Error('Container exited with unexpected exit code: 3')),
        null,
        2000,
      ));
      assert.equal(outcome.timedOut, false,
        'a command that finished must not be reported as a timeout');
      assert.match(outcome.containerError, /exit code: 3/,
        "the platform's reason must be carried, not swallowed");
    },
  },
  {
    // The other half: a clean exit must not claim the container misbehaved. Asserted
    // because `containerError: null` on the happy path is what a caller checks to tell
    // "failed" from "succeeded", and a stray non-null would read as a failure that never
    // happened.
    name: 'a clean exit reports no container error',
    async run(m) {
      const outcome = await within(m.waitBounded(() => Promise.resolve(), null, 2000));
      assert.equal(outcome.timedOut, false);
      assert.equal(outcome.containerError, null);
    },
  },
];

const MUTATIONS = [
  {
    name: 'the workDir segment guard admits dot-only segments',
    transform: s => s.replace(
      'const SEGMENT = /(?!\\.\\.?(?:\\/|$))[A-Za-z0-9._-]+/;',
      'const SEGMENT = /[A-Za-z0-9._-]+/;',
    ),
    mustFail: ['the workDir traversal guard'],
  },
  {
    name: 'the workDir guard is dropped entirely',
    transform: s => s.replace(
      "if (!WORKDIR.test(workDir)) {",
      'if (false) {',
    ),
    mustFail: ['the workDir traversal guard', 'the workDir metacharacter guard'],
  },
  {
    name: 'the runMs ceiling is removed',
    transform: s => s.replace(
      'if (!Number.isSafeInteger(runMs) || runMs < 1000 || runMs > MAX_RUN_MS) {',
      'if (!Number.isFinite(Number(runMs))) {',
    ),
    mustFail: ['the runMs ceiling', 'the runMs type check'],
  },
  {
    name: 'the runMs check coerces a string',
    transform: s => s.replace(
      'const runMs = request.runMs === undefined ? MAX_RUN_MS : request.runMs;',
      'const runMs = request.runMs === undefined ? MAX_RUN_MS : Number(request.runMs);',
    ),
    mustFail: ['the runMs type check'],
  },
  {
    name: 'the command byte cap is removed',
    transform: s => s.replace(
      'if (Buffer.byteLength(participantCommand, \'utf8\') > MAX_COMMAND_BYTES) {',
      'if (false) {',
    ),
    mustFail: ['the command byte cap'],
  },
  {
    name: 'the concurrent-start cap is removed',
    transform: s => s.replace(
      'if (live.length >= MAX_CONCURRENT_STARTS) {',
      'if (false) {',
    ),
    mustFail: ['the concurrent-start cap'],
  },
  {
    name: 'an abandoned slot is never released',
    transform: s => s.replace(
      'const live = activeSlots.filter(expiry => Number.isFinite(expiry) && expiry > now);',
      'const live = activeSlots.slice();',
    ),
    // Caught only by the expiry guard. The concurrent-start cap still fires, because a
    // full set of *live* slots still exceeds the cap either way — this mutation breaks
    // recovery, not the ceiling.
    mustFail: ['expiry of an abandoned slot'],
  },
  {
    // Caught by `within`, not by the return value: the mutation awaits a promise that
    // never settles, so the guard's own 2s bound is what turns a hang into a failure.
    name: 'the wait is unbounded again',
    transform: s => s.replace(
      'const result = await Promise.race([finished, deadline]);',
      'const result = { timedOut: false };\n    await finished;',
    ),
    mustFail: ['the bounded wait'],
  },
  {
    name: 'an overrunning container is not stopped',
    transform: s => s.replace(
      'if (stopAvailable) {',
      'if (false) {',
    ),
    // Two guards, not one: that stop is attempted at all, and that the outcome reports it.
    mustFail: ['stopping an overrunning container'],
  },
  {
    name: 'the outcome reports a stop that never happened as a stop',
    transform: s => s.replace(
      'return { timedOut: true, stopAvailable, stopError, containerError: null };',
      'return { timedOut: true, stopAvailable: true, stopError, containerError: null };',
    ),
    // The regression that matters most, and the one this deployment is shaped for: telling
    // every caller the container was stopped when it is still running and still billing.
    // The caller then retries, and the platform answers the next `/start` with a 500
    // because the container is still there.
    //
    // The first attempt at this mutation replaced the *computation* with `= true`. It
    // survived, and correctly so: the catch clause below turns `stopAvailable` back to
    // false when calling a null `stop` throws, so the observable result was unchanged. A
    // mutation that cannot be observed through the public surface is not a mutation, it is
    // a refactor — the return value is the only place this claim is made.
    mustFail: ['a runtime that cannot stop a container says so'],
  },
  {
    name: 'a failing container is allowed to reject the wait',
    transform: s => s.replace(
      // The whole `.then(onOk, onErr)` call, removed — leaving `const finished = started`
      // so the rejection propagates into `Promise.race` exactly as it did before the fix.
      /const finished = started\.then\([\s\S]*?\n    \);/,
      'const finished = started;',
    ),
    // Caught by the guard that says a failing participant is an outcome. Without the catch,
    // `Promise.race` rejects, the handler throws, and `POST /start` answers 500 for every
    // participant command that exits non-zero — losing the verdict for work that was
    // admitted.
    mustFail: ['a container that exits non-zero is an outcome, not an error'],
  },
  {
    name: 'a clean exit is reported as a container error',
    transform: s => s.replace(
      'containerError: result.containerError ?? null,',
      'containerError: \'reported anyway\',',
    ),
    mustFail: ['a clean exit reports no container error'],
  },
  {
    name: 'a failing stop is swallowed and reported as a success',
    transform: s => s.replace(
      'stopError = String(error?.message ?? error);\n          stopAvailable = false;',
      'void error;',
    ),
    mustFail: ['a stop that throws is reported rather than swallowed'],
  },
  {
    // The whole point of item 7: a lease that does not cover the run means the commit is
    // refused. If this guard cannot fail, the write-path surface is decorative.
    name: 'the write path guard is dropped entirely',
    transform: s => s.replace(
      'if (typeof path !== \'string\' || Buffer.byteLength(path, \'utf8\') > MAX_PATH_BYTES || !WORKSPACE_PATH.test(path)) {',
      'if (false) {',
    ),
    mustFail: ['writePaths are validated'],
  },
  {
    // A relative path escaping the work directory would let a lease be taken on
    // `/etc/cron.d/x`, which is not a workspace path at all.
    name: 'the write path guard admits traversal',
    transform: s => s.replace(
      'const WORKSPACE_PATH = new RegExp(`^${SEGMENT.source}(?:/${SEGMENT.source})*$`);',
      'const WORKSPACE_PATH = /^\\S+$/;',
    ),
    mustFail: ['writePaths are validated'],
  },
  {
    name: 'a non-array writePaths is coerced rather than refused',
    transform: s => s.replace(
      'if (!Array.isArray(writePaths)) {',
      'if (false) {',
    ),
    // Caught by the loop instead: a string is iterable, so `[...'a.mjs']` yields
    // characters, every one of which is a single-character segment that still passes the
    // shape test. The refusal has to be here rather than in the loop for that reason.
    mustFail: ['writePaths must be an array'],
  },
  {
    name: 'the write path cap is removed',
    transform: s => s.replace(
      'if (writePaths.length > MAX_LEASE_PATHS) {',
      'if (false) {',
    ),
    mustFail: ['writePaths are capped'],
  },
];

test('the unmutated start module satisfies every guard', async t => {
  const m = await import('../src/product/start.mjs');
  for (const guard of GUARDS) {
    await t.test(guard.name, () => guard.run(m));
  }
});

for (const mutation of MUTATIONS) {
  test(`mutation: ${mutation.name}`, async t => {
    const { module, cleanup } = await loadMutated(mutation.transform, mutation.name);
    t.after(cleanup);

    const failures = [];
    for (const guard of GUARDS) {
      try {
        await guard.run(module);
      } catch {
        failures.push(guard.name);
      }
    }
    assert.ok(mutation.mustFail.length > 0, `${mutation.name} names no guard that should catch it`);
    for (const expected of mutation.mustFail) {
      assert.ok(failures.includes(expected), `${mutation.name} survived the guard "${expected}"`);
    }
  });
}