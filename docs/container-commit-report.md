# Container-mediated commits: the fence no longer trusts the participant

**Date:** 2026-10-03. **Status:** deployed and verified on a live Durable Object
with live Containers. Supersedes the self-reported `/observe` path documented in
`workspace-fence.md`.

## The gap this closes

`workspace-fence.md` deployed a fence and admitted its own weakness: the fence
checked the arithmetic of a ledger that the caller supplied. Reads were
self-reported, writes were self-reported, and `POST /observe` let any caller
describe any write by any author. It enforced *consistency of a ledger that
callers controlled*.

An agent does not go through an interface. It uses native tools and writes
directly to a filesystem. So the fence has to live where the bytes are decided.

## What was measured first

Before building, two things were checked on the live account rather than assumed.

**1. Snapshot isolation is gone.** `docs/snapshot-spike-report.md` recorded
`isolationWorks: true` on 2026-10-01. It does not reproduce today. Measured:

| Instance type | `snapshotContainer()` |
| --- | --- |
| `basic` | `Snapshots are not available because this container does not support the requested snapshot operation.` |
| `standard-1` | same |
| `standard-2` | same |
| `standard-3` | same |

Not a timing artefact: the probe waited for the gate to receive the container's
first outbound request — proving the container was live — and only then
attempted the snapshot, twice. `snapshotDirectory` is declared in the type
definitions but is not a function on the runtime object. **The isolation
primitive this design was going to be built on is not available.** Recorded
plainly because the earlier report says the opposite and someone will read it.

**2. The gate works.** Every outbound request from inside a container reaches a
`WorkerEntrypoint` the Durable Object installs before boot. Measured from
`probe-container/`, Debian 12, root, with `node`, `curl`, `sha256sum`, `git`.

## The design that replaced it

The container starts with `enableInternet: false`. Its only exit is the
interception the Durable Object installs, which lands on `CommitGate`. So:

```
container runs participant
  -> workspace-supplied launcher hashes the tree AFTER the participant exits
  -> POST to workspace.internal/commit, intercepted by CommitGate
  -> gate forwards to the workspace's Durable Object with a token
  -> DO verifies hashes, asks the fence, admits or refuses
  -> 200 with receipts, or 409 with evidence
```

Three properties, each of which was the reason for a specific design choice:

**Bytes are hashed on arrival, not accepted on assertion.** A commit carries
`path` + `content`; the DO computes sha256 over what actually arrived and refuses
on mismatch. A participant cannot forge a file's content.

**The manifest is produced by the workspace, not the participant.** The launcher
is workspace code that runs the participant as a child and only then walks the
tree. The participant does not get to describe its own changes.

**Identity is a token the workspace issued.** Minted at `/start`, handed to one
container, checked on every commit. A participant can act as itself; it cannot act
as anyone else.

### The forgery/omission asymmetry

A participant can lie in exactly one direction: it can **omit** a file. It cannot
forge one, because content is hashed on arrival.

```
forgery  -> blocked by hashing the received bytes
omission -> costs the participant its own work
```

Omission is denial, not corruption. An omitted change is never admitted, so it is
lost work, never a bad state. That asymmetry is what lets this design work
without snapshot isolation.

## Observed result

Three participants, three real containers, real commands, real bytes:

```
--- 2. participant A commits from inside a container
admitted: true | landed: [{"path":"from-a.txt","revision":1,"contentHash":"cf958d9b…"}]
files now: engine.mjs@r1 by creator, from-a.txt@r1 by A

--- 3. participant C reads engine.mjs at revision 1
C's view of engine.mjs: revision 1 | stale: false

--- 4. participant B rewrites engine.mjs from inside a container
admitted: true | landed: [{"path":"engine.mjs","revision":2,"contentHash":"c05b51c0…"}]
files now: engine.mjs@r2 by B, from-a.txt@r1 by A

--- 5. participant C commits from a stale read
admitted: false
reason:   dependency_moved
refusals: [{ "path": "from-c.txt", "reason": "dependency_moved",
             "staleDependencies": [{ "path": "engine.mjs", "readRevision": 1,
                                     "currentRevision": 2, "author": "B" }] }]
files now: engine.mjs@r2 by B, from-a.txt@r1 by A
C's file landed? NO (fence held)

--- 6. C re-reads and commits again
admitted: true
landed:  [{"path":"from-c.txt","revision":1,"contentHash":"df5e08f9…"}]

receipts
C: [{"reason":"dependency_moved","paths":["from-c.txt"],"exit":0},
    {"reason":"commit_admitted","paths":["from-c.txt"]}]

VERDICT: THE FENCE HELD ON CLOUDFLARE
```

