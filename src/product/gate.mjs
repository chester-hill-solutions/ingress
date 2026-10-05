/**
 * The gate.
 *
 * Everything a participant does to make its work visible to anyone else goes
 * through here, and this is the only way that happens. The container starts with
 * `enableInternet: false`, so there is no route out of it except the interception
 * the Durable Object installs before boot — which lands on this WorkerEntrypoint.
 *
 * That topology is the enforcement argument, and it is about routing and attribution:
 *
 *   a participant cannot publish a byte it did not send here
 *   it cannot reach any other workspace, because the only exit is this gate
 *   it cannot be someone else, because the token is issued by the workspace that
 *   owns this container and checked on arrival
 *
 * The second of those was false until the public router refused `/internal/*`; an
 * authenticated caller could once post straight to `/internal/commit` and skip this
 * gate entirely. See `product/router.mjs`.
 *
 * What this gate does *not* do is trust the sender's account of what it changed.
 * It forwards the actual bytes to the Durable Object, which hashes them and
 * admits or refuses. The gate's job is to be unavoidable, not to be clever.
 *
 * What it also does not establish is that those bytes were ever written to the
 * container's filesystem. A participant that replaces the in-container reporter can
 * send any content at all; the workspace can prove the bytes hash to what was declared,
 * not where they came from. The claim above is about *how* content arrives, not about
 * whether the sender is telling the truth about what it did. See `launcher.mjs` for
 * that boundary, stated where the reporter is written.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { readJSON, MAX_COMMIT_BODY } from './http.mjs';

/** Headers the launcher sets. Anything else arriving here is refused. */
const WORKSPACE = 'x-ingress-workspace';
const PARTICIPANT = 'x-ingress-participant';
const TOKEN = 'x-ingress-token';

/**
 * What a container may ask the gate for.
 *
 * An allow-list rather than a deny-list, because the container has no internet and this
 * is its only exit: anything not named here is refused by default, so adding a route to
 * the Durable Object does not silently add one to the gate.
 *
 *   seed              a read, of the paths the caller holds a lease on
 *   commit            the only route in the product that admits bytes
 *   lease/heartbeat   renews the lease `/start` issued to this container
 *   lease/release     gives that lease up, so a finished participant frees the file at
 *                     once instead of at the expiry
 *
 * The two lease routes were added with `/start` handing the lease to the container
 * rather than to the calling harness. Neither admits a byte, and both re-check the
 * participant's token inside the Durable Object — see `handlers/leases.mjs`.
 */
const PERMITTED = new Map([
  ['/seed', { method: 'GET', forwards: '/internal/seed' }],
  ['/commit', { method: 'POST', forwards: '/internal/commit' }],
  ['/lease/heartbeat', { method: 'POST', forwards: '/internal/lease/heartbeat' }],
  ['/lease/release', { method: 'POST', forwards: '/internal/lease/release' }],
]);

export class CommitGate extends WorkerEntrypoint {
  // `override` is TypeScript syntax and this file is plain JS, so the keyword
  // would not parse. The base class is extended at runtime all the same.
  async fetch(request) {
    const url = new URL(request.url);

    // An allow-list, and the method with it. The container has no internet and this gate
    // is its only exit, so anything not listed is refused rather than left to chance.
    //
    // `/seed` is a read, added because a participant that cannot see the workspace
    // is working blind: it could commit changes built on nothing, and the fence
    // would be judging work against a tree it never received. It serves only the
    // paths the caller holds a lease on, so it is not a way around the lease layer.
    const permitted = PERMITTED.get(url.pathname);
    if (!permitted) {
      return new Response(
        JSON.stringify({ error: 'refused', reason: 'not_a_permitted_route', path: url.pathname }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      );
    }
    if (request.method !== permitted.method) {
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

    // A request with no claimed identity is refused here, before the workspace is
    // even resolved. Falling back to a default workspace would let a
    // misconfigured container read or write somewhere arbitrary.
    if (!workspace || !participantId || !token) {
      return json(400, {
        error: 'refused',
        reason: 'unidentified_request',
        detail: `headers required: ${WORKSPACE}, ${PARTICIPANT}, ${TOKEN}`,
      });
    }

    const stub = this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspace));

    if (url.pathname === '/seed') {
      // The Durable Object checks the token against what it issued when it started
      // this container, and serves only leased paths. The gate cannot verify
      // anything itself: it has no memory of who it started.
      const response = await stub.fetch('https://workspace.internal/internal/seed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ participantId, token }),
      });
      await this.record({ workspace, participantId, outcome: 'seeded', status: response.status });
      return new Response(response.body, {
        status: response.status,
        headers: { 'content-type': 'application/json', 'x-ingress-gate': 'seed' },
      });
    }

    let payload;
    try {
      // Enforced while reading the stream, not from the `content-length` header.
      //
      // The header is absent on a chunked request and the fallback was `0`, which
      // passes — so the limit was advisory for exactly the clients that did not
      // volunteer it. `readJSON` counts bytes as they arrive and stops.
      payload = await readJSON(request, MAX_COMMIT_BODY);
    } catch (error) {
      if (error?.message === 'body_bounds') {
        return json(413, { error: 'refused', reason: 'commit_too_large', limitBytes: MAX_COMMIT_BODY });
      }
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

    // The Durable Object checks the token against what it issued when it started
    // this container. The gate cannot: it has no memory of who it started.
    const response = await stub.fetch(`https://workspace.internal${permitted.forwards}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `participantId` and `token` are stamped from the headers over whatever the body
      // claimed. The check inside the object binds a token to a participant, so letting a
      // body override the header would make the gate the thing that decides who the
      // sender is — which is exactly what `participant_mismatch` above makes visible
      // rather than resolves silently.
      body: JSON.stringify({ ...payload, participantId, token }),
    });

    // The refusal reason travels back to the participant verbatim. A 409 here is
    // the fence saying no with its evidence, and the participant needs the
    // evidence more than it needs the status code.
    await this.record({
      workspace,
      participantId,
      outcome: 'forwarded',
      // `path`, not `route`: the log's schema is `{path, method, workspace,
      // participantId, outcome, status}` and a second key for the same idea is how a log
      // stops being queryable.
      path: url.pathname,
      status: response.status,
    });
    return new Response(response.body, {
      status: response.status,
      headers: { 'content-type': 'application/json', 'x-ingress-gate': url.pathname.slice(1) },
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