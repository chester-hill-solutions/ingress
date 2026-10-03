# Synthetic overseer: a stand-in operator, and what it is not

**Date:** 2026-10-02. **Status:** implemented and tested. No RT status advances.
Establishes that an overseer arm can run without a person present. Establishes
nothing about whether a person would do the same thing.

## The problem it solves

The [test campaign plan](test-campaign-plan.md) §4 specifies an overseer arm: a
human watching agents work land, noticing problems, and adjusting mid-flight.
That arm has a scheduling problem. Stage E needs someone present for hours,
deciding in real time, and that is not a resource this project can assume.

Building the arm anyway, so the non-human parts can be exercised, and swapping a
real overseer in later, is better than leaving the arm unbuilt. A harness that
only works with a human available is a harness that gets skipped.

## The one thing that matters most

**This is not a human, and it never claims to be.** Every record it produces —
proposals, journal entries, evidence folds, HTTP responses — carries:

```
syntheticOverseer: true
humanOversight: false
```

That is deliberate and it is tested. A test campaign whose overseer arm quietly
reports a policy as a person would make every number it produces worthless, and
the failure would be invisible: the runs would look *better*, not worse. The
field is the guard against that.

Five tests assert it across every arm and both surfaces. Flipping
`humanOversight` to `true` anywhere in the two source modules fails 5 of 25
tests.

## The authority boundary

The policy proposes; the control surface decides. Nothing the policy wants
happens because the policy wanted it.

`src/overseer-control.mjs` checks each proposal against what the run actually
granted, and records what it did:

| Refusal | Why it exists |
| --- | --- |
| `unknown_action` | Only `note/admit/defer/steer/cancel/induce` exist. Outcomes and verdicts are not actions. |
| `actor_not_live` | A settled actor cannot be steered. Sending anyway would be theatre. |
| `empty_text` | A steer with no text is a no-op presented as an intervention. |
| `fault_not_supported` | The harness has no fault inducer, so the request is meaningless. |
| `budget_exhausted` | Spending is bounded, and the exhaustion is recorded rather than hidden. |

Three properties hold regardless of what is proposed:

- **Outcomes cannot be rewritten.** A steer is accepted or refused on its own
  merits; extra `outcome`/`correct` fields do not survive into the record. The
  entry is built from a fixed field list, so an unrecognised key cannot ride
  along. Verified by mutation: copying those fields through fails the test.
- **Verification cannot be altered.** Checks run in a child process; nothing
  reaching this surface can reach them.
- **`automaticChangeMessages: 0`.** The invariant `repair-game.mjs` established
  for a human-directed repair run. An overseer-influenced run schedules no
  follow-up work and starts no agent, so influence stays attributable.

Refusals are first-class records. A policy refused often is learning its own
limits, and that is worth keeping rather than swallowing.

## The four arms

Each is a different question, not a different dial.

| Arm | Question it answers |
| --- | --- |
| `shadow` | What would a person notice that the automatic policy did not flag? |
| `reactive` | Does confirming or deferring on an existing signal change anything? |
| `proactive` | Does acting ahead of the policy, from the dependency graph, help? |
| `adversarial` | Can the harness recover from a fault someone asked it to have? |

`shadow` is the measurement arm and the one worth running first. Its output is
`attention`: dependency changes after a read that `NotificationPolicy` never
fired on. If that set is empty across runs, the automatic policy is already
covering what a person would look at, and the honest conclusion is that a human
adds nothing on these runs. If it is non-empty, the policy has a gap worth
naming. Neither answer is available without this arm.

## Two test beds

**Local** — `createSyntheticOverseer` plus `createOverseerControl` in-process.
No sockets. For unit work and for embedding in a deterministic run.

**Separate** — `startOverseerServer` plus `createOverseerClient` over loopback.
Security posture copied from `blind-review.mjs`, the existing precedent for a
loopback service that accepts outside influence: bound to `127.0.0.1` only,
`Host` pinned to the bound port, `Origin` required and matched on every
mutation, `application/json` required, body bounded to 8 KiB, per-server CSP
nonce, `no-store` and `nosniff` throughout.

Why the separate bed matters: a policy invoked in-process cannot drift from the
thing it observes. Going over a socket puts it under the same latency and
visibility constraints a person would be, which is the point of measuring one.
The same endpoints serve a synthetic policy and a real person, so a run can hand
over mid-flight without changing the harness — and because the server only
relays, it cannot honestly claim either. That is why `humanOversight` is never
set there.

