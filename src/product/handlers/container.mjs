/**
 * Container lifecycle: decide everything here, run it somewhere else.
 *
 * This file is the **arbiter**. It holds no container and never boots one. Every decision a
 * start involves is made here, in one object, in one turn:
 *
 *   is the request well formed, is there budget, is there a slot
 *   does this participant get the lease it asked for
 *   what token is it acting under
 *   what is counted against its cost ceiling
 *
 * The container itself runs in an **executor** object — a different Durable Object, because
 * `ctx.container` is one container per object and a workspace that could only ever run one
 * participant was not a swarm. The split is safe because it is asymmetric on purpose: the
 * executor holds no ledger, no lease table and no token store, so it cannot admit a commit or
 * mint an identity. It is handed a token the arbiter minted and a lease the arbiter granted,
 * and it reports what happened.
 *
 * After the split there is still exactly one place where a commit is decided. "We made it
 * concurrent" is not a safety property; that is.
 */

import { json, readJSON } from '../http.mjs';
import { tokenKey, commitKey, startsKey, logKey } from '../keys.mjs';
import { lastContainerExit } from './commit.mjs';
import { decideStart, waitBounded, StartRefusal, EXIT_GRACE_MS, TIMEOUT_EXIT_STATUS } from '../start.mjs';
import { LeaseConflict, DEFAULT_LEASE_MS, RENEW_INTERVAL_MS } from '../lease.mjs';
import { startRefusal, usageSnapshot, startDelta, leaseConflictDelta } from '../usage.mjs';
import { allocateSlot, SlotRefusal, maxConcurrentStarts, executorName, SLOT_TTL_MS } from '../slots.mjs';
import * as leaseHandler from './leases.mjs';

/**
 * Start a participant: decide, delegate, report.
 *
 * The token is the identity binding. It is minted here, handed to exactly one container, and
 * checked on every commit by this same object — so a participant can act as itself and cannot
 * act as anyone else, even though it holds the token in its own environment and is free to
 * read it. The executor is handed the token; it cannot create one.
 */