C's bytes were produced, hashed, and **refused**, with the dependency and its
author attached. Nothing partial landed. Re-read, and the same work was admitted.
The refusal is retained next to the admission.

## Honest limits

- **A participant can modify the launcher.** It is root in its own container and
  the launcher is on the same filesystem. Snapshot isolation would close this and
  is unavailable. A casual defector is caught; a determined one is not. This is
  the real cost of losing the isolation primitive. It also means the workspace
  can prove stored content hashes to what was declared, but not that the bytes
  were ever written to the container's filesystem — a replaced reporter can send
  content that was never on disk.
- **Omission is undetectable.** A hidden change is invisible to the workspace.
  It is safe rather than corrupting, but it is invisible.
- **Reads were self-reported; now they are not.** This used to read: the fence
  knew a participant *declared* it read `engine.mjs`. `/read` is gone. A read is
  recorded by `handlers/leases.mjs` when a lease grant hands the content over,
  so the workspace is the party establishing it. What remains true is narrower:
  the workspace cannot verify a participant *understood* the content it was
  handed. Snapshot isolation would not have fixed that either.
- **Auth on the public surface, since fixed.** `/join`, `/read`, `/start` and
  `/bootstrap` were open; every `/w/:workspace` route now requires
  `x-ingress-workspace-token`, and `/start` is bounded on length, runtime and
  concurrency. See [product-hardening-plan](product-hardening-plan.md) items 1
  and 3. Two limits remain: holding that token means holding the right to run
  code on the account holder's machine, and the workspace name is still the only
  thing separating two tenants.
- **Two write decisions exist and only one runs.** `evaluateCommit` decides in
  production; `WorkspaceLedger.admit` reimplements the same rules with no
  production caller, and carries the larger share of the tests. Reconciling them
  is not done.
- **`/bootstrap` is authorship, not a loophole.** It may only run on an empty
  ledger; a second call is refused. Asserted by test.
- **The launcher is a string, not a file to upload.** A Worker cannot write into
  a container, so it is inlined via heredoc. Not directly unit-testable; what is
  tested is the manifest contract both sides parse.

## Bugs found, all by measurement

Five real defects, none of which any test would have caught:

1. **Pooled-Buffer hashing.** `Buffer.prototype.slice` is deprecated and returns a
   *view*, so hashing `buf.buffer` digested Node's 8 KiB allocation pool. Every
   short file hashed identically and honest commits were rejected as forged.
2. **`baseRevision` silently discarded.** `verifyCommit` rebuilt each file entry
   without carrying the field, so the base-revision check could never fire and an
   honest participant got a *weaker* fence than one that declared nothing.
3. **Path traversal broke atomicity.** Paths were validated inside `recordWrite`,
   so a bad path passed evaluation and threw mid-`apply` — exactly the half-applied
   commit the two-phase design exists to prevent.
4. **Read-only container root.** The launcher wrote its reporter to `/`, which is
   read-only. The participant ran and its work was never reported — a silent,
   total loss that looked exactly like a participant that did nothing.
5. **`manifestVersion` string/number.** The version crosses a process boundary as
   an environment variable, so it arrived as `"1"` and was compared to `1`. Every
   commit was refused with 422 while in-process tests passed.

(4) and (5) were both found by reading live output, not by tests.

## Verification

**371 tests, 0 failures** on Node 26. `npm run check` clean.

Every mutation checked against the test meant to catch it:

| Mutation | Result |
| --- | --- |
| Staleness check removed from the fence | 4 tests fail |
| `readBasis` 'unknown' reported as 'verified' | the unknown-read refusal fails |
| DO admits unconditionally | 7 tests fail |
| DO stops persisting state | the eviction test fails |
| `verifyCommit` drops `baseRevision` again | the stale-base refusal fails |
| Path validation removed from `evaluateCommit` | 2 atomicity tests fail |
| Hash mismatch no longer fails closed | the forgery test fails |
| Refusals no longer receipted | the refusal-receipt test fails |
| Token check removed from `/internal/commit` | 3 identity tests fail |
| Manifest version coercion removed | the string-version test fails |

Two mutations of the original fence — the pooled-buffer hash and the dropped
`baseRevision` — are the ones worth remembering. Both were the same failure mode:
**an input silently discarded on the way through, so the check it fed could never
fire.** Neither threw. Both made the product weaker while every test stayed green.

## Reproduce

```bash
export CLOUDFLARE_ACCOUNT_ID=…
(cd product && wrangler deploy)
node scripts/commit-e2e.mjs
```

Exits non-zero unless the fence held.