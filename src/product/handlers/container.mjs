/**
 * Container lifecycle: start a participant, issue its token, report the verdict.
 */

import { MANIFEST_VERSION } from '../manifest.mjs';
import { launcherScript } from '../launcher.mjs';
import { json, readJSON } from '../http.mjs';
import { tokenKey, commitKey, startsKey } from '../keys.mjs';
import { lastContainerExit } from './commit.mjs';
import {
  decideStart,
  waitBounded,
  StartRefusal,
  EXIT_GRACE_MS,
  KILL_GRACE_SECONDS,
  TIMEOUT_EXIT_STATUS,
} from '../start.mjs';
import { LeaseConflict, DEFAULT_LEASE_MS, RENEW_INTERVAL_MS } from '../lease.mjs';
import * as leaseHandler from './leases.mjs';

/**
 * Start a container for a participant and issue it a token.
 *
 * The token is the identity binding. It is minted here, handed to exactly one
 * container, and checked on every commit — so a participant can act as itself and
 * cannot act as anyone else, even though it holds the token in its own environment
 * and is free to read it.
 *
 * What this route costs
 *
 * It boots a container and runs a caller-supplied command as root inside it. Three
 * bounds apply, all decided in `../start.mjs` before anything is created: the command
 * must be short, it must terminate, and the workspace must have a free slot. A
 * command that overruns is stopped and reported as a timeout rather than waited on.
 *
 * What it deliberately does not do is restrict *what* the command may be. Holding the
 * workspace credential means holding the right to run code here; the caps bound how
 * much, not whether. Narrowing that is a product decision — see
 * `docs/product-hardening-plan.md` item 3 — and not something to smuggle in here.
 */
