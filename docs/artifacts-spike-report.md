# Artifacts spike report

**Date:** 2026-10-01. **Status:** step 1 of the [platform plan](cloudflare-platform-plan.md)
executed against a live account. Everything below was observed, not read from
documentation.

No RT status advances. This records substrate feasibility only.

## Account and plan

Artifacts requires Workers Paid. Of the two accounts reachable by OAuth:

| Account | ID | Workers Paid |
| --- | --- | --- |
| Chester Hill Solutions | `ad5ec479b9a421faa2ed06c3d1c2b23a` | none — R2 Paid only |
| Narfin@chsolutions.ca's Account | `6b149553c5075c79bbc132c481f387fe` | **yes**, $5/mo |

Every probe below ran against the second account. The Chester Hill Solutions
account cannot host this work without buying Workers Paid, which is a scheduling
fact worth stating plainly rather than discovering on the deadline.

## Tooling

`cf` v1.0.0-beta.10 (npm `cf`, the unified Cloudflare CLI) covers the whole
Artifacts control plane and prints JSON. It was installed with `bun add -g cf`
and authenticated by OAuth. Two further discoveries:

- **Two accounts force an explicit choice.** With more than one account,
  `cf` refuses to guess in non-interactive mode. `CLOUDFLARE_ACCOUNT_ID` must be
  exported; `--account-id` is not accepted on these commands.
- **`cf` has genuine bugs in this release.** These are recorded so the next
  agent does not lose time re-finding them.

| Defect | Workaround |
| --- | --- |
| `cf accounts subscriptions get` rejects its own schema path params (`--account-or-zone`, `--account-or-zone-id`) | Rely on `CLOUDFLARE_ACCOUNT_ID` |
| `cf queues subscriptions create --source-type` enum omits `artifacts` and `artifacts.repo` | Pass `--body` to bypass client-side validation |
| `events` rejects objects; wants bare strings | `--body '{"events":["pushed"]}'` |
| `cf artifacts namespaces repos fork` cannot be given a target name, and its derived name fails the repo name regex | Only the Workers binding's `repo.fork(name)` can name a fork |
| Positional/flag inconsistency: `repos create` takes namespace positionally; `repos get` and `logs get` take `--namespace` as a flag with name positional; `repos list` takes only the flag | Read each `--help`; the shape is not uniform |

## What works

Confirmed end to end, in this order: create namespace (`spike`, jurisdiction
`unrestricted`) → create repo (`ingress-probe`) → mint repo-scoped write token →
`git push` over HTTPS → observe `cf.artifacts.repo.pushed` in a Queue → read the
pushed state back.

The full read surface is present: `repos get`, `logs get`, `commits get`,
`raw get`, `files get`, `trees get`. Details that cost time and are worth keeping:

- Tokens are prefixed **`art_v2_x_`**, not the `art_v1_` shown in the docs.
- `repos get` does **not** return the token. Mint with `tokens create`; the
  plaintext is shown once and is not retrievable afterwards.
- `commits get` returns **`treeHash`**, not `tree`.
- **SHA-1s must be the full 40 characters.** Abbreviated SHAs fail with
  `[10100] Invalid SHA-1 hash`, including on `commits get`.
- Write auth works via `git -c http.extraHeader="Authorization: Bearer $TOKEN"`,
  which keeps the token out of `.git/config` and shell history.

## Measured: event delivery latency

The plan's step 3 failure mode was "event lag exceeds agent turn latency;
observation is useless in time." Three runs, single-file commits:

| Run | Push wall | Push → event enqueued | Queue polls to find it |
| --- | --- | --- | --- |
| 1 | 2019 ms | **277 ms** | 1 |
| 2 | 798 ms | **252 ms** | 1 |
| 3 | 742 ms | **162 ms** | 1 |

Delivery is 162–277 ms from push completion, and the message was present on the
first poll every time. That is comfortably inside a single agent turn, so the
failure mode is **refuted** for this account, this region, and commits of this
size. It is not a general claim about Artifacts.

## Measured: no server-side diff

The `pushed` payload contains exactly these keys:

```
after, before, commits, commitsTruncated, ref, totalCommitsCount
```

There is **no changed-file list**. Learning which paths changed requires walking
both trees from the event's `before`/`after` SHAs. That was implemented and
checked against local git for every adjacent commit pair in the repo:

```
pairs_checked : 7
agreements    : 7
failures      : 0
verdict       : PASS
```

covering the root commit (added), modifications, a nested add at depth 3
(`src/deep/nested/probe.js`), and a commit that both added and modified files.
The recursive walk and local `git diff --name-status` agreed on every pair.

