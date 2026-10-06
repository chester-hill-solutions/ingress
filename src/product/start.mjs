/**
 * Starting a participant: what is allowed, and how much of it at once.
 *
 * Why this file exists
 *
 * `POST /start` is the most expensive route in the product. It boots a Cloudflare
 * Container, runs a caller-supplied shell command as root inside it, and blocks until
 * that command exits. Authenticated, it is bounded only by the account holder's
 * patience and invoice.
 *
 * The decision is here, pure and testable, because the alternative is a set of
 * security-relevant limits that exist only as untested `if` statements inside a
 * handler — the same reasoning that put the router's credential check in
 * `product/router.mjs` rather than in `src/worker.js`.
 *
 * What it decides
 *
 *   - whether a start request is well formed at all
 *   - how long the command may run
 *   - whether this workspace already has as many containers going as it is allowed
 *   - which paths, if any, the caller wants a write lease held on for the duration
 *
 * That last one exists because of an interaction this file cannot fix on its own. A
 * lease defaults to 60 s, a participant command runs to completion, and the commit is
 * refused without a live write lease — so any task over a minute lost its lease and had
 * its work refused, with the cause invisible in the default. The e2e scripts hid it by
 * leasing for 300,000 ms. `/start` now issues the lease itself and hands its id to the
 * launcher, which renews it while the command runs, so the two clocks are the product's
 * rather than the caller's to reconcile.
 *
 * What it deliberately does not decide
 *
 * What the command *is*. A registered command name would be a real product decision —
 * it changes who can use this and how — and it is not a security fix. See
 * `docs/product-hardening-plan.md` item 3. The honest position today is that holding
 * the workspace credential means holding the right to run code on the account
 * holder's machine, and the caps below bound how much of that, not whether.
 */

import { MAX_LEASE_PATHS } from './lease.mjs';

/** Longest a participant command may run. */
export const MAX_RUN_MS = 15 * 60_000;

/** Longest a `participantCommand` may be. A real task is a few hundred bytes. */
export const MAX_COMMAND_BYTES = 4096;

/** Longest a `workDir` may be. It becomes a path inside the container. */
export const MAX_WORKDIR_BYTES = 256;

/**
 * Containers one workspace may have running at once.
 *
 * One, and that is measured rather than preferred.
 *
 * This used to be two, on the argument that the product's own scenario has participants
 * overlapping — an agent builds while a human edits the dependency it reads — and that one
 * would serialise the workspace into a queue. The argument about serialisation is sound
 * and the premise is false: `ctx.container` is one container per Durable Object, and a
 * second `start()` on a live container is refused by the platform with
 *
 *   start() cannot be called on a container that is already running.
 *
 * — a 500, not a refusal of ours. Found by running two overlapping participants against
 * the deployment, which is the only way to find it: every unit test here passed with the
 * value at 2, because the cap is our bookkeeping and the constraint is the platform's.
 *
 * So the honest number is 1, and the overlapping-participants scenario the product was
 * designed around **cannot happen on this runtime**. That is a product limitation, not an
 * implementation detail, and it is recorded here rather than papered over by leaving a
 * cap the platform will not honour.
 */
export const MAX_CONCURRENT_STARTS = 1;

/**
 * How long the workspace waits past `runMs`, for the container to actually die.
 *
 * The workspace's deadline and the container's own are two different clocks, and the
 * difference between them was where an unbounded-cost hole lived.
 *
 * The launcher bounds the participant command with `timeout` (coreutils, measured present
 * in the image at `/usr/bin/timeout`), so the command is killed at `runMs` **measured from
 * when the launcher starts** — which is after container boot. The workspace's deadline runs
 * from when it called `start()`, before boot. So the container would outlive the wait by the
 * boot duration, and the workspace would free its bookkeeping while the container kept
 * running.
 *
 * Waiting this much longer than the command's own bound means the workspace stops waiting
 * only once the container has certainly exited. The cost is that a caller who asks for a
 * 15-minute run waits up to 16; the benefit is that `timedOut` means the work is over rather
 * than that we stopped watching it.
 */
export const EXIT_GRACE_MS = 60_000;

/**
 * How long `timeout` waits between SIGTERM and SIGKILL.
 *
 * A participant that ignores SIGTERM would otherwise run forever — which is the exact hole
 * this mechanism exists to close, so the escalation cannot be conditional on good manners.
 */