export async function start(ctx, request, workspaceName) {
  const body = await readJSON(request);

  // Checked before anything is created. A refusal must not have minted a token,
  // registered a participant, or booted anything.
  let decision;
  try {
    decision = decideStart(body, await activeStarts(ctx));
  } catch (error) {
    if (!(error instanceof StartRefusal)) throw error;
    // Named fields rather than `...error`: spreading an Error copies its own
    // enumerable properties, which includes the internal `name` and leaks the class
    // name into an HTTP response. Only the diagnostic fields the caller can act on.
    const { reason, participantId, workDir, limitBytes, bytes, limitMs, requested, running, cap, detail } = error;
    return json(409, {
      error: 'refused',
      reason,
      participantId: participantId ?? null,
      ...(limitBytes === undefined ? {} : { limitBytes, bytes }),
      ...(limitMs === undefined ? {} : { limitMs, requested }),
      ...(cap === undefined ? {} : { running, cap }),
      ...(workDir === undefined ? {} : { workDir }),
      ...(detail === undefined ? {} : { detail }),
    });
  }
  const { participantId, command, workDir, runMs } = decision;

  const container = ctx.container;
  if (!container) {
    return json(501, {
      error: 'no_container',
      detail: 'this deployment has no container binding; commits cannot be admitted',
    });
  }
  if (!workspaceName) {
    return json(400, { error: 'unknown_workspace', detail: 'x-ingress-workspace header required' });
  }

  const ledger = await ctx.getLedger();

  // The write lease is granted BEFORE the participant is registered, and that ordering is
  // the point.
  //
  // It used to be the other way round, because `grantWrite` records the read that a write
  // lease implies and `recordRead` calls `require(participantId)` — which throws for
  // someone who has not joined. Registering first made that work.
  //
  // The cost was found by running the product rather than reading it: a `/start` refused
  // for `lease_conflict` left the participant **registered** in the ledger. Nothing else
  // was created — no token, no container, no lease — but the participant was there,
  // appearing in `/state` and in every participant list, with no way to remove it and no
  // indication that it was ever supposed to exist.
  //
  // So the registration is now after the grant, and `grantWrite` is given the permission to
  // register: it is the party that decides this participant may work, and a handover to
  // someone who has not joined is a decision about them as well as the file. One writer of
  // the roster instead of two callers guessing at its order.
  let startLease = null;
  if (decision.writePaths.length > 0) {
    try {
      startLease = await leaseHandler.grantWrite(ctx, {
        participantId,
        paths: decision.writePaths,
        leaseMs: DEFAULT_LEASE_MS,
        kind: body.kind === 'human' ? 'human' : 'agent',
      });
    } catch (error) {
      if (!(error instanceof LeaseConflict)) throw error;
      const table = await ctx.leases();
      // Recorded even on refusal, so a cycle is findable on the next attempt rather than
      // only after the other party has already committed to waiting. Same as `checkout`.
      table.noteBlocked(participantId, error.blockedOn);
      await ctx.saveLeases();
      return json(409, {
        error: 'refused',
        reason: 'lease_conflict',
        conflicts: error.conflicts,
        blockedOn: error.blockedOn,
        cycle: error.cycle ?? null,
        detail: `the write lease needed to start was refused: ${error.detail}`,
        hint: 'release the paths, retrieve them once their holder has gone, or start without writePaths',
      });
    }
  }

  // Registered here rather than before the grant, so a refused start leaves no trace. See
  // the note above: `grantWrite` registers the participant it hands files to.
  ledger.register({ participantId, kind: body.kind === 'human' ? 'human' : 'agent' });
  await ctx.saveLedger();

  const token = crypto.randomUUID();
  await ctx.state.storage.put(tokenKey(participantId), token);

  // The slot is taken before the container starts, not after. Taking it afterwards
  // leaves a window in which two concurrent starts both see a free slot.
  await ctx.state.storage.put(startsKey, decision.releasedAt ? [...decision.released, decision.releasedAt] : []);

  // Interception first. There must be no moment in which the container is running
  // and unmediated.
  await container.interceptAllOutboundHttp(ctx.env.GATE);
  try {
    container.start({
      entrypoint: ['/bin/sh', '-c', launcherScript({ participantCommand: command })],
      enableInternet: false,
      env: {
        INGRESS_WORKSPACE: workspaceName,
        INGRESS_PARTICIPANT: participantId,
        INGRESS_TOKEN: token,
        INGRESS_PARTICIPANT_COMMAND: command,
        INGRESS_WORK_DIR: workDir,
        INGRESS_MANIFEST_VERSION: String(MANIFEST_VERSION),
        // Empty rather than absent when no lease was issued. The launcher reads these
        // unconditionally and branches on the lease id, so a missing variable and an empty
        // one must not mean different things — see `launcherScript`.
        INGRESS_LEASE_ID: startLease?.leaseId ?? '',
        // The duration it was granted, not the default. A heartbeat computes
        // `expiresAt = now + leaseMs`, so sending the default here would *shorten* a lease
        // that was granted longer, and the container would lose it mid-run.
        INGRESS_LEASE_MS: String(startLease?.leaseMs ?? DEFAULT_LEASE_MS),
        INGRESS_RENEW_INTERVAL_MS: String(RENEW_INTERVAL_MS),
        // The participant command's own bound, in whole seconds, rounded **up**.
        //
        // Rounded up deliberately: `timeout` takes seconds, and rounding down would give the
        // command less time than the caller asked for — the bound would be slightly tighter
        // than the number in the request, which is the platform quietly changing the terms.
        INGRESS_RUN_SECONDS: String(Math.ceil(runMs / 1000)),
        INGRESS_KILL_GRACE_SECONDS: String(KILL_GRACE_SECONDS),
      },
    });
  } catch (error) {
    // The platform refused, and `MAX_CONCURRENT_STARTS` did not catch it in time.
    //
    // `ctx.container` is one container per Durable Object, so a start arriving while a
    // previous container is still running — including one this workspace timed out and
    // could not stop — is refused here with a 500. Turning that into a 409 with a reason
    // costs four lines and is the difference between a caller reading "busy, wait" and a
    // caller reading a platform error string.
    //
    // The slot and the lease are released on this path for the same reason they are after
    // a normal exit: this start has created nothing it is going to use.
    await releaseStart(ctx, decision.releasedAt);
    if (startLease) await releaseStartLease(ctx, participantId, startLease.leaseId);
    return json(409, {
      error: 'refused',
      reason: 'container_busy',
      participantId,
      detail: String(error?.message ?? error),
      hint: 'this workspace runs one container at a time; wait for the current one to exit',
    });
  }

  // Wait past `runMs`, not at it. The launcher kills the command at `runMs` measured from
  // when *it* starts, which is after container boot, so the container outlives `runMs` by
  // the boot duration. Waiting the grace period as well means the workspace stops watching
  // only once the container has certainly exited — see `EXIT_GRACE_MS`.
  const outcome = await waitBounded(
    () => container.monitor(),
    typeof container.stop === 'function' ? () => container.stop() : null,
    runMs + EXIT_GRACE_MS,
  );

  // The slot is released whatever happened — clean exit, timeout, or a throw below.
  // A slot held after a failed start would block the workspace until its deadline.
  await releaseStart(ctx, decision.releasedAt);

  // The lease too, and for the same reason. The launcher releases its own on the way out,
  // so this is normally a no-op answering `lease_unknown`; it is the backstop for the
  // cases where the container never got that far — killed at the deadline, crashed, or
  // stopped before the seed. Without it, one dead container holds its files for a whole
  // lease period before anyone else can touch them, and `retrieve` refuses until then.
  if (startLease) await releaseStartLease(ctx, participantId, startLease.leaseId);

  // The container has exited — or was stopped at the deadline — which means any
  // commit it made has already been through the gate and decided. Surfacing that
  // verdict here is the difference between a participant that can react to a
  // refusal and one that has to go and ask.
  const verdict = (await ctx.state.storage.get(commitKey(participantId))) ?? null;
  const participantExit = await lastContainerExit(ctx.state);

  return json(200, {
    participantId,
    started: true,
    timedOut: outcome.timedOut,
    // What a timeout actually means on this runtime, and **only** when there was one.
    //
    // `stopAvailable: false` says the container was **not** stopped: it is still running,
    // still billing, and will hold this workspace until its command finishes on its own.
    // On this account that is always the case — `container.stop` does not exist — and the
    // first version of this response reported `timedOut: true` with nothing else, which
    // reads as "the work ended". It did not. Every subsequent `/start` then failed until
    // the original command finished.
    //
    // Omitted on a normal exit on purpose. On that path there was nothing to stop, and a
    // `stopAvailable: false` there reads as "your container was not stopped" — the opposite
    // of what happened. A field that means one thing sometimes and another other times is
    // worse than no field.
    //
    // `commandTimeout: true` is the useful signal now: the launcher killed the command with
    // `timeout`, so the work is genuinely over and `timedOut: false` would be misleading.
    // It is derived from the participant's exit status (124), which is coreutils' code for
    // "I had to kill it" — so this is the launcher reporting what happened, not the
    // workspace guessing from a duration it measured.
    ...(outcome.timedOut
      ? { stopAvailable: outcome.stopAvailable, ...(outcome.stopError ? { stopError: outcome.stopError } : {}) }
      : {}),
    participantExit,
    // True when the launcher killed the command rather than the command finishing. The
    // participant is gone either way by this point, so `timedOut` — which is about the
    // *wait* — is not the whole story, and a caller asking "did my work finish?" needs this.
    commandTimeout: participantExit === TIMEOUT_EXIT_STATUS,
    // The container exited non-zero. Not an error in this route: a participant whose command
    // failed is the case the verdict below and the receipts exist for. `participantExit` is
    // the useful number; this is the platform's phrasing of the same fact.
    ...(outcome.containerError ? { containerError: outcome.containerError } : {}),
    commit: verdict,
  });
}

