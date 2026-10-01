# Loop spike: can an isolated container land real work in a real repository?

**Date:** 2026-10-01. **Status:** loop closed on the fifth attempt. Four earlier
attempts failed on wiring errors of mine, each recorded below. Worker
`ingress-loop-spike`, account `6b149553c5075c79bbc132c481f387fe`, repository
`loop/agent-work`.

This is the load-bearing test behind [ADR 0018](../../stow/docs/adr/0018-snapshot-isolation-enforced-egress.md).
The [snapshot spike](snapshot-spike-report.md) proved isolation and a refusable
egress gate. Neither is worth anything unless an agent in that container can do
real work against a real repository. If it cannot, the approach is a demo.

## First attempt: failed

The container had everything it needed and still could not push:

| Probe | Result |
| --- | --- |
| `git` | 2.39.5 |
| `node` | v22.23.2 |
| Public internet | correctly **blocked** |
| Work written and committed | `96452db33482` — `src/landed.js`, `REPORT.md` |
| Push | **exit 128** |
| `fatal: unable to access '...': Could not resolve host: 6b1495...artifacts.cloudflare.net` | |
| Credential left in container | none |
| Commits visible in Artifacts | **0** |
| Egress gate requests observed | **0** |

The work was real and the commit was made. The push could not resolve a hostname.

## Cause of attempt 1: the gate was never registered

`enableInternet: false` means no hostname resolves until an intercept covers it.
The `EgressGate` class existed and was correct, but nothing called
`interceptOutboundHttps()`. With no intercept registered, DNS resolved nothing,
the container was sealed, and the gate observed zero requests because no traffic
ever reached it.

This is the second time in this spike series that a handler was written but not
wired. The first was passing a Durable Object where a `WorkerEntrypoint` was
required. Both failures looked identical from the outside — an API rejecting a
call — and neither would have been visible without running the thing.

The zero in `gate requests observed: 0` is the part worth keeping. A gate that
reports zero traffic because nothing ever arrived is indistinguishable from a gate
that observed traffic and permitted it, unless the record distinguishes them. Here
it did: the push had a non-zero exit and no commit landed, so zero meant sealed,
not clean. That is the `unresolvable input is an error, not a zero` property
applied to itself.

## Attempt 2: the network path worked, the credential was missing

After registering the gate, the container resolved the Artifacts host and
completed TLS. The gate observed real traffic:

```
caBundlePresent          : yes      (was no — the CA is only injected when an
                                    HTTPS intercept is active)
gate entries             : 1
GET /git/loop/agent-work.git/info/refs -> allowed
```

So DNS, TLS and the intercept all work. The push then failed at authentication:

```
fatal: could not read Username for 'https://...': No such device or address
```

Git connected, then asked for credentials, and had none to give.

The cause was mine and specific: when token minting was removed from the gate,
the `token` field was also deleted from `commitAndPush`'s signature, leaving a
comment asserting the container held no credential. The caller still minted a
600-second repo-scoped token and still sent it in the request body, so the token
was transmitted and silently ignored.

The type checker caught it on the next compile — `Property 'token' is missing` —
but the deploy had already completed, because Wrangler does not typecheck before
uploading. The fix is the signature and call site; the lesson is that the
signature change was invisible at the moment it was made.

### A measurement that was wrong rather than broken

The first probe reported `publicInternetBlocked: REACHABLE`, which reads as the
container having open internet and contradicts the design.

It did not. A `*` intercept makes every hostname resolve to the gate, so a raw TCP
connect to `1.1.1.1:443` succeeds *against the gate* and never reaches the
internet. The probe could not distinguish those two cases and so reported the
wrong thing.

It now asks the gate directly: fetch a host the gate does not permit, and require a
403. That measures the chokepoint instead of inferring it from a socket. An
inferred security property that is wrong in the permissive direction is worse than
one that is absent.

## Correction

`boot()` now registers the gate before any work runs, and the CA that HTTPS
interception requires is checked explicitly rather than assumed:

```ts
if (!(await this.ctx.storage.get("gateInstalled"))) {
  const gate = this.ctx.exports.EgressGate({ props: {} });
  await c.interceptOutboundHttps("*", gate);
  await this.ctx.storage.put("gateInstalled", true);
}
```

The ephemeral CA at `/etc/cloudflare/certs/cloudflare-containers-ca.crt` is
injected only when HTTPS interception is active **and** a handler is registered.
Because the handler was missing, `caBundlePresent` was `no` on the first run. That
was a symptom, not a separate fault.

## Result: loop closed

Fifth attempt, after the fourth wiring fix. Verified out-of-band with the CLI,
from outside the container:

```
push exited                : 0
commit                     : 46374db90d72790bdbf86c689c2f961137a1567f
git output                 : * [new branch]  HEAD -> main
verified outside container : true
src/landed.js round-tripped: true
credential in container    : none
gate observed              : 3 entries, 3 allowed, 1 write forwarded
```

The gate log shows the whole git conversation, not just the push:

```
GET  /git/loop/agent-work.git/info/refs        allowed
GET  /git/loop/agent-work.git/info/refs        allowed
POST /git/loop/agent-work.git/git-receive-pack allowed  (write: true)
```

Reading the commit and the file back from Artifacts with `cf`, from a different
client with no relationship to the container:

```
46374db90d72  Agent lands work from an isolated container
              author=Ingress Agent <agent@ingress.local>

export const landedAt = "2026-10-01T22:17:46Z";
export const by = "agent-in-isolated-container";
```

So the full chain holds: an agent in a container with no public internet wrote
real files, committed, pushed through an interceptable gate, and the bytes are in
a repository that a different client can read.

## A false claim inside the artifact, corrected here

The first version of `REPORT.md` — which is committed and readable in Artifacts —
says:

> This commit was produced inside a container that never held a repository credential.

**That is false.** The container held a 600-second, repo-scoped write token for the
duration of the push, passed as an `http.extraHeader`. An earlier draft had the
gate mint tokens and the container hold none; that version was abandoned and the
text was not corrected when the implementation changed.

`credentialInContainer: none` in the probe output refers to a post-push grep for
`art_v2` under `/workspace` and `/root`, which confirms the token was not written
to disk. It does **not** mean the container never held the credential, and the two
must not be conflated. The probe's field name invites exactly that confusion and
should be renamed before this measurement is cited again.

This is recorded rather than quietly amended in place, because a false claim inside
a committed artifact is precisely the failure mode this repository's gate rules
exist to catch, and it should stay visible as an example.

## Scope note

The gate observes and can refuse, but it does not mint credentials. Token
provisioning stays in the CLI for this spike, so the container holds a
600-second, repo-scoped write token for the duration of one push.

The stronger version — gate mints the token per request so the agent never holds
a credential — was attempted and abandoned. `cf accounts tokens create` requires a
permission-group UUID, and the OAuth scope in use cannot list permission groups to
discover the correct one. Rather than guess an identifier, credential injection is
left untested and recorded as a gap. It is not claimed anywhere.

## What a pass would and would not establish

A pass would establish that the loop closes: an agent inside a snapshot-isolated
container, holding no public internet access, writes real files, commits, pushes
through an interceptable gate, and the commit is readable from Artifacts by a
different client entirely.

It would **not** establish cost, durability across deployment, contention at
roster scale, or that a production agent harness runs this way rather than only
git. Those remain open.