export const KILL_GRACE_SECONDS = 5;

/** How long a start slot is held before it is assumed abandoned. */
export const SLOT_TTL_MS = MAX_RUN_MS + 60_000;

export class StartRefusal extends Error {
  constructor(reason, detail = {}) {
    super(`start_refused: ${reason}`);
    this.name = 'StartRefusal';
    this.reason = reason;
    Object.assign(this, detail);
  }
}

/**
 * Paths a workspace may be worked in.
 *
 * Absolute, no traversal, no shell metacharacters. Belt-and-braces: the launcher reads
 * `workDir` from the environment rather than interpolating it (see `launcher.mjs`), so a
 * metacharacter cannot reach the shell. Validating here anyway means the value is
 * constrained at the boundary rather than defended against twice.
 *
 * The segment pattern deliberately excludes a segment that is *only* dots. A charset of
 * `[A-Za-z0-9._-]` looks safe and is not: it admits `/workspace/.` and
 * `/workspace/../..`, because `.` and `..` are made of permitted characters. So a
 * segment must contain at least one character that is not a dot.
 */
const SEGMENT = /(?!\.\.?(?:\/|$))[A-Za-z0-9._-]+/;
const WORKDIR = new RegExp(`^/${SEGMENT.source}(?:/${SEGMENT.source})*$`);

/**
 * A path *inside* the workspace, relative to the work directory.
 *
 * The same segment rule as a work directory, without the leading slash, so a write path
 * cannot be absolute (`/etc/cron.d/x`), escape upwards (`../secrets`), or be empty. The
 * commit route accepts whatever the reporter sends, so this is the only place a path a
 * participant asked to hold a lease on is constrained before it reaches the table.
 */
const WORKSPACE_PATH = new RegExp(`^${SEGMENT.source}(?:/${SEGMENT.source})*$`);

/** Longest a workspace-relative path may be. */
export const MAX_PATH_BYTES = 512;

/**
 * The exit status `timeout(1)` uses when it had to kill the command.
 *
 * coreutils' documented value, and the only place the product learns a command was stopped
 * rather than finished — because `timedOut` describes the *wait*, and a container killed by
 * its own launcher exits long before the workspace's deadline. Asserted here rather than
 * written as a literal in the handler so the two ends of the boundary agree.
 */
export const TIMEOUT_EXIT_STATUS = 124;

/**
 * Decide whether a start may proceed, and on what terms.
 *
 * @param {object} request parsed body of `POST /start`
 * @param {number[]} activeSlots expiry timestamps of starts believed to be running
 * @param {number} [now]
 * @returns {{participantId: string, command: string, workDir: string, runMs: number,
 *            writePaths: string[], releasedAt: number, released: number[]}}
 * @throws {StartRefusal}
 */
