# Roster preflight

**Date:** 2026-10-01. **Status:** implemented. `src/roster-preflight.mjs`, tested by
`test/roster-preflight.test.mjs` (11 tests, all passing). It gates roster
construction, not agent behaviour, so it advances no RT status and changes no
recorded result.

## The failure it exists to catch

A recorded 17-agent run over 8 workstreams assigned 8 actors work and gave 9 of
them none. `configureMission` slices workstreams by
`perActor = workstreams.length / agentCount`, and at 0.47 per actor every second
slice is empty:

```
builder-1  streams=0  []
builder-3  streams=1  ["outputs/evidence.json","outputs/report.md"]
builder-4  streams=0  []
...
builder-17 streams=1  ["outputs/report.md","outputs/report.md"]
```

Nine actors ran for the full budget with no declared workstream and produced
nothing. The recorded outcome was 8 successes and 9 deadline_or_cancelled. This
was read, incorrectly at first, as evidence that coordination was wasteful. It
was not: coordination was never the variable. The roster was larger than the work
could be divided into, and that is a property of the task rather than of the
agents.

## Two assertions

**Every actor receives at least one workstream.** An unscoped actor is a budget
spent with nothing declared to do. This is detectable before any model call.

**No two actors' declared paths overlap, unless the overlap is declared.** Across
the 8 workstreams of the recorded mission there are only 4 distinct path sets,
and `outputs/report.md` is claimed by four of them. A claim that names an actor
is only checkable if something belongs to that actor alone, so undeclared overlap
makes per-actor verification meaningless rather than merely imprecise.

Overlap is permitted when declared. Three of the six real missions are fully
disjoint; three share output paths intentionally, and the honest response to that
is to declare the sharing rather than to have the gate pretend it does not exist.

## Why a verdict and not a count

`preflightRoster` returns `admit` or `refuse`, names every offending actor and
path, and reports the arithmetic that produced the split:

```js
{ roster: 17, workstreamCount: 8, assignedActors: 8,
  unscopedActors: ['builder-1','builder-2','builder-4','builder-6','builder-8',
                   'builder-10','builder-12','builder-14','builder-16'],
  undeclaredOverlap: [],
  coverage: { complete: false, reason: 'roster_exceeds_decomposable_workstreams' },
  verdict: 'refuse',
  assignment: { perActor: 0.47058823529411764, dividesEvenly: false } }
```

An empty roster, a non-integer or zero `workstreamCount`, a task without an id and
a non-array `declaredOverlap` all throw. Unresolvable input is an error, never a
pass — the failure recorded against four gates in the sibling repository that
scanned a path which did not exist and reported `0`.

## Falsification

Every assertion has a planted violation that must turn it red.

| Assertion | Planted violation | Result |
| --- | --- | --- |
| Every actor scoped | real 17-over-8 configuration | refuses, names all 9 |
| No undeclared overlap | second owner introduced on a single-owner path in `exact-circulation` | refuses, names both owners |
| Declaring overlap admits | all overlapping paths declared | admits, `undeclaredOverlap` empty |
| Pre-declaring does not grant a blanket pass | overlap introduced after declaring others | still refuses |
| Gate can go red | every workstream stripped from every actor | refuses with 0 assigned |
| Errors are not passes | empty roster, zero/ fractional count, task without id, non-array overlap | throws |

Two of these were written wrongly on the first attempt and corrected rather than
relaxed. A test expected the real fixtures to be admitted; the gate refused them
because `outputs/report.md` genuinely is shared by all eight actors, which was the
finding. A second test declared one path and expected admission, but the fixture
had other undeclared overlaps, so it stayed red for the right reason.

## Limits

- **It is a gate on declared scope, not on observed behaviour.** An agent that
  edits a file outside its declared scope is not caught here.
- **It cannot judge whether declared scope is good work.** Only that it is scoped
  and not silently contended.
- **Three of six missions would be refused as written** and need their shared
  output paths declared. That is a finding about the fixtures, not a regression,
  and the study configuration at 8 actors continues to scope every actor.

## What it does not claim

It does not make agents faster, and it does not establish that coordination is or
is not worthwhile. It refuses rosters that cannot be decomposed, which is a
different and smaller claim. The measured coordination token cost from
[Gate 0](claim-protocol.md) stands independently; what is withdrawn is the causal
reading of the 8-of-17 result.