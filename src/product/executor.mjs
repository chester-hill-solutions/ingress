/**
 * The executor: one container, and no decisions.
 *
 * What this object is for
 *
 * `ctx.container` is one container per Durable Object, so a single object cannot run two
 * participants. Splitting execution out is what lets a workspace host a swarm: the
 * **workspace** object stays the sole arbiter of every fence decision, and each **executor**
 * object below owns exactly one container.
 *
 * What it deliberately cannot do
 *
 * It holds no ledger, no lease table and no token store. It cannot admit a commit, refuse
 * one, or mint an identity. Everything it is given was decided by the arbiter before it was
 * called: the container token, the write lease, the run ceiling. It reports what happened
 * and gets out of the way.
 *
 * That is the entire safety argument for the split, and it is worth stating plainly because
 * "we made it concurrent" is not a safety property: after the split there is still exactly
 * one place where a commit is decided, and this file is not it.
 *
 * Why the arbiter waits here rather than polling
 *
 * The arbiter awaits this object's response for the length of the run. Awaiting a Durable
 * Object stub releases the arbiter's input gate, so the arbiter can serve a concurrent
 * `/commit` while a `/start` is in flight — which is the property the split exists to create.
 * The alternative, a poll loop, would hold the arbiter for the same duration *without*
 * releasing the gate, which is the thing being escaped.
 *
 * Pure of Cloudflare imports for the same reason `workspace-agent.mjs` is: it is testable
 * under Node, with the container stubbed.
 */

import { waitBounded, KILL_GRACE_SECONDS } from './start.mjs';
import { MANIFEST_VERSION } from './manifest.mjs';
import { launcherScript } from './launcher.mjs';

/**
 * Boot one container and wait, bounded.
 *
 * `run` is everything the arbiter decided, handed over verbatim:
 *
 *   workspace, participantId   who this is, and which workspace to report to
 *   token                      minted by the arbiter; the executor cannot create one
 *   command, workDir           the participant's task
 *   leaseId, leaseMs           the lease the arbiter granted; empty if none
 *   renewIntervalMs            a quarter of leaseMs
 *   runMs                      the arbiter's ceiling, which this object does not choose
 *
 * @param {object} container `ctx.container`
 * @param {object} gate the `GATE` service binding, for intercepting egress
 * @param {object} run
 */
export async function runOne(container, gate, run) {
  // Interception first. There must be no moment in which the container is running and
  // unmediated — and this is now the only place that can be true, because the executor is
  // the only object that starts a container.
  await container.interceptAllOutboundHttp(gate);

  container.start({
    entrypoint: ['/bin/sh', '-c', launcherEntry(run)],
    enableInternet: false,
    env: containerEnv(run),
  });

  // The deadline is the arbiter's `runMs` plus the grace period, not this object's choice:
  // the container bounds its own command with `timeout`, so this wait ends when the container
  // ends rather than when a timer fires. `stopAvailable` is reported because it is still
  // false on this runtime, and a caller deciding whether to retry needs to know the container
  // was not stopped by us.
  return waitBounded(
    () => container.monitor(),
    typeof container.stop === 'function' ? () => container.stop() : null,
    run.runMs,
  );
}

/**
 * The environment the launcher reads.
 *
 * Every value the participant could influence travels here and never into the script body —
 * that is the mechanism that fixed the `workDir` shell injection, and it is preserved rather
 * than reintroduced by a second path into the launcher.
 */
function containerEnv(run) {
  return {
    INGRESS_WORKSPACE: run.workspace,
    INGRESS_PARTICIPANT: run.participantId,
    INGRESS_TOKEN: run.token,
    INGRESS_PARTICIPANT_COMMAND: run.command,
    INGRESS_WORK_DIR: run.workDir,
    INGRESS_MANIFEST_VERSION: String(MANIFEST_VERSION),
    // Empty rather than absent when no lease was issued. The launcher branches on the lease
    // id, so a missing variable and an empty one must not mean different things.
    INGRESS_LEASE_ID: run.leaseId ?? '',
    INGRESS_LEASE_MS: String(run.leaseMs ?? 0),
    INGRESS_RENEW_INTERVAL_MS: String(run.renewIntervalMs ?? 0),
    // Rounded **up**: the bound is the caller's budget, and rounding down would give the
    // command slightly less than was asked for.
    INGRESS_RUN_SECONDS: String(Math.ceil((run.runMs ?? 0) / 1000)),
    INGRESS_KILL_GRACE_SECONDS: String(KILL_GRACE_SECONDS),
  };
}

/**
 * The launcher script.
 *
 * Imported rather than reimplemented. The executor's job is to boot the same container with
 * the same launcher the single-object version booted — a second copy of the script would be a
 * second thing to keep in step, and every test covering the launcher's ordering or its
 * `timeout` bound would cover only one of the two.
 */
function launcherEntry(run) {
  // An options object, not the bare string. `launcherScript({participantCommand})` — passing
  // the command itself throws "launcherScript requires a participantCommand", which reads as
  // the command having arrived empty when in fact it arrived intact and was passed wrongly.
  return launcherScript({ participantCommand: run.command });
}