# Varied DeepSeek V4.1 checkout results

The varied native study completed all **27 assigned cohorts and 108 actors** using
`opencode/deepseek-v4.1-flash`. Current product rules produced **3/9 correct missions**,
block grants **1/9**, and graph grants **2/9**. Graph required substantially more native
turns and reported cost. This study does not establish an overall improvement from
dependency checkout exclusion and does not qualify RT-1.

The three synthetic workflows each ran three repeats per arm, with four concurrent
private-copy actors, rotating acquisition/arm order, three native turns per actor and a
ten-minute cohort deadline. Tasks, seed transformations, tool permissions, legacy
validation and held acceptance criteria were matched across arms. See the
[frozen protocol](checkout-varied-protocol.md).

| Arm | Correct within budget | Median settlement | Native turns | Published actors | Reported cost for nine cohorts |
| --- | ---: | ---: | ---: | ---: | ---: |
| Current product rules | 3/9 | 120.4 s | 36 | 35/36 | $0.6233 |
| Block grants | 1/9 | 119.6 s | 40 | 35/36 | $0.7223 |
| Graph grants | 2/9 | 221.4 s | 73 | 30/36 | $0.9465 |

All six correct final artifacts also met the within-budget definition. Settlement
includes setup, producer/validation work, publication, intermediate grading and confirmed
stop; it excludes final post-stop grading. Its median includes incorrect missions and
is not a time-to-correctness estimate. First observed correctness was 119.3 and 123.2
seconds for current tax/stock, 265.6 seconds for current ledger, 85.9 seconds for block
tax/stock, and 228.2 and 217.2 seconds for graph tax/stock. Successful missions differ
across arms, so these times do not establish a general speed advantage.

## Mission outcomes

| Workflow | Current | Blocks | Graph |
| --- | ---: | ---: | ---: |
| Tax and partial stock | 2/3 | 1/3 | 2/3 |
| Refund ledger | 1/3 | 0/3 | 0/3 |
| Compiled policy snapshots | 0/3 | 0/3 | 0/3 |

Every final tree passed the public legacy checks and executed successfully under the
bounded grader. Only six passed all new held acceptance groups. All actors published
in five incorrect current cohorts, seven incorrect block cohorts and two incorrect
graph cohorts. Publication and native model success therefore remain separate from
whole-mission correctness.

Tax/stock failures included missing-stock handling and incomplete reporting. Ledger
failures included payment identity, refund-ID conflicts, overdraw and incomplete workflow
integration. These behavior failures occurred alongside distinct runtime and scope
failures; they are not all evidence of dependency interference.

Graph final-turn decisions recorded 21 changed-base refusals, 16 unresolved-dependency
refusals and one outside-scope refusal. Its seven explicit expansion attempts admitted
six; blocks admitted two of six attempts. These counts separate final turn decisions
from expansion-stage receipts, avoiding counting a refusal twice. Graph aggregate actor
waiting was 1,119.3 seconds, overlapping across actors rather than adding to cohort
elapsed time. Ordinary receiver/callback calls still exceed the bounded producer's
coverage; those refusals remain in the denominators.

Five native-wait `TimeoutError` outcomes occurred: one current, one block and three
graph actors. Some native sessions later recorded success, but the runner did not collect
and publish their work. They remain transport/observation failures, not successful
missions or dependency-policy refusals. The first graph ledger cohort reached its
deadline with integration unfinished. The first graph policy pricing actor had a native
`provider.transport` failure and did not publish. No selective rerun, model fallback,
held-check feedback or manual rescue changed those outcomes.

## Completed consumers can become stale

The policy mission deliberately compiles issued policy values into archival literals;
a fresh perturbed import checks that these are snapshots rather than runtime reads.
All current/block consumers retained the old issued values. Graph refreshed some later
consumers, but exclusion of active grants did not keep already-published consumers current.