export function decideStart(request, activeSlots = [], now = Date.now()) {
  const { participantId, participantCommand } = request ?? {};

  if (typeof participantId !== 'string' || !participantId || participantId.length > 128) {
    throw new StartRefusal('invalid_participant', { participantId: participantId ?? null });
  }
  if (typeof participantCommand !== 'string' || !participantCommand) {
    throw new StartRefusal('missing_participant_command', { participantId });
  }
  if (Buffer.byteLength(participantCommand, 'utf8') > MAX_COMMAND_BYTES) {
    throw new StartRefusal('participant_command_too_long', {
      participantId,
      limitBytes: MAX_COMMAND_BYTES,
      bytes: Buffer.byteLength(participantCommand, 'utf8'),
    });
  }

  const workDir = request.workDir ?? '/workspace';
  if (typeof workDir !== 'string' || Buffer.byteLength(workDir, 'utf8') > MAX_WORKDIR_BYTES) {
    throw new StartRefusal('invalid_work_dir', { participantId });
  }
  if (!WORKDIR.test(workDir)) {
    throw new StartRefusal('invalid_work_dir', {
      participantId,
      workDir,
      detail:
        'an absolute path whose segments contain at least one character that is not a dot, ' +
        'using only letters, digits, dot, underscore and dash',
    });
  }

  // `Number()` rather than the string being accepted. A body is untrusted JSON, and
  // `Number('60000')` would quietly honour a caller who sent a string where the contract
  // says a number — the same leniency that makes a body hard to reason about elsewhere.
  const runMs = request.runMs === undefined ? MAX_RUN_MS : request.runMs;
  if (!Number.isSafeInteger(runMs) || runMs < 1000 || runMs > MAX_RUN_MS) {
    throw new StartRefusal('invalid_run_ms', {
      participantId,
      limitMs: MAX_RUN_MS,
      requested: request.runMs ?? null,
    });
  }

  // The paths this participant wants a write lease on for the length of the run.
  //
  // Optional. A caller that has already checked out, or that wants the container to
  // commit nothing, sends none and gets exactly the previous behaviour.
  const writePaths = request.writePaths === undefined ? [] : request.writePaths;
  if (!Array.isArray(writePaths)) {
    throw new StartRefusal('invalid_write_paths', {
      participantId,
      detail: 'writePaths must be an array of workspace-relative paths',
    });
  }
  if (writePaths.length > MAX_LEASE_PATHS) {
    // The same cap `checkout` applies, checked here so the refusal happens before a
    // token is minted or a container is booted rather than after.
    throw new StartRefusal('too_many_write_paths', {
      participantId,
      requested: writePaths.length,
      cap: MAX_LEASE_PATHS,
    });
  }
  for (const path of writePaths) {
    // Every entry is checked, not just the first bad one: a caller that sent three paths
    // and one is malformed should not have to guess which of the other two were fine.
    if (typeof path !== 'string' || Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES || !WORKSPACE_PATH.test(path)) {
      throw new StartRefusal('invalid_write_path', {
        participantId,
        writePath: typeof path === 'string' ? path : null,
        detail:
          'a write path must be a workspace-relative path whose segments each contain at ' +
          'least one character that is not a dot, using only letters, digits, dot, ' +
          'underscore and dash',
      });
    }
  }

  // The build cache the participant declares. Directories, workspace-relative, that should
  // survive to the next start: `node_modules`, a compiler cache. Optional, and empty means
  // the launcher skips both cache steps.
  //
  // Validated with the same shape rule as a write path, and for a sharper reason: these
  // strings reach `tar` as arguments. A path that is not a plain relative name is a way to
  // hand `tar` an absolute path or a flag, and `tar` would run it.
  const cachePaths = request.cachePaths === undefined ? [] : request.cachePaths;
  if (!Array.isArray(cachePaths)) {
    throw new StartRefusal('invalid_cache_paths', {
      participantId,
      detail: 'cachePaths must be an array of workspace-relative directory paths',
    });
  }
  if (cachePaths.length > MAX_LEASE_PATHS) {
    throw new StartRefusal('too_many_cache_paths', {
      participantId,
      requested: cachePaths.length,
      cap: MAX_LEASE_PATHS,
    });
  }
  for (const path of cachePaths) {
    if (typeof path !== 'string' || Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES || !WORKSPACE_PATH.test(path)) {
      throw new StartRefusal('invalid_cache_path', {
        participantId,
        cachePath: typeof path === 'string' ? path : null,
        detail: 'a cache path must be a workspace-relative path; it is passed to tar',
      });
    }
  }

  const cacheKey = request.cacheKey === undefined ? 'default' : request.cacheKey;
  if (typeof cacheKey !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(cacheKey) || cacheKey === '.' || cacheKey === '..') {
    throw new StartRefusal('invalid_cache_key', {
      participantId,
      detail: 'cacheKey must be 1-128 characters of letters, digits, dot, underscore or dash',
    });
  }

  // Abandoned slots are pruned before counting, not after. A Durable Object can be
  // evicted mid-run, and the next instance must not inherit a full quota from a
  // process that no longer exists. Anything past its deadline is treated as gone.
  const live = activeSlots.filter(expiry => Number.isFinite(expiry) && expiry > now);
  if (live.length >= MAX_CONCURRENT_STARTS) {
    throw new StartRefusal('too_many_concurrent_starts', {
      participantId,
      running: live.length,
      cap: MAX_CONCURRENT_STARTS,
      detail: `${live.length} participant(s) are still running in this workspace`,
    });
  }

  return {
    participantId,
    command: participantCommand,
    workDir,
    runMs,
    // Deduplicated here rather than in the table, so the caller is told exactly how many
    // paths it now holds and the grant cannot depend on array identity.
    writePaths: [...new Set(writePaths)],
    // The cache the executor will restore before the command and save after it. Deduplicated
    // for the same reason `writePaths` is: two entries naming one directory would tar it
    // twice, and the archive would carry a duplicate.
    cachePaths: [...new Set(cachePaths)],
    cacheKey,
    releasedAt: now + SLOT_TTL_MS,
    released: live.filter(expiry => expiry > now),
  };
}

