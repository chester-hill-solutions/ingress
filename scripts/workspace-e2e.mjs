/**
 * Retired. The scenario it ran now lives in `scripts/commit-e2e.mjs`.
 *
 * This script used two routes that no longer exist:
 *
 *   `WorkspaceClient.observe(...)` — deleted deliberately. It called `POST /observe`,
 *     which let any caller describe any write by any author, so the fence enforced the
 *     consistency of a ledger the caller controlled. See
 *     `src/product/workspace-client.mjs` and the `/internal/commit` replacement.
 *
 *   `client.write(...)` — the public `/write` route, which admits a write with no lease
 *     check. It is being removed; see `docs/product-hardening-plan.md` item 4.
 *
 * It was therefore already broken before the workspace credential was introduced: line
 * 59 threw a `TypeError` at module load. Adding a credential would not have made it
 * green, and patching the two calls would have rebuilt a second, weaker version of a
 * scenario `commit-e2e.mjs` already runs against real containers and the real gate.
 *
 * Kept as a file rather than deleted so the reason is findable from the name.
 *
 * To run the equivalent scenario:
 *
 *   export INGRESS_WORKSPACE_TOKEN=…
 *   node scripts/commit-e2e.mjs
 *
 * Every `/w/:workspace` route requires `x-ingress-workspace-token`, supplied from
 * `INGRESS_WORKSPACE_TOKEN`. Do not reuse `INGRESS_TOKEN` for it: that variable already
 * means the per-participant container token set in the container's environment
 * (`src/product/handlers/container.mjs`), and a collision would grant participant
 * identity as workspace identity.
 */

console.error('scripts/workspace-e2e.mjs is retired; it depended on routes that were removed.');
console.error('Run scripts/commit-e2e.mjs for the same scenario against real containers.');
process.exit(2);