In graph repeat two, pricing published before the policy changed. The provider then
published its update; fulfillment and report refreshed and passed, while completed
pricing remained stale. In repeat three, fulfillment and report published before the
provider; later pricing refreshed, while those completed consumers remained stale.
All four actors published in both cohorts. This reproduces the completed-consumer failure
from the [deterministic study](checkout-expansion-results.md) with actual native edits.
The first graph policy cohort is separately confounded by its pricing provider failure.

The next mechanism to qualify is validation tied to source/dependency versions, plus
invalidation and regeneration or revalidation of completed dependents when a provider
changes. Cheap immutable proposals should remain available even when they are not
approved. The [source-control design input](checkout-arbiter-prototype.md#source-control-design-input-2026-10-13)
records how this relates to Anthropic's article. No such mechanism was added during this
study, and it needs independent counterexamples and a fresh comparative protocol.

## Retained execution and audit

The original execution in `artifacts/checkout-varied-deepseek41-v1` completed 15 cohorts.
A chat interruption stopped the runner while preparing the next cohort. Its four
allocated sessions had no observed messages/tokens/cost, all private copies matched the
seed, and no owned runtime remained. That setup interruption stays recorded separately
in `interruption.json`; no correctness or model outcome is imputed to those sessions.

`artifacts/checkout-varied-deepseek41-v2` continued only the 12 assignments without
observed native admission, after a new two-actor preflight. All 15 completed outcomes,
including failures and the deadline, remained fixed. The operational driver change
only selected pending assignments and recorded provenance. Controls, mission/model
metadata, assignment order and the other 43 original implementation hashes matched.
The original 44 implementation snapshots and all 45 continuation snapshots verified;
all 45 continuation runtime hashes still matched at completion. These fingerprints
cover the declared runtime files, not every transitive library or host component.

`scripts/checkout/analyze-varied.mjs` verifies that the two executions retain each of
the original 27 assignments exactly once, with unchanged role order and confirmed stop.
It verifies protocol/source/contract snapshots, continuation provenance and scores,
then writes `artifacts/checkout-varied-deepseek41-v2/analysis.json`. Every cohort's final
tree, held-check results, candidates, grants/decisions and sanitized native metadata
remain under its respective run directory. The earlier single-mission and model-free
studies are not pooled into these counts.

Both preflights passed and stopped; their four sessions reported $0.004234488 separately.
All 27 cohorts confirmed stop, and no owned runner/server remained after completion.
Native execution peak was four in every cohort: concurrent private preparation, not four
simultaneous authorized graph publications. Final database totals identified the exact
requested model in all 108 comparative sessions. Cost metadata was available for all;
it is provider reported rather than reconciled billing. Live closed-step usage and
cumulative database totals are separate sources and are not added together. One current
session's final native outcome was unknown despite available usage totals.

All streams reported live-only coverage, with no recorded sequence gaps, omissions or
missing closed-step usage/cost. This cannot prove every upstream event was exposed.
Grant auditing retains initial metadata and decisions but aggregates waiting polls.
Delivery of refreshed source is distinct from adaptation; the policy checks establish
particular changed outputs, not general comprehension or complete dependency coverage.

The full Node 26 suite passed **879/879** before continuation, including four new
model-free continuation regressions. The original admission had passed 875/875.
These tests require neither Stow nor OpenCode. Only the verified synthetic lab source,
public tests and directives entered native copies; product and held-grader code remained
local. Credentials, raw provider context and generated model prose were not copied into
the report. Saved model settings and deployed product code did not change.

Three repeats of three small synthetic workflows on one model/host do not establish
repository-scale productivity. The ledger seed transform and artificial archival policy
workflow limit generalization. Execution across an interruption also changes calendar
conditions between repeats. Local trusted identity/clock and memory state do not qualify
authenticated durable isolation or arbitrary JavaScript impact analysis.

```sh
node scripts/checkout/analyze-varied.mjs \
  --parent=artifacts/checkout-varied-deepseek41-v1 \
  --continuation=artifacts/checkout-varied-deepseek41-v2 \
  --output=artifacts/checkout-varied-deepseek41-v2/analysis.json
```
