/**
 * The gate.
 *
 * Everything a participant does to make its work visible to anyone else goes
 * through here, and this is the only way that happens. The container starts with
 * `enableInternet: false`, so there is no route out of it except the interception
 * the Durable Object installs before boot — which lands on this WorkerEntrypoint.
 *
 * That topology is the entire enforcement argument:
 *
 *   a participant cannot publish a byte it did not send here
 *   it cannot reach any other workspace, because the only exit is this gate
 *   it cannot be someone else, because the token is issued by the workspace that
 *   owns this container and checked on arrival
 *
 * What this gate does *not* do is trust the sender's account of what it changed.
 * It forwards the actual bytes to the Durable Object, which hashes them and
 * admits or refuses. The gate's job is to be unavoidable, not to be clever.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';

const MAX_COMMIT_BODY = 12 * 1024 * 1024;

/** Headers the launcher sets. Anything else arriving here is refused. */
const WORKSPACE = 'x-ingress-workspace';
const PARTICIPANT = 'x-ingress-participant';
const TOKEN = 'x-ingress-token';

export class CommitGate extends WorkerEntrypoint {
  // `override` is TypeScript syntax and this file is plain JS, so the keyword
  // would not parse. The base class is extended at runtime all the same.
  async fetch(request) {
    const url = new URL(request.url);

    // Everything that is not a commit is refused. A participant has no business
    // reaching any other endpoint from inside, and discovering that cheaply is
    // better than discovering it later.
    if (url.pathname !== '/commit') {
      return new Response(
        JSON.stringify({ error: 'refused', reason: 'not_a_commit_route', path: url.pathname }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      );
    }
    if (request.method !== 'POST') {
      return new Response('method_not_allowed', { status: 405 });
    }

    const workspace = request.headers.get(WORKSPACE);
    const participantId = request.headers.get(PARTICIPANT);
    const token = request.headers.get(TOKEN);

    // Everything that reaches the gate is recorded, including the requests that
    // are about to be refused. A gate that silently drops things is
    // indistinguishable from a participant that never tried.
    await this.record({
      at: new Date().toISOString(),
      path: url.pathname,
      method: request.method,
      workspace,
      participantId,
      hasToken: Boolean(token),
      outcome: 'received',
    });

    // A commit with no claimed identity is refused here, before the workspace is
    // even resolved. Falling back to a default workspace would let a
    // misconfigured container write somewhere arbitrary.
    if (!workspace || !participantId || !token) {
      return json(400, {
        error: 'refused',
        reason: 'unidentified_commit',
        detail: `headers required: ${WORKSPACE}, ${PARTICIPANT}, ${TOKEN}`,
      });
    }

    let payload;
    try {
      const declared = Number(request.headers.get('content-length') ?? '0');
      if (declared > MAX_COMMIT_BODY) {
        return json(413, { error: 'refused', reason: 'commit_too_large', bytes: declared });
      }
      payload = await request.json();
    } catch {
      return json(400, { error: 'refused', reason: 'malformed_commit' });
    }

    // The participantId in the body is not trusted over the header. One of them
    // is a lie at best; making the header authoritative means a mismatch is
    // visible instead of silently resolved.
    if (payload?.participantId && payload.participantId !== participantId) {
      return json(409, {
        error: 'refused',
        reason: 'participant_mismatch',
        header: participantId,
        body: payload.participantId,
      });
    }

    const stub = this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspace));
    // The Durable Object checks the token against what it issued when it started
    // this container. The gate cannot: it has no memory of who it started.
    const response = await stub.fetch('https://workspace.internal/internal/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, participantId, token }),
    });

    // The refusal reason travels back to the participant verbatim. A 409 here is
    // the fence saying no with its evidence, and the participant needs the
    // evidence more than it needs the status code.
    await this.record({ workspace, participantId, outcome: 'forwarded', status: response.status });
    return new Response(response.body, {
      status: response.status,
      headers: { 'content-type': 'application/json', 'x-ingress-gate': 'commit' },
    });
  }

  /**
   * Append to the owning workspace's gate log, through the workspace itself.
   *
   * A Durable Object stub exposes no storage, so the log is written by calling the
   * workspace's own route. Best effort by design: a logging failure must never
   * become a commit failure, which is why this swallows its errors.
   */
  async record(entry) {
    try {
      const stub = this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(entry.workspace ?? '_gate'));
      await stub.fetch('https://workspace.internal/internal/gate-log', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entry),
      });
    } catch {
      // Swallowed on purpose, and noted in the comment above.
    }
  }
}

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}