/**
 * A bounded wait on the container.
 *
 * `container.monitor()` resolves when the container exits, with no upper bound of its
 * own. Left alone, a command that never exits holds the Durable Object's request open
 * indefinitely and keeps billing. So the wait races a deadline, and on expiry the
 * container is stopped and the timeout is reported as an outcome rather than thrown —
 * the participant still did not get what it asked for, and the caller is told so.
 *
 * `stop` is called only if the runtime provides it, and on this account it does not.
 *
 * That was measured, not assumed, and the measurement changed what this function can
 * honestly claim. The guard was originally written to avoid crashing on a method that
 * might not exist, which is still right, but the comment then asserted that "if it does
 * not [exist], the deadline still returns and the slot still frees" as though that were a
 * completed stop. Both halves of that are true and neither is the point:
 *
 *   the deadline does return, and the slot does free
 *   the container does NOT stop — it runs to completion, billing for as long as it takes
 *
 * Observed on the deployment: a `sleep 30` with `runMs: 1000` reported `timedOut: true`
 * after one second, and then every subsequent `/start` in that workspace failed with
 *
 *   {"error":"start() cannot be called on a container that is already running."}
 *
 * — a 500 from the platform, until the original command finished on its own 29 seconds
 * later. So the ceiling bounds the *request*, not the *work*: the caller learns early and
 * the workspace is unusable meanwhile.
 *
 * What can be done about it is `handlers/container.mjs`'s business, and the honest answer
 * there is that a cap which cannot stop its container is a claim about latency and not
 * about cost. `stopAvailable` is returned so that handler can say so instead of
 * discovering it as a 500 on the next start.
 */
export async function waitBounded(monitor, stop, runMs, { setTimer, clearTimer } = {}) {
  const schedule = setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = clearTimer ?? (handle => clearTimeout(handle));

  // `monitor` is a thunk, not a promise, so the wait is only begun once the deadline is
  // armed. Taking a promise instead would start the container's monitor before there is
  // anything to race it against, and a caller passing either shape would work by luck.
  const started = typeof monitor === 'function' ? monitor() : monitor;

  let handle;
  const deadline = new Promise(resolve => {
    handle = schedule(() => resolve({ timedOut: true }), runMs);
  });

  try {
    // A container that exits non-zero **rejects** its monitor promise, and that is an
    // outcome rather than a server error.
    //
    // It was not handled, so every participant command that failed made `POST /start`
    // answer 500 — and took the verdict with it. Observed on the deployment: a command
    // that did real work and then `exit 3` had its file admitted at revision 1, and the
    // caller received `{"error":"Container exited with unexpected exit code: 3"}` with no
    // exit code, no commit verdict and no receipts.
    //
    // That is the worst possible shape for this product specifically: an agent that fails
    // after working is the case the receipts exist to explain, and `lastContainerExit`
    // exists precisely to record "a container that crashed after doing real work". Both
    // were unreachable on the path that produces the crash.
    //
    // So the rejection is caught here and carried as `containerError`. The container's
    // exit status still reaches the caller through the manifest the launcher reported
    // before it exited.
    const finished = started.then(
      () => ({ timedOut: false, containerError: null }),
      error => ({
        timedOut: false,
        containerError: String(error?.message ?? error),
      }),
    );
    const result = await Promise.race([finished, deadline]);
    if (result.timedOut) {
      // Whether the runtime can stop a container at all. Measured per call rather than
      // assumed in either direction, and reported so the caller can stop describing a
      // timeout as if the work had ended.
      let stopAvailable = typeof stop === 'function';
      let stopError = null;
      if (stopAvailable) {
        try {
          await stop();
        } catch (error) {
          // A stop that fails must not become a start that never returns. The slot is
          // released either way and the caller is told the command timed out — along with
          // the fact that the stop did not work.
          stopError = String(error?.message ?? error);
          stopAvailable = false;
        }
      }
      return { timedOut: true, stopAvailable, stopError, containerError: null };
    }
    return {
      timedOut: false,
      stopAvailable: typeof stop === 'function',
      stopError: null,
      containerError: result.containerError ?? null,
    };
  } finally {
    cancel(handle);
  }
}