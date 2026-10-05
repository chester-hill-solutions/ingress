/**
 * Who is this, and is it the container we started?
 *
 * The container token is the identity binding. It is minted by the workspace at
 * `POST /start`, handed to exactly one container, and checked on every request that
 * container makes. Everything a gate route does downstream is authorised by this check
 * and nothing else, so it lives in one file rather than in each handler — an earlier
 * arrangement had the commit path and the seed path each verify the token inline, and
 * the lease routes would have been a third copy.
 *
 * The claim this makes, stated plainly because it is the load-bearing one:
 *
 *   a participant cannot act as anyone else, because the token is bound to the
 *   participant it was minted for and is checked on arrival
 *
 * What it does *not* establish is that the caller is unmodified. The reporter inside the
 * container is a file the container's own root can rewrite, so a determined participant
 * can send anything it likes under its own identity. What it cannot do is send it under
 * anyone else's — see `launcher.mjs` for where that asymmetry is stated at the code that
 * crosses the boundary.
 *
 * Pure of I/O: it takes a `ctx` and returns a verdict, so both halves are testable
 * without a Durable Object.
 */

import { tokenKey, tokensMatch } from './keys.mjs';

/**
 * Check a container token against the one this workspace issued.
 *
 * @param {object} ctx
 * @param {string} participantId claimed participant, which must match the token's
 * @param {string} token claimed token
 * @returns {Promise<{ok: true} | {ok: false, reason: 'no_token_issued' | 'token_mismatch',
 *                            participantId: string|null}>}
 */
export async function authenticateContainer(ctx, participantId, token) {
  const expected = await ctx.state.storage.get(tokenKey(participantId));

  // Two refusals, not one. A participant that was told `token_mismatch` cannot tell
  // whether its token is stale or another participant's, and the two demand different
  // responses — one is a bug, the other is an attack.
  if (!expected || !(await tokensMatch(expected, token))) {
    return {
      ok: false,
      reason: expected ? 'token_mismatch' : 'no_token_issued',
      participantId: participantId ?? null,
    };
  }
  return { ok: true };
}

/**
 * The body for a refused identity.
 *
 * Lives here because three routes refuse the same way and a fourth one written by hand
 * would be the one that drops `participantId`. `extra` carries the caller's own shape —
 * the commit route adds `admitted: false`, the lease routes do not.
 */
export function containerRefusal(identity, extra = {}) {
  return {
    error: 'refused',
    reason: identity.reason,
    participantId: identity.participantId,
    ...extra,
  };
}