An earlier version of that harness reported a failure on the root commit, but the
fault was in the harness — it skipped the ground-truth call instead of comparing
against git's empty tree. It was corrected rather than waived; the first pair is
now a real assertion.

The cost this implies is real: tree-walking is O(files) reads per push unless the
observer caches tree state between events. That is a design cost, not a blocker.

## Measured: concurrent push is rejected, and the client is told

Two clones each committed to the same branch and pushed. Result:

```
outcome                    : rejected_notified
agent_a_rc                 : 0
agent_b_rc                 : 1
client told about rejection: true
agent_b message            : " ! [rejected]        HEAD -> main (fetch first)"
server head is winner      : true
verdict                    : acceptable: no undetectable write loss
```

Artifacts enforces standard git fast-forward semantics. The second push is
refused, the refusing client is informed, and server head is the winner's commit.
No write was silently dropped.

This is the most useful finding for the entry's argument. **The platform supplies
the consequence; Ingress supplies the coordination.** A rejected push is a hard,
observable, attributable failure that an agent can be made to handle deliberately
— declare intent, re-read, reconcile — instead of discovering later that it
worked from a stale version. Admission is not a substitute for fast-forward
enforcement. It is what turns enforcement from a lost write into a decision.

## Measured: event truncation above exactly 20 commits

Bisected 1, 5, 6, 8, 10, 12, 15, 20, 21, 22, 23, 24 and 25 commits. Every push of
**20 or fewer** commits arrived complete and exact. Every push of **21 or more**
arrived truncated, identically:

| Pushed | `totalCommitsCount` | Commits in array | `commitsTruncated` |
| --- | --- | --- | --- |
| 20 | 20 | 20 | false |
| 21 | **21** | **20** | true |
| 22 | 21 | 20 | true |
| 23 | 21 | 20 | true |
| 24 | 21 | 20 | true |
| 25 | 21 | 20 | true |

The hard limit is 20 commits in the array. Past it the payload saturates and stops
responding to what was actually pushed.

This is worse than a simple truncation, and the 21-commit row is the trap:

- At **21 pushed**, `totalCommitsCount` reports **21** — matching what was pushed,
  so the field reads as a complete, trustworthy count. The array holds **20**. A
  consumer that compares the array length to the total sees a mismatch, but a
  consumer that trusts `totalCommitsCount` alone concludes it received everything
  and missed one commit without any signal.
- At **22 or more pushed**, `totalCommitsCount` is **21**, which no longer equals
  what was pushed. The field under-reports the gap by an amount that grows with
  the push, so it cannot be used to size how much was missed.

The consequences are direct. The event is not a complete history above 20
commits, and its own count field cannot be used to detect or quantify that.
Coverage must be reconciled against `logs get`, or recorded as incomplete by
name. It must not be inferred from `commitsTruncated` alone, because that flag
fires one commit too late to be sufficient.

## What this does not establish

- Not tested: a deployed Worker, a Durable Object, or a Workers queue consumer.
  Every read and write above went through `cf` and local git. Step 2 of the plan
  is untouched.
- Not tested: `fork()` from the Workers binding, which is the only way found to
  name a fork.
- Not tested: behaviour in other jurisdictions. The spike namespace is
  `unrestricted`; `us` and `eu` were not exercised.
- Not tested: `commitsTruncated` recovery. Whether the omitted commits are
  reachable via `logs get` is unverified, and it now matters more than it did,
  since the omitted commits can be many and are not counted.
- Not tested: rate limits. The documented ceiling is 2,000 requests per 10
  seconds per artifact, which the tree-walk could approach on a large repo if
  uncached.
- Not tested: ArtifactFS, which mounts a blobless clone over FUSE and hydrates on
  read. Relevant to the local substrate but unused here.

## Effect on the plan

Step 1 is complete and its failure mode did not fire. Two refinements follow:

1. Step 3 gains a required component: **a tree-walk diff with its own
   falsification test** against `git diff --name-status`, plus explicit coverage
   handling for truncated events. The observation substrate is not free. The
   coverage rule has to be stated as "reconcile against `logs get`, or record
   incomplete by name" — deriving completeness from `commitsTruncated` or
   `totalCommitsCount` is demonstrably wrong at 21 commits.
2. Step 4 is better supported than planned. Because Artifacts refuses
   non-fast-forward pushes and tells the client, cross-host resumption has a
   concrete failure to recover from rather than a hypothetical one.

The fallback recorded in the plan — a Durable-Object-backed local substrate if
Artifacts misbehaves — is not needed. Artifacts works.