## Honesty constraints carried in the code

1. **The policy reads a deliberately narrow view.** Participants, declared
   dependencies, observed revisions, shared rooms, and which notices already
   fired. It does not read model prose, native transcripts, or verification
   verdicts. A synthetic operator reasoning over the answer key is grading its
   own homework.
2. **Proposals are not actions.** See the authority boundary above.
3. **Reproducible, and therefore weak evidence.** Same view + arm + seed gives
   the same proposals. That is what makes a bug findable, and it is also why the
   result says nothing about human attention or judgement.
4. **Delivery failure is distinguished from decision failure.** An accepted
   proposal whose delivery throws is recorded as `accepted` with
   `delivery.status: 'failed'`. Collapsing those would make a broken steer look
   like a working one.

## First result: replaying both recorded runs

`scripts/overseer-replay.mjs` replays recorded squad evidence through the policy.
No agents run, no model is called, no account is touched.

```sh
node scripts/overseer-replay.mjs --evidence artifacts/<id>/squad-evidence.json --arm shadow
```

**The automatic notification policy missed real staleness in both recorded runs.**

| Run | Actors | Unflagged stalenesses | Longest-lived |
| --- | --- | --- | --- |
| `d0c8d82f` 5-agent | 5 | **4** | `ui <- engine.mjs`, 30 ticks over 76s |
| `74d285d5` 16-builder | 17 | **3** | `server-support <- public/index.html`, 121 ticks |

Detail from the 16-builder run:

```
server-support <- public/index.html    (read at revision 18, now 19)  121 ticks
ui-shell       <- public/itinerary.mjs (read at revision 4,  now 8)    64 ticks
ui-shell       <- public/atlas.mjs     (read at revision 2,  now 11)   21 ticks
```

The 16-builder run passed 58/58 independent checks and produced a playable game,
so these are not failures. They are cases where an agent worked from a
dependency that had moved underneath it and the artifact came out correct anyway.
That is precisely the population the claim protocol is about, and it says the
notification policy is not covering every case the harness can observe.

**This does not show a human would have caught them.** It shows the information
was available and unflagged. A person watching `public/index.html` change 121
times might well have ignored it.

## Two bugs this replay found in itself

Both were caught by distrusting a clean result, which is the only reason they
were caught.

**1. `affinityFiles` used as dependencies.** The first replay reported 532
findings with `integration` (which ran *after* all builders) as the largest
reporter. `affinityFiles` is an actor's own output, not its dependencies, so
every actor appeared to depend on the file it was writing and every write looked
like a stale read. Fixed to read `state.participants[].dependencies`.

**2. Read revision overwritten with file revision.** After fix 1 the replay
reported **0** findings on both runs — which was wrong. A one-line
"convenience" mapped each read onto the file's *current* revision, replacing
"read at r1" with "read at r11" and erasing the staleness by construction:

```js
// WRONG: made every staleness vanish
.map(read => ({ path: read.path, revision: fileRevisions.get(read.path) ?? read.revision }))
// RIGHT: the read's revision is when the reader saw the bytes
.map(read => ({ path: read.path, revision: read.revision }))
```

An independent check over the raw evidence found 11 ticks of genuine staleness
where the replay found none. After the fix the two agree at 4 distinct
stalenesses.

A zero from this replay is therefore not self-evident, which is why it now prints
a denominator — dependency edges, reads with revisions, files changed, notices
recorded — so a clean result is readable rather than merely reported.

## Limits, in the evidence and not only here

```
canSupport:    whether a proposed intervention changed an outcome under this policy
cannotSupport: whether a human overseer would notice, choose, or recover the same way
```

A synthetic overseer is evidence about the harness. Never about a person.

## State

25 tests, all passing. Full suite 305 tests, 0 failures on Node 26.

Verified by four mutations, each of which fails its intended test:

| Mutation | Test that catches it |
| --- | --- |
| `humanOversight: false` → `true` | 5 tests across every arm |
| shadow arm steers instead of noting | shadow-arm guard |
| entry copies `outcome`/`correct` through | outcome/verification guard |
| budget check deleted | budget-exhaustion guard |

Not wired into a live harness yet. That is [build item 2 and 3 in the
campaign plan](test-campaign-plan.md) §6: the admission scheduler and the
overseer arm both need this surface, and wiring it into `runRealSquad` is a
separate change.