export async function start(ctx, request, workspaceName) {
  const body = await readJSON(request);

  // Checked before anything is created. A refusal must not have minted a token,
  // registered a participant, or delegated anything.
  const cap = maxConcurrentStarts(ctx.env ?? {});
  let decision;
  let slot;
  try {
    decision = decideStart(body, []);
    ({ slot } = allocateSlot(await activeStarts(ctx), cap));
  } catch (error) {
    if (!(error instanceof StartRefusal) && !(error instanceof SlotRefusal)) throw error;
    // Named fields rather than `...error`: spreading an Error copies its own enumerable
    // properties, which includes the internal `name` and leaks the class name into an HTTP
    // response. Only the diagnostic fields the caller can act on.
    const { reason, participantId, workDir, limitBytes, bytes, limitMs, requested, running, detail } = error;
    return json(409, {
      error: 'refused',
      reason,
      participantId: participantId ?? null,
      ...(limitBytes === undefined ? {} : { limitBytes, bytes }),
      ...(limitMs === undefined ? {} : { limitMs, requested }),
      ...(running === undefined ? {} : { running, cap }),
      ...(workDir === undefined ? {} : { workDir }),
      ...(detail === undefined ? {} : { detail }),
    });
  }
  const { participantId, command, workDir, runMs } = decision;

  if (!workspaceName) {
    return json(400, { error: 'unknown_workspace', detail: 'x-ingress-workspace header required' });
  }

  // The executor binding missing is a deployment misconfiguration, not contention.
  //
  // Without this check the failure surfaced as `container_busy` — the exception below catches
  // reaching an undefined binding and cannot tell it apart from a platform refusal — so a
  // deployment that could start nothing at all would be answering 409 about slots and waits,
  // and an operator would have been sent to look at the wrong thing. Found by a test shim
  // with no executor, which answered 409 for every start while appearing to test the caps.
  if (!ctx.env?.EXECUTOR) {
    return json(501, {
      error: 'no_executor',
      detail: 'the EXECUTOR durable object binding is not configured; participants cannot be started',
    });
  }

  const ledger = await ctx.getLedger();

  // The cost ceiling, checked here — before the participant is registered, before a lease is
  // granted, before a token is minted, before anything is booted.
  //
  // Order matters in one specific way: a refused start must not consume the quota it was
  // refused for. The counter is incremented only on the success path, so a caller who
  // retries cannot lock themselves out, and one who is over the ceiling gets a refusal that
  // says which bound was reached rather than a generic failure they have to guess at.
  const usage = await ctx.usage();
  const overBudget = startRefusal(usage, ctx.ceiling(), { runMs: decision.runMs });
  if (overBudget) {
    return json(429, {
      error: 'refused',
      ...overBudget,
      participantId,
      // The whole point of the counter: a caller that has hit a ceiling needs to see what it
      // has used to know whether the answer is "stop" or "this will not work for you either".
      usage: usageSnapshot(usage, ctx.ceiling()),
    });
  }

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
  let intentConflict = null;
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
      // Advisory: the paths are held by someone else, so this participant starts **without** a
      // write lease and lands by merging rather than by exclusion.
      //
      // Refusing the start was the old behaviour, and it discarded the work entirely -- the
      // contention trial measured five of six *disjoint* same-file edits refused, each one
      // correct. A participant that cannot start produces nothing to merge, so the merge can
      // only help if the participant is allowed to work. The lease keeps its role as
      // coordination -- it orders and warns -- and stops being the thing that decides who may
      // produce work at all.
      const table = await ctx.leases();
      // Recorded even now, so a cycle is findable on the next attempt rather than only after
      // the other party has already committed to waiting.
      table.noteBlocked(participantId, error.blockedOn);
      await ctx.saveLeases();
      await ctx.addUsage(leaseConflictDelta());
      intentConflict = {
        blockedOn: error.blockedOn ?? null,
        conflicts: error.conflicts ?? [],
        cycle: error.cycle ?? null,
        detail: `the write lease was held elsewhere: ${error.detail}`,
      };
    }
  }

  // Registered here rather than before the grant, so a refused start leaves no trace. See
  // the note above: `grantWrite` registers the participant it hands files to.
  ledger.register({ participantId, kind: body.kind === 'human' ? 'human' : 'agent' });
  await ctx.saveLedger();

  // Counted here, on the success path, so a start refused above consumes no quota. It is
  // recorded before the container boots because a boot that then fails at the platform is
  // still a start — the account was charged for the attempt, and a counter that only counted
  // successes would under-report cost by exactly the number of failures.
  await ctx.addUsage(startDelta({ runMs: decision.runMs }));

