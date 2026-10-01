# Claim records: coordination without conversation

**Date:** 2026-10-01. **Status:** proposed. Nothing here is built, and no existing
RT status changes. This replaces the standing assumption that coordination happens
through agent-to-agent messages.

It depends on the [Artifacts spike](artifacts-spike-report.md) for two measured
facts: a push that resolves a divergence is accepted, and a pushed event arrives in
162–277 ms with the `before`/`after` commits needed to verify a read basis.

## The problem

Agent-to-agent conversation is the current coordination mechanism and it is
expensive and unreliable in the same way. Each exchange costs two model turns with
full system prompts and tool schemas. It requires the peer to be awake and to
receive the message at a useful moment. It can deadlock on one agent waiting and
the other proceeding. And it fails silently when a message arrives after the
decision it should have informed.

The existing code already treats conversation as a cost to be bounded rather than a
capability to be relied on: `NotificationPolicy` caps notices at three per actor
with two seconds of coalescing, and context assembly is capped at 32 KiB with
declared truncation.

The measured result is consistent with that. The eight-agent run produced eight
correct artifacts out of nine and completed zero of nine inside the 90-second
budget. Coordination did not fail loudly. It consumed the budget.

## The proposal

Replace conversation with a record an agent reads instead of a message it receives.

The record is not new. `WorkspaceState.joinFile()` already returns exactly this
payload today:

```js
{ type: 'file.joined', epoch, throughSequence, path,
  documentRevision,                              // the read basis
  participants: [{ id, sessionID, generation, status, task,
                   intention: { …, expiresAt },   // declared intent
                   lastLocation: { path, revision, stale } }],
  self, coverage }
```

Someone wrote the claim file. It is in memory, so it dies with the process, and it
is invisible to an agent working through native file tools. The proposal is to
materialize it in Artifacts, where it is durable, diffable, event-emitting, and on
the path an agent already reads.

## Why this is not the claim model that was ruled out

File claims were excluded because RT-0 is an observer and cannot intercept a native
`write`. Advertising protection that cannot be enforced is an unfalsifiable claim,
and the project's gate rules exist to refuse exactly that.

A claim record does not claim protection, and does not need to. It places the
situation **on the read path**: an agent that opens a file covered by an open claim
learns what is happening before it can act on stale bytes. That is a chokepoint at
the only point where a native harness can actually be influenced. It constrains by
being unavoidable, not by blocking.

The distinction is worth keeping sharp. A claim record is not a lock. An agent that
ignores it corrupts the branch exactly as it does today.

## Two layers, because one does not work

**A claim requires a commit, which requires a push, which is the thing being
sequenced.** If claim records live in the working tree, claim traffic contends with
code traffic and agent A's claim can be rejected by agent B's edit. That is a worse
failure than the one being removed.

So the claim splits:

| Layer | Carrier | Carries |
| --- | --- | --- |
| Atomic claim | a branch, `job/<id>` | the reservation. Durable, ordered, mergeable, no lock protocol |
| Explanation | a record on a dedicated claim ref | who, from which revision, doing what, until when |

Claim records never touch the working branch. Code commits never block on claim
traffic. A rejected claim write is retried, and because a claim is advisory the retry
is cheap.

**"Leave a claim in place of the file, replace it when done" therefore lives in the
protocol, not the filesystem.** The read step fetches the claim ref and resolves
coverage before code is read. The working tree is never mutated to carry claims, so
an agent never has to unpick someone else's claim out of the file it is trying to
edit.

## Claim record

```json
{
  "kind": "ingress.claim",
  "version": 1,
  "path": "src/validation.js",
  "claimant": { "sessionID": "…", "participantID": "…", "generation": 3 },
  "basis":   { "revision": "<commit sha>", "confidence": "verified" },
  "intent":  { "summary": "changing validation for empty names",
               "declaredAt": "…", "expiresAt": "…" },
  "scope":   { "ranges": [] },
  "state":   "open",
  "closed":  null
}
```

Three fields carry the weight.

`basis.revision` is the commit the claim was formed against, so "this agent read the
current version" becomes checkable rather than asserted. `basis.confidence` reuses
the existing `verified | temporal | unknown` vocabulary: an agent that joined without
a current revision must say `temporal` or `unknown` and cannot pass itself off as
verified.

`intent.expiresAt` reuses the existing five-minute intention TTL. A claim that
outlives its intent is stale, and staleness is detectable rather than assumed.