/**
 * Give back a lease `/start` issued, if the container did not.
 *
 * The launcher releases its own on the way out, so this is normally a no-op answering
 * `lease_unknown`. It is the backstop for the paths where the container never got that far
 * — refused by the platform, stopped at the deadline, crashed.
 *
 * Extracted because three paths need it and each of them is a path where forgetting it
 * leaves a file held by a participant that is not working on it.
 */
async function releaseStartLease(ctx, participantId, leaseId) {
  const table = await ctx.leases();
  table.release({ leaseId, participantId, now: Date.now() });
  await ctx.saveLeases();
}

/**
 * Start slots believed to be in use, as expiry timestamps.
 *
 * Stored rather than held in memory because a Durable Object can be evicted between
 * requests; an in-memory counter would reset to zero and hand out a fresh quota on
 * every cold start.
 */
async function activeStarts(ctx) {
  const stored = await ctx.state.storage.get(startsKey);
  return Array.isArray(stored) ? stored : [];
}

/**
 * Release one slot, keeping any others still running.
 *
 * Identified by its expiry rather than by position, so two starts finishing in an
 * unpredictable order cannot release each other's slot.
 */
async function releaseStart(ctx, releasedAt) {
  const stored = await activeStarts(ctx);
  await ctx.state.storage.put(startsKey, stored.filter(expiry => expiry !== releasedAt));
}