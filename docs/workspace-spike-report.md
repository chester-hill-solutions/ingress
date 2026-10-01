# Workspace spike: does an isolated container survive its own death?

**Date:** 2026-10-01. **Status:** confirmed. Filesystem and git history both survive
container death, and R2 holds an independent copy. Worker
`ingress-workspace-spike`, account `6b149553c5075c79bbc132c481f387fe`, R2 bucket
`ingress-workspace-probe`.

## Seed, measured

Agent A wrote `src/marker.js` and `NOTES.md`, committed, and froze the tree:

```
stamp                    : seeded-by-agent-1790894263045
snapshotId               : ce0b1e6e-8ce7-407c-9cb0-74f7d42722cf
snapshotSizeBytes        : 50,529
postSnapshotFileCreated  : true   (POST_SNAPSHOT.txt, written after the handle)
```

50,529 bytes for a git repository holding one commit and two files. That is the
floor for snapshot cost, not a realistic figure: the number that matters is how it
scales with repository size, which is unmeasured.

## A container assumption that did not carry over

The first seed attempt failed with:

```
Author identity unknown
fatal: unable to auto-detect email address
```

A fresh container has no git identity. That was configured in the loop spike and
forgotten here, so the commit failed before any snapshot was taken. It is the fifth
time this session that a fact learned about one container did not transfer to the
next, which is direct evidence that these containers are genuinely stateless and
that nothing should be assumed to persist between them.

Reported honestly because the first diagnosis was wrong: the response was
suspected to contain unescaped control characters breaking JSON. It did not.
`Response.json` had serialised the newlines correctly, and the actual fault was
one layer down in the command. Checking the raw bytes rather than trusting the
parse error is what separated the two.

The fix sets `user.email`, `user.name` and `init.defaultBranch` before committing,
and reports a failure there as its own `git-identity` stage so a configuration
problem cannot be mistaken for a snapshot problem.

This targets the two failures that made the earlier spikes mechanisms rather than
a product:

| Measured | Meaning |
| --- | --- |
| `FILES-LOST` | A container restart discards the filesystem, so an agent that recycles loses its work |
| `INSTALL-FAILED` | Nothing can be added at runtime, because egress is sealed |

## The two primitives being combined

`snapshotContainer()` returns an immutable handle to a container's writable
filesystem. `start({ containerSnapshot })` restores that handle into a different
container. R2 is object storage the Worker reads and writes directly, without the
container being involved at all.

The distinction the test has to make is between a **restore point** and **a copy
that happens to be nearby**. A file still being present proves nothing about
whether the snapshot froze a moment in time. So the sequence deliberately writes
a file *after* the snapshot:

```
agentA:  write src/marker.js (unique stamp)
         write NOTES.md
         git init + commit
         snapshotContainer()          <- handle
         write POST_SNAPSHOT.txt      <- must NOT appear in any restore

agentB:  destroy() its own container
         start({ containerSnapshot: handle })
         must see marker.js, NOTES.md, git history
         must NOT see POST_SNAPSHOT.txt
```

If `POST_SNAPSHOT.txt` is visible, the handle is not a restore point and nothing
downstream can rely on it.

## Why R2 is measured separately

The snapshot lives inside the container platform. R2 does not. So a marker written
to R2 and read back through the Worker is an independent copy, not the same
filesystem reachable by two paths.

That distinction matters for the failure this is meant to fix. If the only copy is
the snapshot handle, then losing it loses everything. Two independent mechanisms
means one can fail.

## Restore, measured

Agent B destroyed its own container, then restored from the handle:

```
restoredFrom          : ce0b1e6e-8ce7-407c-9cb0-74f7d42722cf
markerSeen            : export const marker = "seeded-by-agent-1790894263045";
notesSeen             : agent wrote this before the snapshot
gitHistoryRestored    : 674ed3b seed
sawPostSnapshotChange : false
filesystemRestored    : true
r2RoundTrip           : true
```

`sawPostSnapshotChange: false` is the result that matters. Agent B could not see
`POST_SNAPSHOT.txt`, which agent A wrote after the handle was taken. That
distinguishes a restore point from a copy that happens to be nearby, and without
it nothing downstream can rely on the handle.

The git history came back with the working tree, so this restores a repository
state rather than loose files. That is the difference from copying a directory,
and it is what makes resumption possible rather than merely convenient.

R2, read through the Worker with no container involved:

```
keys       : ["workspace/agentB-restored/marker.js"]
sampleValue: export const marker = "seeded-by-agent-1790894263045";
```

Two mechanisms with separate failure modes. The snapshot lives in the container
platform; R2 does not. If the handle is lost, the object storage copy is still
there, and it was verified by a client that never had access to the container.

## A second serialisation boundary mistake

The R2 listing endpoint first returned:

```
Could not serialize object of type "GetResult". This type does not support serialization.
```

An `R2ObjectBody` cannot cross the Durable Object RPC boundary. The fix reads
`.text()` out of it before returning.

This is the second such error in one session, after a `Fetcher` cast that needed
handling. The pattern is worth recording: **a Durable Object method is a
serialisation boundary and the type checker does not enforce it.** Anything
returned across it must already be plain data. Both failures surfaced as `500`
with a runtime message, which is exactly the shape of bug that gets misdiagnosed
as something else — as happened with the git-identity failure above.

## Cost, one data point

50,529 bytes to snapshot a git repository holding one commit and two files. That
is a floor, not a figure. What matters is how it scales with repository size, and
that is unmeasured. Snapshot handles carry an implicit 30-day TTL that refreshes
on restore, which bounds staleness but is not a retention policy.

## What this establishes

An agent's work survives the death of the container that produced it, and a
different host resumes from exactly where it stopped, including git history rather
than loose files.

That is cross-host resumption, and it is the one capability in this line of work
that neither git nor a local filesystem provides. Git can restore a commit but not
a working tree at a moment in time, which is what an interrupted agent actually
leaves behind.

## What a pass would not establish

- **That a harness can run.** `npm install` still fails at runtime and no harness
  is installed. That gap is structural and would need a baked image, and it is
  unaffected by anything measured here.
- **Cost.** Snapshot size and container time are unmeasured at any realistic
  repository scale.
- **Concurrency.** Two instances are exercised, not a roster.
- **Durability across deploy.** A Durable Object restart during this sequence is
  untested.
- **That this is the right product.** Everything here is about making an
  execution environment work. Whether that is the thing worth submitting is a
  separate question that no measurement answers.