Closure is the part that has to be earned, because **absence is not evidence.** A
missing claim cannot distinguish finished from crashed mid-edit from never started.

```json
"state": "closed",
"closed": { "at": "…", "branch": "job/7f3a", "resultCommit": "<commit sha>",
            "verification": { "ran": ["npm test"], "outcome": "pass" } }
```

`resultCommit` is what makes "done" falsifiable. A claim closes against a commit that
exists and can be inspected, not against a silence.

## Protocol

On picking up work on path `P`:

1. Fetch the claim ref. Resolve coverage for `P`.
2. If an open, unexpired claim covers `P`, read it. Decide: yield, or proceed and
   resolve by merge.
3. If a closed claim covers `P`, take its `resultCommit` as part of your own
   `basis.revision`.
4. If no claim covers `P`, proceed normally.
5. Declare your own claim before writing, naming the revision you based it on.

On pushing a change to `P`:

1. You must hold an open, unexpired claim for `P`.
2. Your `basis.revision` must be an ancestor of the head you merged against.
3. If another open claim overlaps yours, resolve by merge rather than by failing.
   The spike confirms Artifacts accepts a push whose history carries the server head
   as a parent.

Step 3 is why this composes with the merge behaviour rather than competing with it.
The claim prevents *avoidable* collision. The merge handles the rest without failing.

## What this does not do

**It does not provide semantic safety.** A 3-way merge succeeding means the bytes
combine. Two agents can each write a plausible, internally consistent, mutually
contradictory version of a validator; the merge is clean and the program is wrong.
Text convergence and behavioural correctness remain separate checks.

**It does not prevent.** An agent that never reads the claim ref behaves exactly as
it does today. The protocol is only as strong as the read step that adopts it.

**It does not record the change.** A claim records intent. Whether the resulting
commit did what the intent said is a separate question, answered by verification,
not by the claim.

**It does not make agents faster.** It removes coordination dialogue from the budget.
Whether that produces faster completion is not assumed, and is measured rather than
claimed.

## Falsification

Gate 0 comes first because it can kill the whole idea cheaply.

| # | Gate | Assertion | Falsification test |
| --- | --- | --- | --- |
| 0 | Coordination is actually expensive today | conversation consumes a material share of total tokens in the existing harness | **run — premise holds from roster 4 upward, and fails at roster 2. See below** |
| 0 | Coordination is actually expensive today | conversation consumes a material share of total tokens in the existing harness | instrument `runRealSquad`; if coordination is a small share of total tokens, the premise is false and this stops |
| 1 | Every push to a claimed path had an open claim | 0 violations | push to `P` with no claim; the gate must go red |
| 2 | No claim acted on a stale basis | 0 violations | claim naming a revision that is not an ancestor of the merged head; red |
| 3 | No two open claims overlap a range | 0 violations | two overlapping open claims; red |
| 4 | Claims close only against a real commit | 0 violations | close with `resultCommit` absent or unresolvable; red |
| 5 | Expired claims are detectable | expired claims never read as open | plant a claim past `expiresAt`; red |
| 6 | A claim read costs less than the conversation it replaces | measured, ratio reported | if a claim read costs more than the equivalent conversation, the trade is wrong |

Gate 0 matters because the entire argument is a cost argument. If the existing
conversation overhead turns out to be a few percent of tokens, this is a large amount
of new machinery for nothing, and the honest move is to stop.

## Gate 0 result

**Run 2026-10-01. Premise holds from roster 4 upward and fails at roster 2.**

Method: the repository's own `assembleAgentContext` and `renderAgentContext`, at
rosters of 2 to 32 with every peer in the same file, live intentions and an observed
read basis on each agent. Token counts are real, from `gpt-tokenizer`'s `encode`, not
estimated. Baseline is the recorded 162-cohort native run in
[benchmark-results.md](benchmark-results.md): 1,867 closed steps, 8,090,086 input
tokens, which is **4,333 input tokens per step** and 22,725 per actor. That run
already recorded treated pairs at **2.9× stock input on Nano and 7.4× on DeepSeek**,
so a coordination premium is established; what follows decomposes it.

The comparison had to be corrected once. Measuring the whole rendered context against
a claim record gave a tidy 10× at roster 8, but that was dishonest: the context also
carries assigned task, observed files, read basis and the coverage/uncertainty honesty
fields, which a claim record would not replace and which are required whether or not
claims exist. Those are separated below.

