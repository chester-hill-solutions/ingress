/**
 * Container lifecycle: start a participant, issue its token, report the verdict.
 */

import { MANIFEST_VERSION } from '../manifest.mjs';
import { launcherScript } from '../launcher.mjs';
import { json, readJSON } from '../http.mjs';
import { tokenKey, commitKey } from '../keys.mjs';
import { lastContainerExit } from './commit.mjs';

/**
 * Start a container for a participant and issue it a token.
 *
 * The token is the identity binding. It is minted here, handed to exactly one
 * container, and checked on every commit — so a participant can act as itself and
 * cannot act as anyone else, even though it holds the token in its own environment
 * and is free to read it.
 */
export async function start(ctx, request, workspaceName) {
  const body = await readJSON(request);
  const { participantId, participantCommand } = body;
  const workDir = body.workDir ?? '/workspace';
  const ledger = await ctx.getLedger();

  ledger.register({ participantId, kind: body.kind === 'human' ? 'human' : 'agent' });
  const token = crypto.randomUUID();
  await ctx.state.storage.put(tokenKey(participantId), token);
  await ctx.saveLedger();

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

  // Interception first. There must be no moment in which the container is running
  // and unmediated.
  await container.interceptAllOutboundHttp(ctx.env.GATE);
  container.start({
    entrypoint: ['/bin/sh', '-c', launcherScript({ participantCommand, workDir })],
    enableInternet: false,
    env: {
      INGRESS_WORKSPACE: workspaceName,
      INGRESS_PARTICIPANT: participantId,
      INGRESS_TOKEN: token,
      INGRESS_PARTICIPANT_COMMAND: participantCommand ?? 'true',
      INGRESS_WORK_DIR: workDir,
      INGRESS_MANIFEST_VERSION: String(MANIFEST_VERSION),
    },
  });

  await container.monitor();

  // `monitor()` has resolved, which means the container exited, which means any
  // commit it made has already been through the gate and decided. Surfacing that
  // verdict here is the difference between a participant that can react to a
  // refusal and one that has to go and ask.
  const verdict = (await ctx.state.storage.get(commitKey(participantId))) ?? null;

  return json(200, {
    participantId,
    started: true,
    participantExit: await lastContainerExit(ctx.state),
    commit: verdict,
  });
}