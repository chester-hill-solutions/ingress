# Snapshot spike: two agents, one tree, never the same bytes

**Date:** 2026-10-01. **Status:** both primitives confirmed against a deployed
Worker on a live account. Worker `ingress-snapshot-spike`, account
`6b149553c5075c79bbc132c481f387fe`. Every number below is observed output, not a
plan. Scope limits are listed explicitly at the end.

This exists because every coordination design in this repository failed at the
same point: it could observe an agent's activity but not stop it. That is why
file claims were unfalsifiable, and why `docs/realtime-multiplayer-plan.md` records
that the observer profile "cannot refuse native filesystem writes."

Two Cloudflare primitives are tested together. They are the first thing found
that addresses the actual problem rather than the reporting of it.

## The problem in one line

Git's unit is a commit, so the only way to work on the same code concurrently is
to be on different branches, and the only way to find out you collided is after
the fact. Filesystem claims, awareness context and inter-agent messages all try to
solve this by *telling agents about each other*. None of them can prevent a write.

## Primitive 1: snapshot isolation — WORKS

`snapshotContainer()` freezes a container's writable filesystem and returns an
opaque, immutable handle. `start({ containerSnapshot })` restores it into a
different container.

Measured, using two separate Durable Object instances so isolation is real
isolation rather than two names for one filesystem:

| Step | Result |
| --- | --- |
| Agent A writes `shared.txt` = `v1-from-A` | — |
| Agent A snapshots the tree | handle `033304db…`, **3,952 bytes** |
| Agent A then writes `shared.txt` = `v2-A-mutated`, adds `agent-a-only.txt` | — |
| Agent B restores from that handle | `shared.txt` = **`v1-from-A`** |
| Agent B lists the workspace | **`shared.txt` only** — no `agent-a-only.txt` |
| Agent B writes `shared.txt` = `v3-B-only` | — |

**`isolationWorks: true`.** Agent B saw the exact filesystem state at snapshot
time and had no visibility of anything Agent A did afterwards. The two agents then
diverged independently, each holding its own copy.

What this buys: **two agents hold the same tree at the same moment and never touch
the same bytes.** No negotiation, no awareness payload, no tokens spent telling
anyone anything. This is the part git structurally cannot do.

Snapshot handles are immutable with an implicit 30-day TTL that refreshes on
restore, which makes "this is the state you started from" a durable value rather
than something reconstructed after the fact.

## Primitive 2: egress chokepoint — WORKS

Container starts with `enableInternet: false`, so DNS never reaches a public
resolver. `interceptAllOutboundHttp()` routes all outbound HTTP through a
`WorkerEntrypoint`, which sees every request and chooses what happens next.

Measured, with the container itself reporting what it observed and the audit
trail read back independently from Durable Object storage so the evidence is not
the container's own account of itself:

| Request from inside the container | Gate response | Logged |
| --- | --- | --- |
| `GET http://repo.internal/read` | **200** `INTERCEPTED-OK` | method GET, 0 bytes, `refused: false` |
| `POST http://repo.internal/write` (15 bytes) | **409** `REFUSED: egress write not permitted by gate` | method POST, 15 bytes, `refused: true` |

`readRequests: 1, writeRequests: 1, writesRefused: 1`.

The container could not reach the write target by any other route: internet access
was disabled at start, and the only DNS answer for an intercepted hostname is a
placeholder that routes to the gate. The 409 is not advisory — the request did not
reach anything.

### The wiring error that cost the first attempt

`interceptAllOutboundHttp()` with a `WorkerEntrypoint` is the mechanism that makes
a write refusable. The first attempt passed a Durable Object instead:

```
Failed to execute 'interceptOutboundHttp' on 'Container':
parameter 2 is not of type 'Fetcher'.
```

The handler must extend `WorkerEntrypoint`. A second error followed from the same
misunderstanding: `WorkerEntrypoint.ctx` is an `ExecutionContext` and has no
`.storage`, so the audit trail was recorded through a separate Durable Object
reached by binding instead.

Corrected shape, which is the load-bearing code in this design:

```ts
export class EgressGate extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    await this.env.GATE.get(this.env.GATE.idFromName("global")).record({...});
    const isWrite = request.method !== "GET" && request.method !== "HEAD";
    return new Response(isWrite ? "REFUSED" : "INTERCEPTED-OK",
      { status: isWrite ? 409 : 200 });
  }
}
```

## Why the two together are the actual claim

Neither primitive alone is sufficient, and neither is the product.

| Primitive | Guarantee | Does not guarantee |
| --- | --- | --- |
| Snapshot isolation | Agents never share bytes; each works on its own copy of the tree | That an agent cannot reach *outside* its copy |
| Egress intercept | Every outbound request passes a Worker that can return 409 | That agents are working on the same tree |

Together they close the gap that made every earlier design unfalsifiable:

> An agent cannot write outside its own snapshot, because it was never given the
> bytes, and any egress attempt is refused by a Worker that can say no.

That converts a claim from a protocol agents are asked to follow into something
the platform enforces. An agent that ignores its claim cannot write anyway. This is
the first chokepoint in this repository's history that is not advisory.

## What this costs

**It crosses ADR 0014.** That ADR makes Ingress a storage-adjacent product with
caller-owned execution. Running agents in containers means supplying the execution
environment. The ADR's stated purpose is keeping Stow storage-only rather than
forbidding an environment, but that is a reading and not a decision, so it needs
explicit acceptance rather than silent adoption.

**Configuration requires a digest-pinned image.** The managed
`cloudflare/debian-trixie` identifier is passed at `container.start()` and is not
usable as a named `images` entry, which must be digest-pinned into
`registry.cloudflare.com`. This spike reused an existing image digest already in
the account registry, so no image build and no local Docker were required. A
production build would want its own image.

`snapshotContainer()` and the named-images path require
`scheduling_policy: "durable_object"`, which also rejects `max_instances` and
`instance_type` in the `containers` block.

## What is not yet established

- **Cost.** No measurement of container time, snapshot size at realistic repo
  scale, or how cost scales with agent count.
- **Durability across deploy.** A Durable Object restart loses `monitor()` and the
  in-memory `WorkerEntrypoint` binding, so any audit state must live in Durable
  Object storage. Not tested.
- **Whether a real agent harness runs in this container** at all, or whether the
  harness must be invoked through `exec()`.
- **Multi-agent contention at scale.** One snapshot pair was tested, not a roster.
- **Whether `git` inside the container can be pointed at Artifacts** to complete the
  loop from snapshot to pushed commit.

## Relation to everything refuted earlier

| Earlier idea | Why it failed | Relation to this |
| --- | --- | --- |
| Awareness context | ~139 tokens per co-located peer; advisory only | Unnecessary — agents need not be told, they are given separate trees |
| File claims in the tree | Push is ref-level, so disjoint claim paths contended identically; ~2,997 ms per reconcile | Unnecessary — there is no claim channel to contend on |
| Inter-agent conversation | 54% of notices discarded; deadlock and unbounded cost | Unnecessary — isolation removes the reason to talk |
| Verified claim ledger | 0 of 35 observations carried an actor; 8 actors shared one file | Superseded — the gate sees every write and attributes it by construction |

This does not resurrect any of them. It removes the problem they were addressing.