const token = crypto.randomUUID();
  await ctx.state.storage.put(tokenKey(participantId), token);

  // The slot is taken before anything is delegated, not after. Taking it afterwards leaves a
  // window in which two concurrent starts both see it free and pick the same executor — which
  // surfaces as the platform's "already running" error with no cause attached.
  const occupied = await activeStarts(ctx);
  await ctx.state.storage.put(startsKey, [
    ...occupied.filter(entry => entry.expiresAt > Date.now()),
    { slot, expiresAt: Date.now() + SLOT_TTL_MS },
  ]);

  // Delegate the running. The executor is told what to run and under which token, and is given
  // no ledger, no lease and no authority — it boots one container and reports.
  //
  // Awaiting a stub releases this object's input gate, so the arbiter can decide a concurrent
  // `/commit` while this start is in flight. That is the property the split exists to create,
  // and it is why this is an await rather than a poll loop: polling would hold the gate for
  // the same duration without releasing it.
  let outcome;
  try {
    const response = await ctx.executor(workspaceName, slot).run({
      workspace: workspaceName,
      participantId,
      token,
      command,
      workDir,
      // The lease as granted. The executor cannot widen it, and the container renews at the
      // duration it was issued with rather than the default.
      leaseId: startLease?.leaseId ?? '',
      leaseMs: startLease?.leaseMs ?? DEFAULT_LEASE_MS,
      renewIntervalMs: RENEW_INTERVAL_MS,
      // The build cache the participant declared. Not fenced, not versioned -- it is an
      // optimisation, so the executor carries it without the arbiter inspecting it beyond
      // the path validation `decideStart` already did.
      cachePaths: decision.cachePaths,
      cacheKey: decision.cacheKey,
      // Past `runMs`, not at it: the launcher kills the command at `runMs` measured from when
      // *it* starts, which is after container boot, so the container outlives `runMs` by the
      // boot duration. The executor waits the grace period too, so this object stops watching
      // only once the container has certainly exited — see `EXIT_GRACE_MS`.
      runMs: runMs + EXIT_GRACE_MS,
    });
    // A refusal from the executor is an *answer*, not a throw — and reading it as success is
    // worse than crashing. The first version took `response.outcome` unconditionally, so a
    // 409 from the executor came back as `{error, reason}` with no `timedOut`, and `/start`
    // answered 200 reporting a container that had never started. The status is checked here
    // so that shape cannot recur.
    if (response.status !== 200) {
      await releaseStart(ctx, slot);
      if (startLease) await releaseStartLease(ctx, participantId, startLease.leaseId);
      return json(409, {
        error: 'refused',
        reason: 'container_busy',
        participantId,
        detail: response.outcome?.reason ?? 'the executor refused to start a container',
        // The executor's own account of what it received. Carried through rather than
        // flattened into the detail string, because "launcherScript requires a
        // participantCommand" three objects away says nothing about whether the field was
        // never sent or stripped in transit — and that is exactly the question.
        ...(response.outcome?.received ? { executorReceived: response.outcome.received } : {}),
        ...(response.outcome?.commandBytes !== undefined ? { executorCommandBytes: response.outcome.commandBytes } : {}),
        hint: `every executor slot in this workspace is in use (cap ${cap}); wait for one to exit`,
      });
    }
    outcome = response.outcome;
  } catch (error) {
    // The platform refused the executor's container. The slot and the lease are released here
    // for the same reason they are after a normal exit: this start created nothing it will use.
    await releaseStart(ctx, slot);
    if (startLease) await releaseStartLease(ctx, participantId, startLease.leaseId);
    return json(409, {
      error: 'refused',
      reason: 'container_busy',
      participantId,
      detail: String(error?.message ?? error),
      hint: `every executor slot in this workspace is in use (cap ${cap}); wait for one to exit`,
    });
  }

  // The slot is released whatever happened — clean exit, timeout, or a throw below.
  // A slot held after a failed start would block the workspace until its deadline.
  await releaseStart(ctx, slot);

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
  // The command's captured output. Stored by the gate when the manifest arrived, so it is
  // available whether the verdict was admitted, empty, or refused -- a failed build's log is
  // the one a harness most wants.
  const log = (await ctx.state.storage.get(logKey(participantId))) ?? null;

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
    // Omitted when the participant produced no output file, rather than `null`. `null` and
    // `""` look the same to a caller deciding whether to read `.log`, and the honest answer is
    // "there was no output", which is better expressed as absence.
    ...(log === null ? {} : { log }),
    // Present only when the write lease was held elsewhere and this participant started
    // without one. It is not a failure -- the participant ran -- but it is the fact a caller
    // needs to know the commit will land by merging rather than by holding the file.
    ...(intentConflict ? { intentConflict } : {}),
    usage: usageSnapshot(await ctx.usage(), ctx.ceiling()),
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
 * Executor slots believed to be in use, as `{slot, expiresAt}` records.
 *
 * Stored rather than held in memory because a Durable Object can be evicted between requests;
 * an in-memory set would empty itself on every cold start and hand the same executor to two
 * participants — which is the platform's "already running" error, arrived at by forgetting.
 */
async function activeStarts(ctx) {
  const stored = await ctx.state.storage.get(startsKey);
  return Array.isArray(stored) ? stored : [];
}

/**
 * Release one slot, keeping any others still running.
 *
 * Identified by its **number**, so two starts finishing in an unpredictable order cannot
 * release each other's slot. The first version identified it by expiry timestamp, which broke
 * the moment two starts were issued in the same millisecond — they shared an expiry, and
 * finishing one freed both.
 */
async function releaseStart(ctx, slot) {
  const stored = await activeStarts(ctx);
  await ctx.state.storage.put(startsKey, stored.filter(entry => entry.slot !== slot));
}