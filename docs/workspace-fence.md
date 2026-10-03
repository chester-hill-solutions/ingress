# The workspace fence: a git replacement for people and agents

**Date:** 2026-10-03. **Status:** deployed and verified on a live Durable Object.
No RT status advances. This is RT-2 territory, and this document records what
was actually built and observed.

## The gap

Git models artifacts, never intent. When two changes collide, git says CONFLICT
and stops. It cannot say *why*, or whether the other side touched what you were
doing or something adjacent. Every multi-agent chokepoint follows from that one
omission: the only way to avoid a merge conflict in git is to not touch the same
file, and nobody can know that in advance.

## What is deployed

`ingress-workspace`, account `6b149553c5075c79bbc132c481f387fe`:

```
https://ingress-workspace.narfin.workers.dev/health
https://ingress-workspace.narfin.workers.dev/w/<workspace>/...
```

A Worker routing to one Durable Object per workspace name. The DO holds the
ledger; it is the serialization point that makes the fence enforceable.

| File | Role |
| --- | --- |
| `src/product/fence.mjs` | The decision. Pure: no I/O, no Cloudflare, no agents. |
| `src/product/workspace-agent.mjs` | The Durable Object. Holds the ledger, serves HTTP. |
| `src/product/workspace-client.mjs` | The participant. Transport-agnostic. |
| `src/worker.js` | Entry point: `/health` and `/w/:name/*`. |
| `scripts/workspace-e2e.mjs` | Runs the real scenario against the deployed Worker. |

## The observed result

```
agent sees participants: integrator:human
agent sees human intent:   rewriting the engine while the builder works on the UI
agent read engine.mjs at revision 1
human wrote engine.mjs revision 2

--- the fence ---
admitted: false
reason:   dependency_moved
evidence: [{"path":"engine.mjs","readRevision":1,"currentRevision":2,"author":"integrator"}]
fingerprint: b6dbafd1/builder/agent@engine.mjs:1>2

after re-read, admitted: true
receipts retained for builder: 2
files in workspace: engine.mjs@r2, ui.mjs@r1

latecomer sees: builder, integrator
latecomer blind write admitted: false | reason: dependency_read_unknown

VERDICT: FENCE WORKS ON CLOUDFLARE
```

That is a stale write **refused** by a deployed Durable Object, and the same
write **admitted** after the participant re-read. Not reported afterwards —
prevented.

## Why a Durable Object and not something else

The whole design turns on one property: a DO is single-threaded per instance, so
the check and the decision happen in one turn of the isolate. There is no window
between "is this participant's understanding current?" and "may this write
proceed?" for a competing write to slip through.

The state survives eviction. `WorkspaceAgent` rebuilds its ledger from
`state.storage` on a cold instance, and there is a test that mounts a fresh
instance over the same storage and asserts the fence still refuses — because a
fence that resets on eviction is a fence with a silent gap in it.

## Why not MCP

Measured, not assumed. `scripts/` and the probe in this repo's history ran a real
agent against a real MCP server and asked it to read and write a file:

```
native tool events: 16   (glob, grep, read ×2)
mcp tool calls:     0
```

The agent read `TASK.md`, never read the target file, and never called MCP. It
used native tools and finished with nothing written. So a workspace served over
MCP or HTTP would be *bypassed*, not mediated — the substrate would watch
nothing.

That is why the fence lives where the bytes are decided, not behind an interface
an agent is free to route around.

## Why a human counts

`kind: 'human'` and `kind: 'agent'` are the same participant type with a label.
A human's edit invalidates an agent's dependency exactly as another agent's
would; the test `two humans in one workspace are fenced against each other too`
asserts it. A person in Neovim and an agent in any harness occupy the same
workspace, and neither one gets a special exemption.

## Honest limits

- **The ledger only knows what it is told.** Bytes are reported through
  `/observe`. A write the workspace never learns about is invisible to it. In a
  full deployment this needs to come from a container snapshot diff, which is
  not wired here.
- **Attribution is often unknown.** A write with no `actorId` is recorded as
  `unknown`, and a refusal against it says so. It is never guessed.
- **`readBasis: 'unknown'` is refused, not assumed safe.** A participant that
  declared a dependency and never read it cannot write against it. This is
  strict, and it will refuse work that happens to be fine. That is the correct
  direction to fail.
- **The fingerprint is a canonical string, not a hash.** `admit` must be one
  synchronous decision in one turn of the isolate, so it cannot await. This was a
  deliberate choice, documented at the function.
- **No authentication.** The deployed Worker has none. It is a proof of
  mechanism, not something to expose.
- **This is not a git replacement yet.** It is the layer git does not have:
  refusing a write whose basis has been invalidated, with the evidence attached.
  There is no clone, no history, no merge. Artifacts holds files; the DO holds
  intent; nothing connects them yet.

## Verification

24 tests across `test/product-fence.test.mjs` and `test/product-workspace.test.mjs`.
Full suite **329 passing, 0 failing** on Node 26.

Every mutation was checked to fail the test meant to catch it:

| Mutation | Result |
| --- | --- |
| Staleness check removed from the fence | 4 tests fail |
| `readBasis` 'unknown' reported as 'verified' | the unknown-read refusal fails |
| DO admits unconditionally | 7 tests fail |
| DO stops persisting state | the eviction test fails |

One defect was found by reading the live output rather than the tests: the
refusal `fingerprint` was a full dump of the evidence cut instead of a compact
canonical form. The local tests passed because they only asserted the
fingerprint was a non-empty string. Fixed, redeployed, re-verified above.

## Not done

- Container snapshot diff as the write source (`/observe` is manual today).
- Durable object storage as the byte substrate, connected to Artifacts.
- Auth, and a rate limit on `/write`.
- A human-facing client. The protocol is simple enough to script from `curl`.