| Roster | Peers in room | Total context | Replaceable (peers) | Retained floor | vs claim record | Replaceable as share of one step |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | 1 | 695 | 142 | 451 | **0.9×** | 3.3% |
| 4 | 3 | 978 | 420 | 456 | 2.7× | 9.7% |
| 8 | 7 | 1,537 | 976 | 459 | 6.3× | 22.5% |
| 16 | 15 | 2,644 | 2,088 | 454 | 13.6× | 48.2% |
| 32 | 31 | 4,874 | 4,312 | 460 | **28×** | 99.5% |

Tokens. A claim record as specified above is **154 tokens / 417 bytes**. The retained
floor is flat at ~451 tokens plus a 58-token preamble, plus a 44-token constant from
JSON structure that the per-section sums do not capture.

Three things follow, and the first is a negative result.

**Awareness costs about 139 tokens per co-located peer, and grows linearly.** At 32
peers in one room, awareness alone costs 4,312 tokens — a whole model step's input —
and the premium is entirely O(peers). The retained floor does not move with roster.

**A claim record is O(1) in peers and O(k) in open claims on one path.** Typically k is
zero or one even at 32 agents, because agents work different files. So the saving
scales with roster times co-location, and is unbounded in the limit. This is the
structural argument, and the ratio above only understates it at large rosters.

**At roster 2 the trade is a loss.** A claim record costs 154 tokens against 142 for
the awareness it would replace. Two-agent work is most of the recorded benchmark data,
and there is no token argument for claims at that size. The honest position is that
claims earn their cost at roster 4 and above, and that a two-agent pilot would need a
different justification than cost.

The 139-token-per-peer figure also explains the recorded result more precisely than
"conversation is expensive" does. The multiplier is not primarily dialogue — it is a
whole-context envelope refreshed at every model-request boundary, and awareness is
what fills it. So the addressable cost is the awareness section specifically, which is
what this table isolates.

### What Gate 0 does not establish

It prices the coordination signal. It says nothing about whether a 154-token claim
record is *adequate* for an agent to make the same decision the 976-token peer section
supported. A claim is narrower than a peer snapshot: it carries claimant, basis
revision, intent, expiry and scope, but not peer task detail or observed cursor
position. Cheaper and less informative are separable properties, and adequacy is
untested. Gates 1 through 3 are where that would fail, and they should be run at
roster 8 where the cost argument actually holds.

Reproducing this needs `gpt-tokenizer`, which the repository does not depend on. The
measurement was run from a scratch directory rather than adding a dependency for a
one-off, and no tokenizer approximation is used anywhere in the numbers above.

## Relationship to the existing plan

The out-of-scope line currently reads "File claims, exclusive ownership, or refusing
native writes." That must be amended carefully rather than deleted. **Exclusive
ownership and refusing native writes remain out of scope.** What enters is a
non-exclusive claim that is materialized, durable, evidenced, and placed on the read
path. It is not a lock and does not claim to be.

Two delivery steps change:

- **Step 3** gains a second source. The claim ref is as much an observation input as
  the pushed event is, and it arrives by fetch rather than by event.
- **Step 4** changes target. Cross-host resumption no longer recovers from a rejected
  push; it recovers an open claim, its basis, and its branch, and continues from
  there. That is a cleaner recovery story than the one previously planned, because the
  interrupted agent left a durable record of what it intended and what it had read.

## Unresolved

**What "spin up a new instance" means.** If it means a new workspace or branch per
job, that is caller-owned execution and [ADR 0014](reference/stow-storage-boundary.md)
is satisfied. If it means a Container, it crosses the boundary ADR 0014 and
[ADR 0017](reference/stow-source-record.md) drew, where a Durable Object holds
identity, state, policy and lifecycle and a container supplies only environment. The
proposal is written on the first reading. The second needs rejecting explicitly.

**Which ref carries claims.** A single shared claim ref serialises all claim traffic.
Per-namespace or per-path shards avoid contention but multiply the fetches an agent
must make before reading code. The tradeoff is unmeasured.

**Whether the read step can be made unavoidable.** Everything above assumes an agent
reads the claim ref before it reads code. If a harness can be pointed straight at a
working tree, the chokepoint is advisory and the design weakens to "a nice convention".
Whether that can be closed is the open implementation question, and it decides whether
this is a protocol or a suggestion.